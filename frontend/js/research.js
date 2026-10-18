/**
 * OpenWrite Mobile - 查资料（research.js）
 * ------------------------------------------------------------------
 * 解决的问题：写小说要查朝代官制、地理气候、行业术语、真实事件，
 * 现在只能切出去用浏览器查，抄进备忘录，AI 写作时根本看不到。
 *
 * 设计原则：搜索与生成解耦，不让功能绑死在某一家的搜索能力上。
 *   1) 搜：用自己的搜索 API（博查 / Serper / Tavily），或模型内置联网
 *   2) 沉：勾选后写入该作品的「参考资料」（复用 worldbuilding，category=research）
 *   3) 注：写作时按关键词命中注入上下文（见 app.js 的 buildLayeredContext）
 *
 * 依赖：app.js 的 escapeHtml / ui / settings / ai / novelManager / db / createModal
 */

// ===== 供应商适配 =====
// 只做「发请求」和「把各家不同的返回结构统一成同一种形状」两件事。
const RESEARCH_PROVIDERS = {
    bocha: {
        label: '博查 Bocha',
        hint: '国内直连，中文质量好，有免费额度',
        endpoint: 'https://api.bochaai.com/v1/web-search',
        headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }),
        body: (q, count) => ({ query: q, count, summary: true }),
        normalize: (data) => {
            const list = (data && data.data && data.data.webPages && data.data.webPages.value) || [];
            return list.map(it => ({
                title: it.name || '',
                url: it.url || '',
                site: it.siteName || hostOf(it.url),
                snippet: it.summary || it.snippet || '',
                date: it.datePublished || ''
            }));
        }
    },
    serper: {
        label: 'Serper（Google）',
        hint: 'Google 结果，国内可直连，按次计费',
        endpoint: 'https://google.serper.dev/search',
        headers: (key) => ({ 'X-API-KEY': key, 'Content-Type': 'application/json' }),
        body: (q, count) => ({ q, num: count }),
        normalize: (data) => ((data && data.organic) || []).map(it => ({
            title: it.title || '',
            url: it.link || '',
            site: hostOf(it.link),
            snippet: it.snippet || '',
            date: it.date || ''
        }))
    },
    tavily: {
        label: 'Tavily',
        hint: 'Agent 生态广；浏览器直连的跨域支持不稳定，建议配代理',
        endpoint: 'https://api.tavily.com/search',
        headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }),
        body: (q, count) => ({ query: q, max_results: count, include_answer: false }),
        normalize: (data) => ((data && data.results) || []).map(it => ({
            title: it.title || '',
            url: it.url || '',
            site: hostOf(it.url),
            snippet: it.content || '',
            date: it.published_date || ''
        }))
    }
};

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// ===== 配置 =====
const RESEARCH_DEFAULT = { mode: 'off', provider: 'bocha', apiKey: '', count: 6 };

async function getResearchConfig() {
    const saved = await settings.get('researchConfig', null);
    return Object.assign({}, RESEARCH_DEFAULT, saved || {});
}

async function setResearchConfig(cfg) {
    await settings.set('researchConfig', Object.assign({}, RESEARCH_DEFAULT, cfg));
}

// 模型内置联网：按 baseUrl / model 识别厂商，返回要合并进请求体的字段
// 识别不出来的厂家一律返回 null，宁可明确报错，也不发一个可能 400 的请求
function buildBuiltinSearchPayload(config) {
    const url = String(config.baseUrl || '').toLowerCase();
    const model = String(config.model || '').toLowerCase();
    if (url.includes('dashscope') || model.startsWith('qwen')) return { enable_search: true };
    if (url.includes('bigmodel') || model.startsWith('glm')) return { tools: [{ type: 'web_search' }] };
    return null;
}

