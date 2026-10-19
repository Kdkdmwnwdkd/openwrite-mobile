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
                date: it.datePublished || '',
                // 博查的 summary 是长摘要，够长时直接当正文，省一次抓取
                fullText: (it.summary && it.summary.length > 800) ? it.summary : ''
            }));
        }
    },
    serper: {
        label: 'Serper（Google）',
        hint: 'Google 结果，国内可直连，注册送 2500 次',
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
        hint: '每月 1000 次免费；浏览器直连的跨域支持不稳定，建议配代理',
        endpoint: 'https://api.tavily.com/search',
        headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }),
        // include_raw_content 让 Tavily 直接回正文，就不必再抓一次
        body: (q, count) => ({ query: q, max_results: count, include_answer: false, include_raw_content: true }),
        normalize: (data) => ((data && data.results) || []).map(it => ({
            title: it.title || '',
            url: it.url || '',
            site: hostOf(it.url),
            snippet: it.content || '',
            date: it.published_date || '',
            fullText: it.raw_content || ''
        }))
    }
};

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// ===== 配置 =====
const RESEARCH_DEFAULT = { mode: 'off', provider: 'bocha', apiKey: '', reader: '', autoFetch: false, count: 6 };

async function getResearchConfig() {
    const saved = await settings.get('researchConfig', null);
    return Object.assign({}, RESEARCH_DEFAULT, saved || {});
}

async function setResearchConfig(cfg) {
    await settings.set('researchConfig', Object.assign({}, RESEARCH_DEFAULT, cfg));
}

// 模型内置联网：按 baseUrl / model 识别厂商，返回要合并进请求体的字段
// 识别不出来的厂家一律返回 null，宁可明确报错，也不发一个可能 400 的请求。
// 注意：DeepSeek 的服务端搜索只挂在 v4-flash 上，chat / reasoner 带这个工具会被 400 拒掉，
// 所以只有模型名里带 v4 才放行——不能因为"是 DeepSeek"就声称能联网，
// 更不允许偷偷把用户配的 chat 换成 v4-flash（用户没配过那个模型，账号也不一定开通）。
function buildBuiltinSearchPayload(config) {
    const url = String((config && config.baseUrl) || '').toLowerCase();
    const model = String((config && config.model) || '').toLowerCase();
    if (url.includes('dashscope') || model.startsWith('qwen')) return { enable_search: true };
    if (url.includes('bigmodel') || model.startsWith('glm')) return { tools: [{ type: 'web_search' }] };
    // DeepSeek 的服务端搜索只存在于 Responses 端点（/responses），
    // chat/completions 带这个工具会被 400 拒掉，所以单独走一条路，见 deepseekWebSearch
    if (url.includes('deepseek') || model.startsWith('deepseek')) {
        return /v4/i.test(model) ? { __responses: true } : null;
    }
    return null;
}

// 当前模型能不能自己联网。能的话，用户不需要配任何搜索服务。
async function currentModelSupportsBuiltin() {
    try {
        const mc = await settings.getModelConfig();
        return !!buildBuiltinSearchPayload(mc);
    } catch (e) {
        return false;
    }
}

// 告诉上层「这个模型为什么不能联网、该怎么修」。
// 开联网按钮时用它给出可操作的提示，而不是一句"换模型"让人猜。
function describeBuiltinSearch(config) {
    if (buildBuiltinSearchPayload(config)) return { ok: true };
    const model = String((config && config.model) || '').toLowerCase();
    const url = String((config && config.baseUrl) || '').toLowerCase();
    if (model.startsWith('deepseek') || url.includes('deepseek')) {
        return {
            ok: false,
            reason: `DeepSeek 只有 deepseek-v4-flash 带联网搜索，你配的是「${(config && config.model) || '未设置'}」`,
            fix: '去模型设置换成 deepseek-v4-flash，或在查资料配置里填一个搜索 Key'
        };
    }
    return {
        ok: false,
        reason: '当前模型没有内置联网能力',
        fix: '换通义 / 智谱（GLM）/ deepseek-v4-flash，或填一个搜索 Key'
    };
}

