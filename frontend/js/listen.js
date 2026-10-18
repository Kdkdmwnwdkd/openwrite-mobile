/**
 * OpenWrite Mobile - 听稿校对（listen.js）
 * ------------------------------------------------------------------
 * 校对靠耳朵：眼睛会自动跳过熟句，耳朵不会。所以这里不是"朗读器"，
 * 而是"逐句跟读"——读一句、亮一句，眼睛跟着高亮走，错字和重复词会跳出来。
 *
 * 引擎用系统自带的 speechSynthesis：
 *   - 零成本、不联网、不需要 Key（符合本项目本地优先的定位）
 *   - 真机上音色取决于系统 TTS 引擎；没有中文音色时给出明确提示
 *   - 安卓 WebView 的 onend 有概率不触发，所以每句都挂一个超时兜底
 */

const listenState = {
    novelId: null,
    chapterNum: 1,
    sentences: [],
    idx: 0,
    playing: false,
    rate: 1,
    autoNext: false,
    token: 0,        // 每次 speak/cancel 递增，用来丢弃过期回调
    watchdog: null,
    voice: null,
    autoplay: false
};

const LISTEN_RATES = [0.8, 1, 1.2, 1.5, 1.8];
const REPEAT_RE = /(的的|了了|是是|在在|我我|他他|她她|它它|你你|就就|不不|要要|和和|地地|得得)/g;