// ===== 搜索 =====
async function researchSearchApi(query, cfg) {
    const p = RESEARCH_PROVIDERS[cfg.provider];
    if (!p) throw new Error('未知的搜索服务');
    if (!cfg.apiKey) throw new Error('还没填搜索服务的 API Key');

    const res = await fetch(p.endpoint, {
        method: 'POST',
        headers: p.headers(cfg.apiKey),
        body: JSON.stringify(p.body(query, cfg.count || 6))
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`${p.label} 返回 ${res.status}${detail ? '：' + detail.slice(0, 120) : ''}`);
    }
    const data = await res.json();
    const items = p.normalize(data);
    if (!items.length) throw new Error('没有搜到结果，换个说法试试');
    return items;
}

async function researchSearchBuiltin(query) {
    const config = await settings.getModelConfig();
    const payload = buildBuiltinSearchPayload(config);
    if (!payload) {
        throw new Error('当前模型没有内置联网能力，请到「查资料 → 配置」改用搜索 API 模式');
    }
    const text = await ai.chat([
        { role: 'system', content: '你是资料检索助手。请联网核实后回答，只给事实与关键数据，注明出处名称与年份，不要编造。控制在 400 字内。' },
        { role: 'user', content: query }
    ], null, 1200, null, { searchPayload: payload });

    return [{
        title: 'AI 联网检索结果',
        url: '',
        site: config.model || 'model',
        snippet: text.trim(),
        date: '',
        kind: 'answer'
    }];
}

async function researchSearch(query) {
    const cfg = await getResearchConfig();
    if (cfg.mode === 'off') throw new Error('还没开启查资料，请先到配置里选一种方式');
    if (cfg.mode === 'builtin') return await researchSearchBuiltin(query);
    return await researchSearchApi(query, cfg);
}

// ===== 沉淀：写进作品资料库 =====
// 复用 worldbuilding 存储（category='research'），这样世界观页能直接看到、编辑、删除
async function researchSinkItems(novelId, items, query) {
    if (!novelId) throw new Error('请先选择作品');
    let saved = 0;
    for (const it of items) {
        const content = [
            it.snippet || '',
            it.url ? `来源：${it.url}` : ''
        ].filter(Boolean).join('\n\n');

        await db.put('worldbuilding', {
            id: `wbr_${novelId}_${Date.now()}_${saved}`,
            novelId,
            category: 'research',
            title: it.title || '未命名资料',
            content,
            rules: '',                       // 与既有结构保持一致，避免编辑页报错
            keywords: buildResearchKeywords(it, query),
            source: { url: it.url || '', site: it.site || '', date: it.date || '' },
            query: query || '',
            created: Date.now(),
            updated: Date.now()
        });
        saved++;
    }
    return saved;
}

// 关键词用于写作时的命中判断：标题里的词 + 搜索词本身
function buildResearchKeywords(item, query) {
    const words = new Set();
    if (query) words.add(query);
    const title = String(item.title || '');
    // 中文按 2-4 字片段粗切，够用且不引入分词库
    for (let i = 0; i < title.length; i++) {
        for (const len of [4, 3, 2]) {
            if (i + len <= title.length) words.add(title.slice(i, i + len));
        }
    }
    return Array.from(words).filter(w => w.trim().length >= 2).slice(0, 40);
}

// ===== 页面 =====
// 搜索结果的状态（弹窗与页面共用一份，切换入口时整体重置）
let researchState = { items: [], picked: new Set(), query: '', novelId: null, busy: false, fromEditor: false };

// 页面与弹窗都会渲染一份 #rs-query / #rs-results，而 navigateTo 不会销毁旧页面，
// 直接用 getElementById 会拿到隐藏页里那个元素。这里统一按「当前可见的根」来找。
function rsRoot() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) return modal;
    return document.querySelector('.page-view.active') || document;
}

function rsEl(sel) {
    return rsRoot().querySelector(sel);
}