// 决定这次搜索走哪条路：
// 模型自带联网 > 用户填的搜索 API > 没得用
// 这样只要模型支持，"点一下就能搜"，不必先去配置页选模式
async function resolveSearchMode() {
    const cfg = await getResearchConfig();
    if (cfg.mode === 'api' && cfg.apiKey) return { mode: 'api', cfg };
    if (await currentModelSupportsBuiltin()) return { mode: 'builtin', cfg };
    if (cfg.mode === 'api') return { mode: 'api', cfg };   // 选了 API 但没填 key，让它抛错更明确
    return { mode: 'off', cfg };
}

// DeepSeek 的联网搜索：一次请求内完成 search → open_page → 回答。
// 结果不可见（服务端注入），但 open_page 的 URL 会回传，可以当来源。
// 直接用用户配置的模型，不偷换：能走到这里说明模型名带 v4（见 buildBuiltinSearchPayload），
// 若配置被改坏，宁可明确报错，也不静默换成另一个模型。
async function deepseekWebSearch(query) {
    const mc = await settings.getModelConfig();
    if (!mc || !mc.apiKey) throw new Error('还没配置模型 Key');

    const model = String(mc.model || '');
    if (!/v4/i.test(model)) {
        throw new Error(`DeepSeek 的联网搜索只支持 deepseek-v4-flash，当前配的是「${model || '未设置'}」，请到模型设置里切换`);
    }

    let base = String(mc.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    if (base.endsWith('/v1')) base = base.slice(0, -3);

    const res = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${mc.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            input: query,
            tools: [{ type: 'web_search' }],
            store: false
        })
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        let hint = '';
        if (res.status === 400) hint = '（DeepSeek 联网搜索需要 deepseek-v4-flash 模型）';
        if (res.status === 404) hint = '（当前接口没有 /responses，请把地址填成 https://api.deepseek.com）';
        throw new Error(`DeepSeek 联网返回 ${res.status}${hint}${detail ? '：' + detail.slice(0, 100) : ''}`);
    }

    const data = await res.json();
    const items = data.output || [];
    let text = '';
    const urls = [];
    for (const it of items) {
        if (it.type === 'message' && Array.isArray(it.content)) {
            for (const c of it.content) {
                if (c.type === 'output_text' && c.text) text += c.text;
            }
        }
        if (it.type === 'web_search_call' && it.action && it.action.type === 'open_page' && it.action.url) {
            urls.push(it.action.url);
        }
    }

    text = text.trim();
    if (!text) throw new Error('联网没有返回内容，换个问法再试');

    return [{
        title: 'DeepSeek 联网检索',
        url: urls[0] || '',
        site: urls[0] ? hostOf(urls[0]) : 'DeepSeek 服务端搜索',
        snippet: text,
        date: '',
        kind: 'answer'
    }];
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
    if (payload.__responses) return await deepseekWebSearch(query);
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
    const { mode, cfg } = await resolveSearchMode();
    if (mode === 'off') throw new Error('当前模型没有联网能力，需要配一个搜索 API');
    if (mode === 'builtin') return await researchSearchBuiltin(query);
    return await researchSearchApi(query, cfg);
}

// ===== 检索排序（BM25）=====
// 原来判断「这段资料要不要注入」靠的是「正文里包含标题或关键词」，
// 资料一多就会两种结果：要么全命中（关键词太短），要么全不命中（说法不一样）。
// 这里换成 BM25 打分：中文按二元组切词，不引分词库，手机上不背额外依赖。

function researchTokenize(text) {
    const s = String(text || '').toLowerCase();
    const tokens = [];

    // 英文 / 数字按词
    const latin = s.match(/[a-z0-9]{2,}/g);
    if (latin) tokens.push(...latin);

    // 中文按相邻两字切
    const segs = s.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(' ').filter(Boolean);
    for (const seg of segs) {
        if (seg.length === 1) { tokens.push(seg); continue; }
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    }
    return tokens;
}