function listenSupported() {
    return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

function listenPickVoice() {
    try {
        const vs = window.speechSynthesis.getVoices() || [];
        return vs.find(v => /^zh[-_]CN/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null;
    } catch (e) { return null; }
}

// 按句末标点切句，保留标点；过长的句子再按逗号切，避免单条 utterance 太长被引擎截断
function listenSplitSentences(text) {
    const clean = String(text || '').replace(/\r/g, '');
    if (!clean.trim()) return [];

    const rough = [];
    const re = /[^。！？!?…\n]+[。！？!?…]*[”"』」]?|\n+/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        const s = m[0].trim();
        if (s) rough.push(s);
    }

    const out = [];
    for (const s of rough) {
        if (s.length <= 120) { out.push(s); continue; }
        // 长句按逗号再切，逗号留在句尾
        const parts = s.match(/[^，、；：,;]+[，、；：,;]?/g) || [s];
        let buf = '';
        for (const p of parts) {
            if ((buf + p).length > 120 && buf) { out.push(buf); buf = p; }
            else buf += p;
        }
        if (buf) out.push(buf);
    }
    return out;
}

// ===== 渲染 =====
async function renderListen(container, novelId, chapterNum) {
    if (!novelId || !chapterNum) {
        ui.showToast('请从章节里点「听稿」进入');
        navigateTo('bookshelf');
        return;
    }
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!chapter) { ui.showToast('这一章还没有内容'); navigateTo('novelDetail', { novelId }); return; }

    listenStop();
    listenState.novelId = novelId;
    listenState.chapterNum = chapterNum;
    listenState.sentences = listenSplitSentences(chapter.content || '');
    listenState.playing = false;

    ui.setPageTitle('听稿');
    ui.setHeaderActions(`<button class="header-btn" onclick="leaveListen('${novelId}')">返回</button>`);

    if (!listenState.sentences.length) {
        ui.showEmptyState(container, { icon: '🎧', title: '这一章还没有正文', desc: '先去写点内容再来听' });
        return;
    }

    // 恢复上次听到的句子（同一章才恢复）
    const saved = await settings.get('listenPos', null);
    listenState.idx = (saved && saved.novelId === novelId && saved.chapterNum === chapterNum)
        ? Math.min(saved.idx || 0, listenState.sentences.length - 1) : 0;

    if (!listenSupported()) {
        container.innerHTML = `<div class="ls-empty">
            <div class="ls-empty-title">这台设备不支持语音朗读</div>
            <div class="ls-empty-desc">浏览器没有提供 speechSynthesis。安卓机需要安装「Google 文字转语音」或系统自带的 TTS 引擎。</div>
        </div>`;
        return;
    }

    listenState.voice = listenPickVoice();
    if (!listenState.voice) {
        // 音色列表是异步加载的，等一次再判断
        window.speechSynthesis.onvoiceschanged = () => { listenState.voice = listenPickVoice(); };
    }

    const total = listenState.sentences.length;
    container.innerHTML = `
        <div class="ls-wrap">
            <div class="ls-head">
                <div class="ls-title">第${chapterNum}章 ${escapeHtml((chapter.title || '').replace(/^第\d+章\s*/, ''))}</div>
                <div class="ls-meta"><span id="ls-progress">${listenState.idx + 1} / ${total}</span> 句</div>
            </div>
            <div class="ls-hint">点任意一句从这里开始读。虚线下划线是疑似重复用字，值得看一眼。</div>
            <div class="ls-body" id="ls-body">${listenBodyHtml()}</div>
        </div>
        <div class="ls-bar">
            <button class="ls-btn" onclick="listenPrev()" aria-label="上一句">‹</button>
            <button class="ls-btn ls-main" id="ls-play" onclick="listenToggle()" aria-label="播放">▶</button>
            <button class="ls-btn" onclick="listenNext()" aria-label="下一句">›</button>
            <button class="ls-rate" id="ls-rate" onclick="listenCycleRate()">1.0x</button>
            <button class="ls-auto" id="ls-auto" onclick="listenToggleAuto()">连播</button>
        </div>`;

    listenHighlight(listenState.idx, false);
    bindListenBody();

    if (listenState.autoplay) {
        listenState.autoplay = false;
        setTimeout(() => listenToggle(), 200);
    }
}

function listenBodyHtml() {
    return listenState.sentences.map((s, i) => {
        const safe = escapeHtml(s).replace(/^第\d+章\s*/, '');
        const marked = safe.replace(REPEAT_RE, '<em class="ls-rep">$1</em>');
        return `<span class="ls-sent" data-i="${i}">${marked}</span>`;
    }).join('');
}

function bindListenBody() {
    const body = document.getElementById('ls-body');
    if (!body) return;
    body.addEventListener('click', (e) => {
        const el = e.target.closest('.ls-sent');
        if (!el) return;
        const i = Number(el.dataset.i);
        if (Number.isNaN(i)) return;
        listenState.idx = i;
        listenHighlight(i, false);
        if (listenState.playing) listenSpeakAt(i);
    });
}

function listenHighlight(i, scroll = true) {
    const sents = document.querySelectorAll('.ls-sent');
    sents.forEach(el => el.classList.toggle('ls-current', Number(el.dataset.i) === i));
    const cur = sents[i];
    if (cur && scroll) {
        try { cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { cur.scrollIntoView(); }
    }
    const p = document.getElementById('ls-progress');
    if (p) p.textContent = `${i + 1} / ${listenState.sentences.length}`;
}

// ===== 播放 =====
function listenToggle() {
    if (listenState.playing) listenPause();
    else listenPlay();
}

function listenPlay() {
    if (!listenSupported()) { ui.showToast('这台设备不支持语音朗读'); return; }
    listenState.playing = true;
    updatePlayButton();
    listenSpeakAt(listenState.idx);
    keepScreenAwake(true);
}

function listenPause() {
    // 不用 pause()：安卓上 resume() 经常失效，直接停在当前句更可预期，
    // 继续时重听这一句，对校对反而是好事
    listenState.playing = false;
    listenStopSpeech();
    updatePlayButton();
    keepScreenAwake(false);
    saveListenPos();
}

function updatePlayButton() {
    const btn = document.getElementById('ls-play');
    if (btn) btn.textContent = listenState.playing ? '⏸' : '▶';
}

function listenStopSpeech() {
    listenState.token++;
    if (listenState.watchdog) { clearTimeout(listenState.watchdog); listenState.watchdog = null; }
    try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
}

function listenStop() {
    listenState.playing = false;
    listenStopSpeech();
}

function listenSpeakAt(i) {
    if (!listenState.playing) return;
    if (i < 0) i = 0;
    if (i >= listenState.sentences.length) { listenFinishChapter(); return; }

    listenState.idx = i;
    listenHighlight(i);

    const myToken = ++listenState.token;
    if (listenState.watchdog) clearTimeout(listenState.watchdog);

    const text = listenState.sentences[i];
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = listenState.rate;
    u.pitch = 1;
    if (listenState.voice) u.voice = listenState.voice;

    let done = false;
    const advance = () => {
        if (done || myToken !== listenState.token) return;
        done = true;
        if (listenState.watchdog) { clearTimeout(listenState.watchdog); listenState.watchdog = null; }
        if (!listenState.playing) return;
        saveListenPos();
        listenSpeakAt(i + 1);
    };

    u.onend = advance;
    u.onerror = (e) => {
        // 主动 cancel 会以 interrupted/canceled 回调，不能当成读完
        if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
        advance();
    };

    try {
        window.speechSynthesis.speak(u);
    } catch (e) {
        ui.showToast('朗读失败：' + e.message);
        listenState.playing = false;
        updatePlayButton();
        return;
    }

    // 兜底：安卓 WebView 的 onend 偶尔不触发，按字数估个上限，到点强制推进
    const est = Math.max(3500, text.length * 300 / listenState.rate + 2000);
    listenState.watchdog = setTimeout(advance, est);
}

function listenPrev() {
    const i = Math.max(0, listenState.idx - 1);
    listenState.idx = i;
    listenHighlight(i);
    if (listenState.playing) listenSpeakAt(i);
}

function listenNext() {
    const i = Math.min(listenState.sentences.length - 1, listenState.idx + 1);
    listenState.idx = i;
    listenHighlight(i);
    if (listenState.playing) listenSpeakAt(i);
}

async function listenFinishChapter() {
    listenState.playing = false;
    updatePlayButton();
    keepScreenAwake(false);

    const chapters = await novelManager.listChapters(listenState.novelId);
    const next = chapters.filter(c => c.number > listenState.chapterNum).sort((a, b) => a.number - b.number)[0];

    if (!listenState.autoNext || !next) {
        ui.showToast(next ? '本章读完' : '已经是最后一章');
        return;
    }
    ui.showToast(`接着听第${next.number}章`);
    listenState.autoplay = true;
    navigateTo('listen', { novelId: listenState.novelId, chapterNum: next.number });
}

function listenCycleRate() {
    const i = LISTEN_RATES.indexOf(listenState.rate);
    listenState.rate = LISTEN_RATES[(i + 1) % LISTEN_RATES.length];
    const btn = document.getElementById('ls-rate');
    if (btn) btn.textContent = listenState.rate.toFixed(1) + 'x';
    if (listenState.playing) listenSpeakAt(listenState.idx);   // 立即用新语速重读本句
}

function listenToggleAuto() {
    listenState.autoNext = !listenState.autoNext;
    const btn = document.getElementById('ls-auto');
    if (btn) btn.classList.toggle('on', listenState.autoNext);
    ui.showToast(listenState.autoNext ? '读完自动下一章' : '只读本章');
}

async function saveListenPos() {
    try {
        await settings.set('listenPos', {
            novelId: listenState.novelId,
            chapterNum: listenState.chapterNum,
            idx: listenState.idx,
            updated: Date.now()
        });
    } catch (e) { /* 记不住进度不影响听 */ }
}

function leaveListen(novelId) {
    saveListenPos();
    listenStop();
    keepScreenAwake(false);
    navigateTo('novelDetail', { novelId });
}

// 听稿时别让屏幕自动熄灭（不支持就静默跳过）
let __wakeLock = null;
async function keepScreenAwake(on) {
    try {
        if (on) {
            if (!('wakeLock' in navigator) || __wakeLock) return;
            __wakeLock = await navigator.wakeLock.request('screen');
            __wakeLock.addEventListener('release', () => { __wakeLock = null; });
        } else if (__wakeLock) {
            await __wakeLock.release();
            __wakeLock = null;
        }
    } catch (e) { __wakeLock = null; }
}

// ===== 样式 =====
(function injectListenStyle() {
    if (document.getElementById('ls-style')) return;
    const s = document.createElement('style');
    s.id = 'ls-style';
    s.textContent = `
    .ls-wrap{padding:12px 18px 150px}
    .ls-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}
    .ls-title{font-size:15px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ls-meta{font-size:11.5px;color:var(--text-tertiary,#999);flex:none}
    .ls-hint{font-size:11.5px;color:var(--text-tertiary,#999);line-height:1.7;margin-bottom:14px}
    .ls-body{font-size:17px;line-height:2.15;letter-spacing:.01em;color:#3a3a3a}
    .ls-sent{padding:1px 2px;border-radius:4px;cursor:pointer;transition:background .18s,color .18s}
    .ls-sent:active{background:rgba(99,102,241,.08)}
    .ls-sent.ls-current{background:rgba(99,102,241,.16);color:#1b1b1b;font-weight:600;box-shadow:0 0 0 2px rgba(99,102,241,.12)}
    .ls-rep{border-bottom:2px dotted #d9534f;font-style:normal}
    .ls-bar{
        position:fixed;left:0;right:0;
        bottom:calc(var(--nav-height, 60px) + var(--safe-bottom, 0px));
        display:flex;align-items:center;justify-content:center;gap:12px;
        padding:10px 16px;
        background:rgba(255,255,255,.96);backdrop-filter:blur(12px);
        border-top:1px solid #eee;z-index:20;
    }
    .ls-btn{
        width:42px;height:42px;border-radius:50%;border:1px solid #e5e5e5;background:#fff;
        font-size:18px;color:#444;display:flex;align-items:center;justify-content:center;cursor:pointer;
    }
    .ls-main{width:54px;height:54px;background:var(--primary,#6366f1);border-color:var(--primary,#6366f1);color:#fff;font-size:20px}
    .ls-rate{
        height:30px;padding:0 10px;border-radius:15px;border:1px solid #e5e5e5;background:#fff;
        font-size:12.5px;color:#555;font-variant-numeric:tabular-nums;cursor:pointer;
    }
    .ls-auto{
        height:30px;padding:0 10px;border-radius:15px;border:1px solid #e5e5e5;background:#fff;
        font-size:12.5px;color:#999;cursor:pointer;
    }
    .ls-auto.on{border-color:var(--primary,#6366f1);color:var(--primary,#6366f1);background:rgba(99,102,241,.08)}
    .ls-empty{padding:60px 24px;text-align:center}
    .ls-empty-title{font-size:16px;font-weight:600;margin-bottom:10px}
    .ls-empty-desc{font-size:13px;color:#999;line-height:1.8}
    `;
    document.head.appendChild(s);
})();