async function renderResearch(container) {
    ui.setPageTitle('🔎 查资料');
    ui.setHeaderActions(`<button class="header-btn" onclick="openResearchConfig()">配置</button>`);

    const cfg = await getResearchConfig();
    const novels = await novelManager.list();
    researchState.fromEditor = false;
    if (!researchState.novelId || !novels.some(n => n.id === researchState.novelId)) {
        researchState.novelId = (novels[0] && novels[0].id) || null;
    }

    const modeText = cfg.mode === 'off' ? '未开启'
        : cfg.mode === 'builtin' ? '模型内置联网'
        : (RESEARCH_PROVIDERS[cfg.provider] || {}).label || cfg.provider;

    const novelPicker = novels.length > 1 ? `
        <select class="rs-novel-select" onchange="researchState.novelId=this.value;renderResearchResults()">
            ${novels.map(n => `<option value="${escapeAttr(n.id)}" ${n.id === researchState.novelId ? 'selected' : ''}>${escapeHtml(n.title)}</option>`).join('')}
        </select>` : '';

    container.innerHTML = `
        <div class="rs-wrap">
            <div class="rs-status">
                <span class="rs-status-dot ${cfg.mode === 'off' ? 'off' : 'on'}"></span>
                <span>${escapeHtml(modeText)}</span>
                <button class="rs-link" onclick="openResearchConfig()">切换</button>
                ${novelPicker ? `<span style="margin-left:auto">存入</span>${novelPicker}` : ''}
            </div>

            <div class="rs-searchbar">
                <input class="rs-input" id="rs-query" placeholder="查什么？例：明代锦衣卫的品级与职能"
                       onkeydown="if(event.key==='Enter')runResearchSearch()">
                <button class="rs-btn" id="rs-go" onclick="runResearchSearch()">搜索</button>
            </div>

            <div class="rs-hintline">
                查到的条目勾选后存入作品资料库，AI 写正文时会按关键词自动引用。
            </div>

            <div id="rs-results"></div>
        </div>`;

    if (researchState.items.length) {
        renderResearchResults();
    }
}

async function runResearchSearch() {
    if (researchState.busy) return;
    const input = rsEl('#rs-query');
    const q = (input && input.value || '').trim();
    if (!q) { ui.showToast('请输入要查的内容'); return; }

    const box = rsEl('#rs-results');
    const go = rsEl('#rs-go');
    researchState.busy = true;
    if (go) { go.disabled = true; go.textContent = '查询中…'; }
    if (box) box.innerHTML = '<div class="rs-loading">正在检索…</div>';

    try {
        const items = await researchSearch(q);
        researchState.items = items;
        researchState.query = q;
        researchState.picked = new Set(items.map((_, i) => i));   // 默认全选，用户再取消
        renderResearchResults();
    } catch (e) {
        if (box) box.innerHTML = `<div class="rs-error">${escapeHtml(e.message)}</div>`;
        ui.showToast('检索失败');
    } finally {
        researchState.busy = false;
        if (go) { go.disabled = false; go.textContent = '搜索'; }
    }
}