function researchRank(queryText, items, topK = 4) {
    if (!items || !items.length) return [];

    // 查询侧裁一下，避免整章正文产生上万个词元
    const qTokens = Array.from(new Set(researchTokenize(String(queryText || '').slice(0, 1500)))).slice(0, 600);
    if (!qTokens.length) return [];

    const docs = items.map(it => {
        const kw = Array.isArray(it.keywords) ? it.keywords.join(' ') : '';
        const text = `${it.title || ''} ${kw} ${(it.content || '').slice(0, 1200)}`;
        const tokens = researchTokenize(text);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        return { item: it, tf, len: tokens.length };
    });

    const N = docs.length;
    const avgdl = (docs.reduce((s, d) => s + d.len, 0) / N) || 1;

    const df = new Map();
    for (const t of qTokens) {
        let c = 0;
        for (const d of docs) if (d.tf.has(t)) c++;
        df.set(t, c);
    }

    const K1 = 1.2, B = 0.75;
    const scored = [];
    for (const d of docs) {
        let score = 0;
        for (const t of qTokens) {
            const f = d.tf.get(t);
            if (!f) continue;
            const n = df.get(t);
            const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
            score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avgdl));
        }
        if (score > 0) scored.push({ item: d.item, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(s => s.item);
}

// ===== 正文抓取 =====
// 为什么不能直接 fetch(url)：浏览器跨域读不到别人的网页（对方不给 CORS 头），
// 而且百科类站点还会拦爬虫（实测百度直接 403）。所以必须借一层代理。
// 这里不绑定任何具体服务：用户填一个 URL 模板，{url} 会被替换成目标链接。

// 从 HTML 里挑出正文：先删噪点，再按「段落文字量」给容器打分，取最高的那个
function extractMainText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,iframe,svg,nav,header,footer,aside,form,button')
        .forEach(el => el.remove());

    let best = doc.body;
    let bestScore = 0;
    doc.querySelectorAll('article,main,section,div').forEach(el => {
        let score = 0;
        el.querySelectorAll(':scope > p').forEach(p => { score += (p.textContent || '').trim().length; });
        // 直接子段落为主；整块也算一部分权重，避免正文被包在多层 div 里漏掉
        score += el.textContent ? Math.min(el.textContent.length / 50, 200) : 0;
        if (score > bestScore) { bestScore = score; best = el; }
    });

    const blocks = Array.from(best.querySelectorAll('p,h1,h2,h3,h4,li,blockquote'));
    let text = blocks.length
        ? blocks.map(b => (b.textContent || '').trim()).filter(s => s.length > 1).join('\n\n')
        : (best.textContent || '');

    return text
        .replace(/\r/g, '')
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function fetchArticleText(url) {
    const cfg = await getResearchConfig();
    if (!cfg.reader) throw new Error('还没配正文抓取代理');

    const target = cfg.reader.includes('{url}')
        ? cfg.reader.replace('{url}', encodeURIComponent(url))
        : cfg.reader + encodeURIComponent(url);

    const res = await fetch(target);
    if (!res.ok) throw new Error(`抓取服务返回 ${res.status}`);
    const raw = await res.text();
    const text = raw.trim().startsWith('<') ? extractMainText(raw) : raw.trim();
    if (text.length < 60) throw new Error('没抓到正文（可能被反爬或需要登录）');
    return text.slice(0, 8000);
}

async function researchFetchOne(i, quiet = false) {
    const it = researchState.items[i];
    if (!it || !it.url) return false;
    if (it.fullText) { if (!quiet) ui.showToast('这篇已经有正文了'); return true; }
    try {
        let text = await fetchArticleText(it.url);
        // 正文开头常重复一遍标题（h1），去掉，免得资料库里标题出现两遍。
        // 标题常带站点后缀（"锦衣卫 - 百度百科"），所以用「包含」而不是「相等」来判断
        const title = (it.title || '').trim();
        const lines = text.split('\n');
        const first = (lines[0] || '').trim();
        if (lines.length > 1 && first.length <= 30 && title.includes(first)) {
            text = lines.slice(1).join('\n').trim();
        }
        it.fullText = text;
        renderResearchResults();
        if (!quiet) ui.showToast(`已抓到正文 ${text.length} 字`);
        return true;
    } catch (e) {
        if (!quiet) {
            ui.showToast(e.message);
            if (/还没配正文抓取代理/.test(e.message)) openResearchConfig();
        }
        return false;
    }
}

async function researchFetchPicked() {
    const idx = Array.from(researchState.picked).sort((a, b) => a - b);
    if (!idx.length) { ui.showToast('还没勾选内容'); return; }
    const cfg = await getResearchConfig();
    if (!cfg.reader) { ui.showToast('还没配正文抓取代理'); openResearchConfig(); return; }

    let ok = 0, fail = 0;
    for (const i of idx) {
        if (researchState.items[i] && researchState.items[i].fullText) { ok++; continue; }
        const box = rsEl('#rs-results');
        if (box) box.classList.add('rs-busy');
        const done = await researchFetchOne(i, true);
        done ? ok++ : fail++;
    }
    const box = rsEl('#rs-results');
    if (box) box.classList.remove('rs-busy');
    ui.showToast(`抓取完成：成功 ${ok} 篇${fail ? `，失败 ${fail} 篇` : ''}`);
}

// ===== 沉淀：写进作品资料库 =====
// 复用 worldbuilding 存储（category='research'），这样世界观页能直接看到、编辑、删除
async function researchSinkItems(novelId, items, query) {
    if (!novelId) throw new Error('请先选择作品');
    let saved = 0;
    for (const it of items) {
        // 抓到正文就用正文，没抓到退回摘要
        const body = (it.fullText || it.snippet || '').trim();
        const content = [
            body,
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
            fetched: !!it.fullText,
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

    // 状态按「实际会走的通道」显示。模型自带联网时如果还写"未开启"，会把人误导走。
    const resolved = await resolveSearchMode();
    const mc = await settings.getModelConfig().catch(() => null);
    const modeText = resolved.mode === 'off' ? '未开启（当前模型不能联网）'
        : resolved.mode === 'builtin'
            ? `${(mc && mc.model) || '模型'} 自带联网`
            : (RESEARCH_PROVIDERS[resolved.cfg.provider] || {}).label || resolved.cfg.provider;

    const novelPicker = novels.length > 1 ? `
        <select class="rs-novel-select" onchange="researchState.novelId=this.value;renderResearchResults()">
            ${novels.map(n => `<option value="${escapeAttr(n.id)}" ${n.id === researchState.novelId ? 'selected' : ''}>${escapeHtml(n.title)}</option>`).join('')}
        </select>` : '';

    container.innerHTML = `
        <div class="rs-wrap">
            <div class="rs-status">
                <span class="rs-status-dot ${resolved.mode === 'off' ? 'off' : 'on'}"></span>
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

        // 开了「自动抓正文」就直接抓，省一步点击
        const cfg = await getResearchConfig();
        if (cfg.autoFetch && cfg.reader) {
            ui.showToast('正在抓取正文…');
            await researchFetchPicked();
        }
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
            ${items.map((it, i) => {
                const hasBody = !!it.fullText;
                const preview = (it.fullText || it.snippet || '');
                return `
                <div class="rs-item ${researchState.picked.has(i) ? 'on' : ''}" onclick="researchTogglePick(${i})">
                    <div class="rs-check">${researchState.picked.has(i) ? '✓' : ''}</div>
                    <div class="rs-body">
                        <div class="rs-title">${escapeHtml(it.title || '未命名')}</div>
                        <div class="rs-snippet">${escapeHtml(preview.slice(0, 220))}${preview.length > 220 ? '…' : ''}</div>
                        <div class="rs-meta">
                            ${it.site ? `<span class="rs-site">${escapeHtml(it.site)}</span>` : ''}
                            ${it.date ? `<span>${escapeHtml(String(it.date).slice(0, 10))}</span>` : ''}
                            ${hasBody ? `<span class="rs-badge">正文 ${it.fullText.length} 字</span>` : ''}
                            ${it.url ? `<a class="rs-url" href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">原文</a>` : ''}
                            ${it.url && !hasBody ? `<button class="rs-fetch" onclick="event.stopPropagation();researchFetchOne(${i})">抓正文</button>` : ''}
                        </div>
                    </div>
                </div>`;
            }).join('')}
        </div>
        <div class="rs-actions">
            ${researchState.fromEditor ? `<button class="btn btn-outline" onclick="researchInsert()" ${researchState.picked.size ? '' : 'disabled'}>插入正文</button>` : ''}
            <button class="btn btn-outline" onclick="researchFetchPicked()" ${researchState.picked.size ? '' : 'disabled'}>抓正文</button>
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
                <span><b>模型内置联网</b><em>用当前模型自带搜索，不用另配 Key（通义 / 智谱 / DeepSeek-v4-flash）</em></span></label>
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

                <div class="rs-cfg-label" style="margin-top:16px">正文抓取代理（可选）</div>
                <input class="rs-input" id="rs-reader" placeholder="https://你的代理/?url={url}"
                       value="${escapeAttr(cfg.reader || '')}">
                <div class="rs-cfg-tip">
                    搜索只给摘要，写资料要正文。浏览器读不了别人的网页，得走一层代理，<code>{url}</code> 会替换成目标链接。
                    <button class="rs-link" onclick="showReaderHelp()">怎么弄</button>
                </div>
                <label class="rs-check-line">
                    <input type="checkbox" id="rs-auto" ${cfg.autoFetch ? 'checked' : ''}>
                    <span>搜索后自动抓正文</span>
                </label>
            </div>

            <div class="rs-cfg-tip" id="rs-builtin-tip" style="margin-top:12px;display:none">
                内置联网由模型服务端执行搜索，你只能拿到答案、拿不到来源列表，也无法沉淀成资料。<br>
                <b>DeepSeek 按次计费</b>：5 元 / 1000 次（约 ¥0.005/次），2026-11-01 起收费，之前免费；无结果或失败不计费。
                通义 / 智谱的搜索含在模型 token 费用里。<b>想完全免费</b>：用下面的搜索 API，Tavily 每月 1000 次、Serper 送 2500 次。
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
    const reader = ((document.getElementById('rs-reader') || {}).value || '').trim();
    const autoFetch = !!(document.getElementById('rs-auto') || {}).checked;

    if (mode === 'api' && !apiKey) { ui.showToast('选了搜索 API，但还没填 Key'); return; }
    if (reader && !/^https?:\/\//.test(reader)) { ui.showToast('抓取代理地址要以 http(s):// 开头'); return; }

    await setResearchConfig({ mode, provider, apiKey, reader, autoFetch, count: 6 });
    closeModal();
    ui.showToast('已保存');
    if (store.currentPage === 'research') navigateTo('research', {}, true);
}

// 代理不会自动生成，得让用户能五分钟搞定，否则这个功能就是死的
function showReaderHelp() {
    createModal('怎么配正文抓取', `
        <div class="rs-help">
            <p>浏览器出于安全限制读不了别人的网站，必须有一个"代你抓"的地址。两种办法：</p>

            <b>一、用 Cloudflare Workers（免费，推荐）</b>
            <p>新建一个 Worker，贴下面这段，部署后把地址填进「正文抓取代理」：</p>
<pre><code>export default {
  async fetch(req) {
    const u = new URL(req.url).searchParams.get("url");
    if (!u) return new Response("missing url", { status: 400 });
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
    return new Response(await r.text(), {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/html; charset=utf-8"
      }
    });
  }
}</code></pre>
            <p>填的格式：<code>https://你的子域.workers.dev/?url={url}</code></p>

            <b>二、用现成的抓取服务</b>
            <p>Firecrawl、Jina Reader 这类服务也能把网页转成纯文本。把它们的接口地址按 <code>{url}</code> 占位填进来即可。注意 Jina 在国内多数网络下直连超时，用之前先自己测一下。</p>

            <b>不配也能用</b>
            <p>搜索结果里的摘要（博查通常几百字）会直接存进资料库；只是拿不到整篇正文。</p>
        </div>
        <div class="rs-cfg-actions"><button class="btn btn-primary" onclick="closeModal()">知道了</button></div>
    `).show();
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
    .rs-cfg-actions .btn{flex:1}
    .rs-badge{background:#eef0ff;color:#5b5fd6;padding:1px 6px;border-radius:4px;font-size:11px}
    .rs-fetch{background:none;border:1px dashed #c9c9e8;color:#5b5fd6;border-radius:6px;padding:2px 8px;font-size:11.5px;cursor:pointer;font-family:inherit}
    .rs-fetch:active{background:#f2f2ff}
    .rs-check-line{display:flex;align-items:center;gap:8px;font-size:13px;margin-top:12px;color:#5f5f5f}
    .rs-busy{opacity:.55;pointer-events:none}
    .rs-help{font-size:13.5px;line-height:1.8;color:#4a4740}
    .rs-help b{display:block;margin:16px 0 4px;font-size:14px;color:#1b1a17}
    .rs-help p{margin:6px 0}
    .rs-help pre{background:#232019;color:#e8e2d4;padding:12px;border-radius:8px;overflow-x:auto;font-size:11px;line-height:1.6;font-family:ui-monospace,Menlo,monospace}
    .rs-help p code,.rs-help li code{background:#ece7db;padding:1px 4px;border-radius:3px;font-size:12px;color:#1b1a17}
    .rs-help pre code{background:none;padding:0;color:inherit;font-size:inherit;white-space:pre;}`;
    document.head.appendChild(s);
})();