function renderResearchResults() {
    const box = rsEl('#rs-results');
    if (!box) return;
    const items = researchState.items;

    if (!items.length) { box.innerHTML = ''; return; }

    const novelless = !researchState.novelId;
    box.innerHTML = `
        <div class="rs-result-head">
            <span>${items.length} 条结果 · 已选 ${researchState.picked.size}</span>
            <button class="rs-link" onclick="researchPickAll(true)">全选</button>
            <button class="rs-link" onclick="researchPickAll(false)">清空</button>
        </div>
        <div class="rs-list">
            ${items.map((it, i) => `
                <div class="rs-item ${researchState.picked.has(i) ? 'on' : ''}" onclick="researchTogglePick(${i})">
                    <div class="rs-check">${researchState.picked.has(i) ? '✓' : ''}</div>
                    <div class="rs-body">
                        <div class="rs-title">${escapeHtml(it.title || '未命名')}</div>
                        <div class="rs-snippet">${escapeHtml((it.snippet || '').slice(0, 220))}${(it.snippet || '').length > 220 ? '…' : ''}</div>
                        <div class="rs-meta">
                            ${it.site ? `<span class="rs-site">${escapeHtml(it.site)}</span>` : ''}
                            ${it.date ? `<span>${escapeHtml(String(it.date).slice(0, 10))}</span>` : ''}
                            ${it.url ? `<a class="rs-url" href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">原文</a>` : ''}
                        </div>
                    </div>
                </div>`).join('')}
        </div>
        <div class="rs-actions">
            ${researchState.fromEditor ? `<button class="btn btn-outline" onclick="researchInsert()" ${researchState.picked.size ? '' : 'disabled'}>插入正文</button>` : ''}
            <button class="btn btn-primary" onclick="researchSink()" ${(researchState.picked.size && !novelless) ? '' : 'disabled'}>
                ${novelless ? '先建一部作品' : `存入资料库（${researchState.picked.size}）`}
            </button>
        </div>`;
}

function researchPickAll(on) {
    researchState.picked = on ? new Set(researchState.items.map((_, i) => i)) : new Set();
    renderResearchResults();
}

function researchTogglePick(i) {
    if (researchState.picked.has(i)) researchState.picked.delete(i);
    else researchState.picked.add(i);
    renderResearchResults();
}

function researchPickedItems() {
    return Array.from(researchState.picked).sort((a, b) => a - b).map(i => researchState.items[i]).filter(Boolean);
}

async function researchSink() {
    const items = researchPickedItems();
    if (!items.length) { ui.showToast('还没勾选内容'); return; }
    if (!researchState.novelId) { ui.showToast('先选择作品'); return; }
    try {
        const n = await researchSinkItems(researchState.novelId, items, researchState.query);
        ui.showToast(`已存入资料库 ${n} 条`);
        researchState.picked = new Set();
        renderResearchResults();
    } catch (e) {
        ui.showToast('存入失败：' + e.message);
    }
}

// 插入正文：写到光标处，并提示保存（编辑器目前是手动保存）
function researchInsert() {
    const items = researchPickedItems();
    if (!items.length) { ui.showToast('还没勾选内容'); return; }
    const ta = document.getElementById('chapter-content');
    if (!ta) { ui.showToast('请先打开要插入的章节'); return; }

    const text = items.map(it => `〔${it.title}${it.site ? ' · ' + it.site : ''}〕`).join('\n') + '\n';
    const s = ta.selectionStart || 0;
    const e = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ui.showToast('已插入，记得点右上角保存');
    closeModal();
}

// ===== 配置弹窗 =====
async function openResearchConfig() {
    const cfg = await getResearchConfig();
    const body = `
        <div class="rs-cfg">
            <div class="rs-cfg-label">检索方式</div>
            <label class="rs-radio"><input type="radio" name="rs-mode" value="off" ${cfg.mode === 'off' ? 'checked' : ''}>
                <span><b>关闭</b><em>不联网，纯本机写作</em></span></label>
            <label class="rs-radio"><input type="radio" name="rs-mode" value="builtin" ${cfg.mode === 'builtin' ? 'checked' : ''}>
                <span><b>模型内置联网</b><em>用当前模型自带搜索，不用另配 Key（支持通义 / 智谱）</em></span></label>
            <label class="rs-radio"><input type="radio" name="rs-mode" value="api" ${cfg.mode === 'api' ? 'checked' : ''}>
                <span><b>搜索 API</b><em>结果带来源链接，可沉淀成资料，推荐</em></span></label>

            <div class="rs-cfg-block" id="rs-api-block">
                <div class="rs-cfg-label">搜索服务</div>
                <select class="rs-select" id="rs-provider">
                    ${Object.entries(RESEARCH_PROVIDERS).map(([k, v]) =>
                        `<option value="${k}" ${cfg.provider === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
                </select>
                <div class="rs-cfg-tip" id="rs-provider-hint"></div>

                <div class="rs-cfg-label" style="margin-top:14px">API Key</div>
                <input class="rs-input" id="rs-key" type="password" placeholder="只存在本机，不会上传"
                       value="${escapeAttr(cfg.apiKey || '')}">
                <div class="rs-cfg-tip">Key 存本机 IndexedDB；导出备份时会自动清空。</div>
            </div>

            <div class="rs-cfg-tip" id="rs-builtin-tip" style="margin-top:12px;display:none">
                内置联网由模型服务端执行搜索，你只能拿到答案、拿不到来源列表，也无法沉淀成资料。
            </div>
        </div>
        <div class="rs-cfg-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="saveResearchConfig()">保存</button>
        </div>`;

    createModal('查资料设置', body).show();

    const sync = () => {
        const mode = document.querySelector('input[name="rs-mode"]:checked').value;
        const apiBlock = document.getElementById('rs-api-block');
        const builtinTip = document.getElementById('rs-builtin-tip');
        if (apiBlock) apiBlock.style.display = mode === 'api' ? 'block' : 'none';
        if (builtinTip) builtinTip.style.display = mode === 'builtin' ? 'block' : 'none';
        updateProviderHint();
    };
    document.querySelectorAll('input[name="rs-mode"]').forEach(el => el.addEventListener('change', sync));
    const sel = document.getElementById('rs-provider');
    if (sel) sel.addEventListener('change', updateProviderHint);
    sync();
}

function updateProviderHint() {
    const sel = document.getElementById('rs-provider');
    const tip = document.getElementById('rs-provider-hint');
    if (!sel || !tip) return;
    const p = RESEARCH_PROVIDERS[sel.value];
    tip.textContent = p ? p.hint : '';
}

async function saveResearchConfig() {
    const modeEl = document.querySelector('input[name="rs-mode"]:checked');
    const mode = modeEl ? modeEl.value : 'off';
    const provider = (document.getElementById('rs-provider') || {}).value || 'bocha';
    const apiKey = ((document.getElementById('rs-key') || {}).value || '').trim();

    if (mode === 'api' && !apiKey) { ui.showToast('选了搜索 API，但还没填 Key'); return; }

    await setResearchConfig({ mode, provider, apiKey, count: 6 });
    closeModal();
    ui.showToast('已保存');
    if (store.currentPage === 'research') navigateTo('research', {}, true);
}

// ===== 从编辑器/对话直接调起（底部抽屉式） =====
async function showResearchSheet(novelId) {
    const cfg = await getResearchConfig();
    if (cfg.mode === 'off') {
        ui.showToast('先去「设置 → 查资料」开启');
        navigateTo('research', {}, true);
        return;
    }
    researchState = { items: [], picked: new Set(), query: '', novelId: novelId || researchState.novelId, busy: false, fromEditor: true };
    createModal('🔎 查资料', `
        <div class="rs-wrap rs-wrap-modal">
            <div class="rs-searchbar">
                <input class="rs-input" id="rs-query" placeholder="查什么？例：宋代交子的流通范围"
                       onkeydown="if(event.key==='Enter')runResearchSearch()">
                <button class="rs-btn" id="rs-go" onclick="runResearchSearch()">搜索</button>
            </div>
            <div id="rs-results"></div>
        </div>`).show();
    const el = rsEl('#rs-query');
    if (el) el.focus();
}

// ===== 样式（只注入一次，便于整体移除） =====
(function injectResearchStyle() {
    if (document.getElementById('rs-style')) return;
    const s = document.createElement('style');
    s.id = 'rs-style';
    s.textContent = `
    .rs-wrap{padding:14px 16px 24px}
    .rs-wrap-modal{padding:0}
    .rs-status{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-tertiary,#8b8b8b);margin-bottom:12px}
    .rs-status-dot{width:7px;height:7px;border-radius:50%;background:#c9c9c9}
    .rs-status-dot.on{background:#34c759}
    .rs-link{background:none;border:0;color:#6366f1;font-size:12.5px;padding:2px 4px;cursor:pointer}
    .rs-searchbar{display:flex;gap:8px;margin-bottom:8px}
    .rs-input{flex:1;min-width:0;height:42px;padding:0 14px;border:1px solid #e3e3e3;border-radius:10px;background:#fff;font-size:15px;outline:none}
    .rs-input:focus{border-color:#6366f1}
    .rs-select{width:100%;height:42px;padding:0 12px;border:1px solid #e3e3e3;border-radius:10px;background:#fff;font-size:14px}
    .rs-btn{height:42px;padding:0 18px;border:0;border-radius:10px;background:#6366f1;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
    .rs-btn:disabled{opacity:.55}
    .rs-hintline{font-size:12px;color:#9a9a9a;line-height:1.6;margin-bottom:14px}
    .rs-novel-select{height:28px;max-width:132px;padding:0 6px;border:1px solid #e3e3e3;border-radius:8px;background:#fff;font-size:12.5px;color:#5f5f5f}
    .rs-loading,.rs-error{padding:26px 0;text-align:center;font-size:14px;color:#9a9a9a}
    .rs-error{color:#c0392b}
    .rs-result-head{display:flex;align-items:center;gap:10px;font-size:12.5px;color:#8b8b8b;margin:6px 0 8px}
    .rs-result-head span:first-child{margin-right:auto}
    .rs-list{display:flex;flex-direction:column;gap:8px}
    .rs-item{display:flex;gap:10px;padding:12px 13px;border:1px solid #e8e8e8;border-radius:10px;background:#fff;cursor:pointer}
    .rs-item.on{border-color:#6366f1;background:#f7f7ff}
    .rs-check{flex:none;width:18px;height:18px;border-radius:5px;border:1.5px solid #d5d5d5;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;margin-top:2px}
    .rs-item.on .rs-check{background:#6366f1;border-color:#6366f1}
    .rs-body{min-width:0;flex:1}
    .rs-title{font-size:14.5px;font-weight:600;line-height:1.45;margin-bottom:4px;word-break:break-word}
    .rs-snippet{font-size:13px;color:#5f5f5f;line-height:1.65;word-break:break-word}
    .rs-meta{display:flex;gap:10px;align-items:center;font-size:11.5px;color:#a0a0a0;margin-top:6px;flex-wrap:wrap}
    .rs-site{color:#6366f1}
    .rs-url{color:#6366f1;text-decoration:none}
    .rs-actions{display:flex;gap:10px;margin-top:16px}
    .rs-actions .btn{flex:1}
    .rs-cfg-label{font-size:12px;color:#8b8b8b;margin:0 0 8px}
    .rs-radio{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e8e8e8;border-radius:10px;margin-bottom:8px;font-size:14px}
    .rs-radio input{margin-top:3px}
    .rs-radio b{display:block;font-weight:600;font-size:14px}
    .rs-radio em{display:block;font-style:normal;font-size:12px;color:#9a9a9a;line-height:1.55;margin-top:2px}
    .rs-cfg-block{margin-top:14px;padding:14px;border:1px solid #eee;border-radius:10px;background:#fafafa}
    .rs-cfg-tip{font-size:11.5px;color:#a0a0a0;line-height:1.6;margin-top:6px}
    .rs-cfg-actions{display:flex;gap:10px;margin-top:18px}
    .rs-cfg-actions .btn{flex:1}`;
    document.head.appendChild(s);
})();

// HTML 属性值转义（escapeHtml 会把引号转成实体，这里只补一层保险）
function escapeAttr(str) {
    return escapeHtml(str).replace(/`/g, '&#96;');
}
