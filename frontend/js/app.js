/**
 * OpenWrite Mobile - Pure Frontend Architecture
 * All logic runs in the browser/webkit. No backend server required.
 * Data stored in IndexedDB. AI calls go directly to provider APIs.
 */

// ===== Configuration =====
const CONFIG = {
    VERSION: '2.18.7',   // 与 package.json 保持一致
    APP_NAME: 'OpenWrite',
    DB_NAME: 'OpenWriteDB',
    DB_VERSION: 8
};

// ===== IndexedDB Store =====
const db = {
    // 连接复用。indexedDB.open() 每调用一次都会新建一条连接，而且浏览器不会自动回收，
    // 旧实现里每个 db.get / db.put 都 open 一次，翻几十章就能堆出上百条连接，
    // 轻则内存涨，重则新连接被拒（浏览器对同源连接数有上限）。
    // 这里缓存 Promise，全局只开一次。
    _openPromise: null,
    open() {
        if (this._openPromise) return this._openPromise;
        this._openPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
            request.onerror = () => {
                this._openPromise = null;
                reject(request.error);
            };
            request.onsuccess = () => {
                const database = request.result;
                // 另一个标签页要升级版本时会触发 versionchange，必须让出连接，
                // 否则那边会一直卡在 blocked。让出后清掉缓存，下次重新打开。
                database.onversionchange = () => {
                    try { database.close(); } catch (_) {}
                    this._openPromise = null;
                };
                database.onclose = () => { this._openPromise = null; };
                resolve(database);
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('novels')) {
                    db.createObjectStore('novels', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('chapters')) {
                    const cs = db.createObjectStore('chapters', { keyPath: 'id' });
                    cs.createIndex('novelId', 'novelId', { unique: false });
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('messages')) {
                    const ms = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                    ms.createIndex('sessionId', 'sessionId', { unique: false });
                }
                // v2: 技能、审查记录、风格模板
                if (!db.objectStoreNames.contains('skills')) {
                    db.createObjectStore('skills', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('reviews')) {
                    db.createObjectStore('reviews', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('templates')) {
                    db.createObjectStore('templates', { keyPath: 'id' });
                }
                // v3: Skill 广场（用户自定义技能上传）
                if (!db.objectStoreNames.contains('skillStore')) {
                    db.createObjectStore('skillStore', { keyPath: 'id' });
                }
                // v4: 备忘录系统
                if (!db.objectStoreNames.contains('memos')) {
                    db.createObjectStore('memos', { keyPath: 'id' });
                }
                // v5: 角色卡系统
                if (!db.objectStoreNames.contains('characters')) {
                    const chars = db.createObjectStore('characters', { keyPath: 'id' });
                    chars.createIndex('novelId', 'novelId', { unique: false });
                }
                // v6: 世界观设定库
                // v8: 章节版本历史（支持回滚）
                if (!db.objectStoreNames.contains('versions')) {
                    const vs = db.createObjectStore('versions', { keyPath: 'id' });
                    vs.createIndex('chapterId', 'chapterId', { unique: false });
                }
                if (!db.objectStoreNames.contains('worldbuilding')) {
                    const wb = db.createObjectStore('worldbuilding', { keyPath: 'id' });
                    wb.createIndex('novelId', 'novelId', { unique: false });
                    wb.createIndex('category', 'category', { unique: false });
                }
            };
        });
        return this._openPromise;
    },

    // 主键为空时 IndexedDB 会直接抛 "No key or key range specified"，
    // 而调用方多半是「参数没传全」（比如从深链接进听稿页），
    // 结果就是整页白屏 + 一条看不懂的报错。这里统一按"没找到"处理。
    async get(store, key) {
        if (key === undefined || key === null || key === '') return null;
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readonly');
            const os = tx.objectStore(store);
            const req = os.get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    },

    async getAll(store, indexName, value) {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readonly');
            const os = tx.objectStore(store);
            let source = os;
            if (indexName) source = os.index(indexName);
            const req = value ? source.getAll(value) : source.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    },

    async put(store, value) {
        if (!value || typeof value !== 'object') throw new Error('写入数据不合法');
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            const req = os.put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    },

    async delete(store, key) {
        if (key === undefined || key === null || key === '') return;
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            const req = os.delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    },

    // ===== 备份/恢复支持 =====
    STORES: ['novels', 'chapters', 'settings', 'messages', 'skills', 'reviews', 'templates', 'skillStore', 'memos', 'characters', 'worldbuilding', 'versions'],

    async exportAll() {
        const database = await this.open();
        const result = {};
        for (const store of this.STORES) {
            if (!database.objectStoreNames.contains(store)) continue;
            result[store] = await this.getAll(store);
        }
        // 安全：备份文件不含任何 API Key / Token。
        // 导入时若检测到缺失的 Key，保留设备本机原有的配置。
        if (Array.isArray(result.settings)) {
            result.settings = result.settings.map((item) => {
                if (!item || !item.value) return item;
                // API Key 与 WebDAV 密码都不进备份文件
                if (item.key === 'modelConfig') {
                    return { ...item, value: { ...item.value, apiKey: '' } };
                }
                if (item.key === 'syncConfig') {
                    return { ...item, value: { ...item.value, pass: '', password: '' } };
                }
                return item;
            });
        }
        return {
            app: CONFIG.APP_NAME,
            version: CONFIG.VERSION,
            exportedAt: new Date().toISOString(),
            redacted: ['settings.modelConfig.apiKey'],
            stores: result
        };
    },

    // 导入前的安全过滤。
    // 1) 一律不采用备份里的 modelConfig：备份本身已抹掉 Key，导入它只会把 baseUrl 一起带进来，
    //    而 baseUrl 指向哪，决定了下一次调用时 Key 发给谁。
    // 2) 记录 id 只允许安全字符：这些 id 会被拼进 onclick="fn('${id}')"，
    //    一个带引号的 id 就能从数据变成脚本。
    SAFE_ID: /^[A-Za-z0-9_-]{1,80}$/,
    sanitizeImport(store, records) {
        const dropped = { bad: 0, modelConfig: 0, syncConfig: 0 };
        const out = [];
        for (const r of records) {
            if (!r || typeof r !== 'object') { dropped.bad++; continue; }

            if (store === 'settings') {
                if (r.key === 'modelConfig') { dropped.modelConfig++; continue; }  // 保留本机配置
                if (r.key === 'syncConfig') { dropped.syncConfig = (dropped.syncConfig || 0) + 1; continue; }  // 同上，同步地址同样不能被接管
                if (typeof r.key !== 'string' || !this.SAFE_ID.test(r.key)) { dropped.bad++; continue; }
                out.push(r);
                continue;
            }
            if (store === 'messages') {
                if (r.sessionId && !this.SAFE_ID.test(String(r.sessionId))) { dropped.bad++; continue; }
                out.push(r);
                continue;
            }
            if (typeof r.id !== 'string' || !this.SAFE_ID.test(r.id)) { dropped.bad++; continue; }
            out.push(r);
        }
        return { records: out, dropped };
    },

    async importAll(backup) {
        const database = await this.open();
        const stores = backup && backup.stores ? backup.stores : backup || {};
        const total = { imported: 0, dropped: 0, droppedModel: 0, droppedSync: 0 };
        // 导入会清空 settings 整表。这些键描述的是「这台设备」，不是书的内容，
        // 必须原样保留：否则导一次备份，Key、同步地址、听到第几句、回滚点全没了。
        const LOCAL_KEYS = ['modelConfig', 'syncConfig', 'syncMeta', 'preSyncBackup',
                            'deviceId', 'listenPos', 'lastBackupAt', 'backupRemindLaterAt'];
        const localSettings = [];
        for (const key of LOCAL_KEYS) {
            const rec = await this.get('settings', key);
            if (rec) localSettings.push(rec);
        }

        for (const store of this.STORES) {
            if (!database.objectStoreNames.contains(store)) continue;
            const records = stores[store];
            if (!Array.isArray(records)) continue;

            const { records: prepared, dropped } = this.sanitizeImport(store, records);
            total.imported += prepared.length;
            total.dropped += dropped.bad;
            total.droppedModel += dropped.modelConfig;
            total.droppedSync += dropped.syncConfig || 0;

            // 先写临时校验再清空：逐条 put 前已经筛过，避免「清空到一半失败」后新旧都没了
            const tx = database.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            await new Promise((resolve, reject) => {
                os.clear();
                try {
                    prepared.forEach(r => os.put(r));
                    // 本机专属设置补回去（含 Key、同步配置、回滚点）
                    if (store === 'settings') localSettings.forEach(rec => os.put(rec));
                } catch (e) { reject(e); return; }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('写入被中止'));
            });
        }
        return total;
    }
};

// ===== Settings Manager =====
const settings = {
    async get(key, defaultValue = null) {
        const record = await db.get('settings', key);
        return record ? record.value : defaultValue;
    },
    async set(key, value) {
        await db.put('settings', { key, value, updated: Date.now() });
    },
    async getModelConfig() {
        return await this.get('modelConfig', {
            provider: 'deepseek',
            model: 'deepseek-chat',
            apiKey: '',
            baseUrl: 'https://api.deepseek.com'
        });
    },
    async setModelConfig(config) {
        await this.set('modelConfig', config);
    },
    async getRunConfig() {
        return await this.get('runConfig', {
            temperature: 0.7,
            contextWindow: 8192,
            maxOutput: 4000,
            autoCompress: false,
            systemPrompt: ''
        });
    },
    async setRunConfig(config) {
        await this.set('runConfig', config);
    }
};

// ===== 分层上下文组装（v2.8.0）=====
// 长篇小说最大的失败点是「写着写着失忆 / 设定漂移」。这里按同类项目的分层记忆思路组装上下文：
// 上一章给全文（保证语气与情节衔接），更早的章节只给摘要；设定按关键词命中注入，避免整包塞满上下文。
const CONTEXT_BUDGET = {
    recentFull: 2600,     // 上一章正文最大字符
    olderSummary: 700,    // 无摘要的旧章节回退摘要长度
    maxChars: 16000       // 总字数预算（超出从尾部截断）
};

function clipText(text, max) {
    if (!text) return '';
    const t = String(text);
    return t.length > max ? t.slice(0, max) + '…' : t;
}

function findOutlineChapter(node, chapterNum) {
    if (!node || !Array.isArray(node.children)) return null;
    for (const child of node.children) {
        if (child.chapterNum === chapterNum) return child;
        const found = findOutlineChapter(child, chapterNum);
        if (found) return found;
    }
    return null;
}

// 大纲扁平化：兼容旧版扁数组 [{chapter,title,summary}] 与树形大纲（saveOutline 存的是树）
function getFlatOutlineItems(novel) {
    if (!novel) return [];
    if (Array.isArray(novel.outline)) return novel.outline;
    if (novel.outline && Array.isArray(novel.outline.children)) {
        const items = [];
        const walk = (node) => {
            for (const c of (node.children || [])) {
                if (c && (c.type === 'chapter' || c.chapterNum !== undefined) && c.type !== 'note') {
                    items.push({
                        chapter: c.chapterNum || (items.length + 1),
                        title: c.title || '',
                        summary: c.summary || ''
                    });
                }
                if (c && Array.isArray(c.children) && c.children.length) walk(c);
            }
        };
        walk(novel.outline);
        return items;
    }
    return [];
}

function formatCharBrief(c) {    const parts = [`【${c.name}】`];
    if (c.personality) parts.push(`性格：${c.personality}`);
    if (c.appearance) parts.push(`外貌：${c.appearance}`);
    if (c.catchphrase) parts.push(`口头禅：${c.catchphrase}`);
    if (c.currentStatus) parts.push(`当前状态：${c.currentStatus}`);
    if (c.arc) parts.push(`人物弧光：${c.arc}`);
    return parts.join('\n');
}

async function buildLayeredContext(novelId, chapterNum, hintText = '') {
    const parts = [];
    const stats = {};
    const novel = await novelManager.get(novelId);
    if (!novel) return { text: '', stats };

    const allChapters = await novelManager.listChapters(novelId);
    const sorted = allChapters.slice().sort((a, b) => a.number - b.number);
    const prev = sorted.filter(c => c.number < chapterNum).slice(-3);
    const last = prev[prev.length - 1];
    const older = prev.slice(0, -1);

    // 1) 本章大纲
    try {
        const outline = await novelManager.getOutline(novelId);
        const node = findOutlineChapter(outline, chapterNum);
        if (node) {
            parts.push(`【本章大纲】${node.title}：${node.summary || '（暂无细纲）'}`);
            stats.outline = true;
        }
    } catch (e) { /* 大纲缺失时跳过 */ }

    // 2) 本章场景卡（视角/目标/冲突/结果，对标 yWriter 场景卡片）
    try {
        const scene = await novelManager.getChapterScene(novelId, chapterNum);
        if (scene && (scene.pov || scene.goal || scene.conflict || scene.outcome)) {
            parts.push(`【本章场景卡】\n视角人物：${scene.pov || '未指定'}\n本章目标：${scene.goal || '未指定'}\n核心冲突：${scene.conflict || '未指定'}\n章末结果/转折：${scene.outcome || '未指定'}`);
            stats.scene = true;
        }
    } catch (e) { /* 场景卡缺失时跳过 */ }

    // 3) 本章节拍
    try {
        const beats = await novelManager.getBeats(novelId, chapterNum);
        if (beats.length) {
            parts.push('【本章节拍（按顺序推进）】\n' + beats.map((b, i) => `${i + 1}. ${b.title || b.content || b}`).join('\n'));
            stats.beats = beats.length;
        }
    } catch (e) { /* 忽略 */ }

    // 3) 伏笔债务：优先提醒已逾期的
    try {
        const fsList = await novelManager.listForeshadowing(novelId);
        const pending = fsList.filter(f => f.status !== 'harvested');
        if (pending.length) {
            const scored = pending.map(f => ({
                ...f,
                overdue: (f.targetChapter || 1) < chapterNum,
                dist: Math.abs((f.targetChapter || 1) - chapterNum)
            })).sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0) || a.dist - b.dist).slice(0, 8);
            parts.push('【待处理伏笔（本章应推进或回收，不要新增无关支线）】\n' + scored.map(f => {
                const over = (f.targetChapter || 1) < chapterNum ? `，已逾期 ${chapterNum - (f.targetChapter || 1)} 章` : '';
                return `- 第${f.plantChapter || 1}章埋设：${f.description}（计划第${f.targetChapter || 1}章回收${over}）`;
            }).join('\n'));
            stats.foreshadowing = scored.length;
        }
    } catch (e) { /* 忽略 */ }

    // 4) 上文：上一章全文（截断）+ 更早章节摘要
    if (last) {
        parts.push(`【上一章 第${last.number}章 ${last.title}（衔接基准）】\n${clipText(last.content, CONTEXT_BUDGET.recentFull)}`);
    }
    if (older.length) {
        parts.push('【更早章节回顾】\n' + older.map(c =>
            `第${c.number}章 ${c.title}：${c.summary || clipText(c.content, CONTEXT_BUDGET.olderSummary)}`
        ).join('\n'));
        stats.olderChapters = older.length;
    }

    // 5) 角色卡：本章关联 > 正文/提示词命中名字 > 兜底前 5
    const refText = `${hintText || ''}\n${last ? last.content : ''}`.slice(0, 5000);
    let chars = [];
    try { chars = await novelManager.listCharacters(novelId); } catch (e) { chars = []; }
    if (chars.length) {
        let picked = [];
        const linked = last && last.characters ? chars.filter(c => last.characters.includes(c.id)) : [];
        if (linked.length) picked = linked;
        else {
            const hit = chars.filter(c => c.name && refText.includes(c.name));
            picked = hit.length ? hit : chars.slice(0, 5);
        }
        if (picked.length) {
            parts.push('【相关角色卡（必须严格遵照性格、口头禅与当前状态）】\n' + picked.slice(0, 6).map(formatCharBrief).join('\n\n'));
            stats.characters = picked.length;
        }
    }

    // 6) 世界观：关键词命中优先
    // 注意：查资料沉淀的条目也存在 worldbuilding 里（category=research），
    // 这里必须排除，否则会被当成「设定」注入，语气和权重都不对。
    let wbItems = [];
    try { wbItems = await novelManager.listWorldbuilding(novelId); } catch (e) { wbItems = []; }
    const researchItems = wbItems.filter(w => w && w.category === 'research');
    wbItems = wbItems.filter(w => w && w.category !== 'research');
    if (wbItems.length) {
        const matched = wbItems.filter(w => (w.title && refText.includes(w.title)) ||
            (Array.isArray(w.keywords) && w.keywords.some(k => k && refText.includes(k))));
        const chosen = (matched.length ? matched : wbItems.slice(0, 4)).slice(0, 6);
        parts.push('【相关世界观设定（不得违反）】\n' + chosen.map(w =>
            `- ${w.title}：${clipText(w.content || w.description || '', 400)}`
        ).join('\n'));
        stats.worldbuilding = chosen.length;
    }

    // 7) 参考资料：只注入本章真正提到的（查资料的成果）
    // 用 BM25 排序（research.js 提供），比「包含关键词」稳得多；
    // 资料模块没加载时退回字面匹配，保证主流程不被拖死。
    if (researchItems.length) {
        let hitRefs = [];
        if (typeof researchRank === 'function') {
            hitRefs = researchRank(refText, researchItems, 4);
        } else {
            hitRefs = researchItems.filter(r => {
                const keys = Array.isArray(r.keywords) ? r.keywords : [];
                return (r.title && refText.includes(r.title)) ||
                    keys.some(k => k && k.length >= 2 && refText.includes(k));
            }).slice(0, 4);
        }
        if (hitRefs.length) {
            parts.push('【参考资料（事实性依据，写到相关情节以这里为准，不要自行编造）】\n' +
                hitRefs.map((r, i) => `[${i + 1}] ${r.title}\n${clipText(r.content || '', 300)}`).join('\n'));
            stats.research = hitRefs.length;
        }
    }

    let text = parts.join('\n\n');
    if (text.length > CONTEXT_BUDGET.maxChars) {
        text = text.slice(0, CONTEXT_BUDGET.maxChars) + '\n…（上下文已按预算截断）';
    }
    stats.chars = text.length;
    return { text, stats };
}

// ===== AI API Client =====
// 空闲超时：不是总时长，而是「等不到下一段数据」的上限。长章节慢慢吐字不会被误杀，
// 真正卡住 120 秒才断。
const AI_IDLE_TIMEOUT = 120000;

const ai = {
    // opts.searchPayload：由「查资料」模块传入的服务端联网参数（如 enable_search / tools），
    // 不属于 OpenAI 标准字段，只有显式开启联网时才合并进去，避免影响普通请求。
    async chat(messages, onStream = null, maxTokens = null, signal = null, opts = {}) {
        const config = await settings.getModelConfig();
        if (!config.apiKey) {
            throw new Error('请先配置 API Key');
        }

        const url = config.baseUrl ? `${config.baseUrl}/chat/completions` : 'https://api.deepseek.com/chat/completions';

        // 应用运行参数配置（温度/上下文窗口/提示词）
        const runConfig = await settings.getRunConfig();
        let finalMessages = messages;
        if (runConfig.systemPrompt && !messages.some(m => m.role === 'system' && m.content === runConfig.systemPrompt)) {
            const sysIdx = finalMessages.findIndex(m => m.role === 'system');
            if (sysIdx >= 0) {
                finalMessages = [...finalMessages];
                finalMessages[sysIdx] = { role: 'system', content: runConfig.systemPrompt + '\n\n' + finalMessages[sysIdx].content };
            } else {
                finalMessages = [{ role: 'system', content: runConfig.systemPrompt }, ...finalMessages];
            }
        }
        // 自动压缩：按字符粗估 token（约 2 字符/token），超出上下文窗口时精简中间历史
        if (runConfig.autoCompress && runConfig.contextWindow > 0) {
            const totalChars = finalMessages.reduce((s, m) => s + (m.content || '').length, 0);
            if (totalChars / 2 > runConfig.contextWindow) {
                const head = finalMessages.slice(0, 1);       // 保留系统消息
                const tail = finalMessages.slice(-3);          // 保留最近 3 条
                const middle = finalMessages.slice(1, -3);
                if (middle.length > 0) {
                    const digest = middle.map(m => `${m.role}: ${(m.content || '').substring(0, 200)}...`).join('\n');
                    finalMessages = [...head,
                        { role: 'system', content: `[上下文自动压缩] 以下为较早对话的压缩摘要：\n${digest}` },
                        ...tail];
                }
            }
        }

        const body = {
            model: config.model || 'deepseek-chat',
            messages: finalMessages,
            stream: !!onStream,
            temperature: runConfig.temperature,
            max_tokens: maxTokens || runConfig.maxOutput
        };
        if (opts && opts.searchPayload) Object.assign(body, opts.searchPayload);

        // 超时保护。旧实现完全裸奔：服务商连接挂死时界面永远转圈，只能杀进程重开。
        // 这里用空闲超时 + 外部取消信号（用户点「停止」）合并成一个 controller。
        const ctrl = new AbortController();
        let watchdog = null;
        const armWatchdog = () => {
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, AI_IDLE_TIMEOUT);
        };
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} }, { once: true });
        }

        let response;
        armWatchdog();
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`
                },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
        } catch (e) {
            if (watchdog) { clearTimeout(watchdog); watchdog = null; }
            // 外部取消优先报「已取消」，别把用户主动停止说成超时
            if (signal && signal.aborted) throw new Error('已取消');
            if (ctrl.signal.aborted) throw new Error(`请求超时（${AI_IDLE_TIMEOUT / 1000} 秒无响应），请检查网络或 Base URL`);
            throw new Error('网络请求失败：' + (e && e.message ? e.message : '未知错误'));
        }
        // 非流式到这里响应已完整，不用再等
        if (!onStream && watchdog) { clearTimeout(watchdog); watchdog = null; }

        if (!response.ok) {
            const raw = await response.text().catch(() => '');
            // 直接把响应体抛给用户，经常是一大段 JSON，看不出哪错了。先翻译成人话。
            let hint = '';
            if (response.status === 401) hint = 'API Key 无效或已过期，请到设置里重新填写';
            else if (response.status === 403) hint = '没有权限：Key 受限、模型未开通或余额不足';
            else if (response.status === 404) hint = `接口地址可能不对：${url}`;
            else if (response.status === 429) hint = '请求太频繁或额度用尽，等一会儿再试';
            else if (response.status >= 500) hint = '模型服务端故障，稍后重试';
            throw new Error(`API 请求失败（${response.status}）${hint ? '：' + hint : ''}${raw ? '\n' + raw.slice(0, 200) : ''}`);
        }

        if (onStream && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let buffer = '';

            const handleLine = (line) => {
                line = line.trim();
                if (!line.startsWith('data:')) return;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') return;
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content || '';
                    if (content) {
                        fullContent += content;
                        onStream(content, fullContent);
                    }
                } catch (e) {
                    // 单行解析失败不该影响整段流
                }
            };

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    // 每收到一段就重新计时：只要模型还在吐字，就不会被超时打断
                    armWatchdog();

                    buffer += decoder.decode(value, { stream: true });

                    // 关键：按行消费，未闭合的半行留在 buffer 里等下一个数据包。
                    // 旧实现直接对每个 chunk 做 split，行被网络切开时两半都解析失败，正文整段丢失。
                    let idx;
                    while ((idx = buffer.indexOf('\n')) >= 0) {
                        handleLine(buffer.slice(0, idx));
                        buffer = buffer.slice(idx + 1);
                    }
                }
                if (buffer.trim()) handleLine(buffer);
                return fullContent;
            } catch (e) {
                if (signal && signal.aborted) throw new Error('已取消');
                if (ctrl.signal.aborted) throw new Error(`生成超时（${AI_IDLE_TIMEOUT / 1000} 秒没有新数据），已中断`);
                throw e;
            } finally {
                if (watchdog) { clearTimeout(watchdog); watchdog = null; }
            }
        } else {
            const data = await response.json();
            return data.choices?.[0]?.message?.content || '';
        }
    },

    async generateNovel(novelInfo) {
        const charContext = await buildCharacterContext(novelInfo.id, 1);
        const wbContext = await buildWorldbuildingContext(novelInfo.id);
        const prompt = `你是一个专业的小说写作助手。请根据以下信息生成一部小说的第一章：

小说名称：${novelInfo.title}
类型：${novelInfo.genre || '未指定'}
简介：${novelInfo.description || '暂无'}
${charContext ? '\n以下为已设定的角色卡（写作时必须严格遵照）：\n\n' + charContext + '\n' : ''}
${wbContext ? '\n以下为世界观设定（写作时必须严格遵守规则）：\n\n' + wbContext + '\n' : ''}

请生成：
1. 第一章的标题
2. 第一章的正文内容（2000-3000字）
3. 简要的故事大纲（3-5章）

请用中文写作，确保内容连贯、有吸引力。`;

        return await this.chat([
            { role: 'system', content: '你是一个专业的小说写作助手，擅长创作各种类型的小说。' },
            { role: 'user', content: prompt }
        ]);
    },

    async continueChapter(novelInfo, previousChapters, chapterNum, prompt, onStream = null, signal = null) {
        // v2.8.0：改用分层上下文（上一章全文 + 旧章摘要 + 按命中注入的设定 + 伏笔债务）
        // 旧实现把每一章都截取前 500 字拼进去，长篇时既丢失衔接又浪费 token。
        const layered = await buildLayeredContext(novelInfo.id, chapterNum, prompt || '');

        const userPrompt = `请为小说《${novelInfo.title}》生成第${chapterNum}章。

类型：${novelInfo.genre || '未指定'}
简介：${novelInfo.description || '暂无'}

${layered.text ? '===== 故事上下文（必须遵守，不得出现与之一致性冲突的内容）=====\n' + layered.text + '\n===== 上下文结束 =====\n' : ''}

写作要求：
${prompt || '延续上一章结尾的情节，保持人物性格与文风一致，推进主线并有记忆点'}

输出要求：
1. 第一行输出本章标题，格式固定为「第${chapterNum}章」（可后接标题文字）
2. 空一行后开始正文，篇幅 2000-3000 字
3. 不要输出任何与正文无关的说明、注释或写作思路`;

        const messages = [
            { role: 'system', content: `你是小说《${novelInfo.title}》的AI写作助手。保持文风一致，情节连贯，严格服从已给出的角色设定与世界规则。` },
            { role: 'user', content: userPrompt }
        ];
        // 供「查看完整提示词」使用
        this.lastMessages = messages;
        this.lastContextStats = layered.stats;
        return await this.chat(messages, onStream, null, signal);
    },

    // 生成章节摘要（供后续章节的上下文使用，避免长篇失忆）
    async summarizeChapter(novelId, chapterNum) {
        const chapter = await novelManager.getChapter(novelId, chapterNum);
        if (!chapter || !chapter.content) throw new Error('章节内容为空');
        const prompt = `请为下面这一章生成结构化摘要，供后续章节写作时快速回顾。

章节：第${chapterNum}章 ${chapter.title || ''}
正文：
${chapter.content.substring(0, 8000)}

请严格输出JSON（不要markdown代码块）：
{"summary": "200字以内的情节摘要", "events": ["关键事件1", "关键事件2"], "stateChanges": ["角色状态变化"], "openEnds": ["本章留下的悬念或未回收线索"]}`;

        const result = await this.chat([
            { role: 'system', content: '你是小说结构分析师，擅长提炼章节要点，输出严格JSON。' },
            { role: 'user', content: prompt }
        ], null, 1200);

        let data = null;
        try {
            const cleaned = result.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
            data = JSON.parse(cleaned);
        } catch (_) {
            const m = result.match(/\{[\s\S]*\}/);
            if (m) { try { data = JSON.parse(m[0]); } catch (_) {} }
        }
        if (!data || !data.summary) {
            // 解析失败时退化为本地截断摘要，保证上下文始终有东西可用
            data = { summary: chapter.content.substring(0, 200) + '…', events: [], stateChanges: [], openEnds: [] };
        }
        const text = [
            data.summary,
            (data.events || []).length ? '关键事件：' + data.events.join('；') : '',
            (data.stateChanges || []).length ? '状态变化：' + data.stateChanges.join('；') : '',
            (data.openEnds || []).length ? '未回收线索：' + data.openEnds.join('；') : ''
        ].filter(Boolean).join('\n');
        await novelManager.saveChapterSummary(novelId, chapterNum, text);
        return text;
    },

    // 拆书：把一段原文拆成可借鉴的结构与技巧（对标 MuMuAINovel 的拆书）
    async deconstruct(sourceText, focus = '') {
        const prompt = `你是一位资深网文编辑，擅长「拆书」：从成功作品中提炼结构与技巧，而不是复述剧情。

${focus ? `用户特别关注的拆解重点：${focus}\n` : ''}
待拆解的原文（节选）：
${sourceText}

请按以下结构输出 Markdown（每节 2-5 条，具体、可操作，避免空话）：

## 一、题材与核心卖点
## 二、开篇钩子（前300字如何抓人）
## 三、结构与节奏（章节功能、爽点/冲突分布、信息释放顺序）
## 四、人物塑造手法
## 五、可借鉴技巧清单
## 六、「如果我来写」同类书大纲骨架（5-8章）`;

        return await this.chat([
            { role: 'system', content: '你是资深网文编辑，擅长拆解成功作品的结构与技巧，输出结构化、可操作的 Markdown。' },
            { role: 'user', content: prompt }
        ], null, 4000);
    },

    // 全书「追读力」体检：以资深读者视角聚合全书，输出四维评分 + 债务清单
    async readerAudit(novel, chapters, foreshadowing) {
        const sorted = chapters.slice().sort((a, b) => a.number - b.number);
        if (sorted.length === 0) throw new Error('还没有章节，先让 AI 写几章');
        const totalWords = sorted.reduce((s, c) => s + (c.wordCount || 0), 0);
        const chapterDigest = sorted.map(c => {
            const s = c.summary || (c.content || '').substring(0, 80);
            return `第${c.number}章 ${c.title || ''}（${c.wordCount || 0}字）：${s}`;
        }).join('\n');
        const recent = sorted.slice(-2).map(c => `第${c.number}章 ${c.title || ''}：\n${(c.content || '').substring(0, 2000)}`).join('\n\n');
        const fsLines = (foreshadowing || []).length
            ? (foreshadowing).map(f => `第${f.plantChapter || 1}章埋「${f.description}」→ 计划第${f.targetChapter || 1}章回收（当前状态：${f.status || 'planted'}）`).join('\n')
            : '（无伏笔记录）';

        const prompt = `请你以资深网文读者的身份，对下面这部小说做一次「追读力」全书体检——模拟一路追更到最新的读者，诚实、挑剔。

书名：《${novel.title || '未命名'}》
类型：${novel.genre || '未指定'}
简介：${novel.description || '暂无'}
规模：${sorted.length}章 · ${totalWords.toLocaleString()}字

【章节脉络】
${chapterDigest.slice(0, 6000)}

【待处理伏笔】
${fsLines}

【最近两章正文（节选）】
${recent.slice(0, 4000)}

请只输出JSON（不要markdown代码块、不要其他文字）：
{
  "scores": { "hook": 0-10, "payoff": 0-10, "anticipation": 0-10, "prose": 0-10 },
  "debts": [
    { "type": "未兑现爽点|伏笔逾期|人设松动|节奏拖沓|期待落空", "detail": "具体问题，指出章节位置", "chapter": 章节号或0, "suggestion": "补救动作" }
  ],
  "highlights": ["做得好的地方，2-4条"],
  "verdict": "一句话总评：这本书的追读力处在什么水平、最该先补什么"
}`;

        return await this.chat([
            { role: 'system', content: '你是一位资深网文读者兼编辑，从追读体验角度体检全书。严格按JSON格式输出，不要其他文字。' },
            { role: 'user', content: prompt }
        ], null, 2500);
    },

    // 章末钩子检查：只看每章结尾几百字。
    // 不预测"追读率"（那是平台后台的数据，本地拿不到），只判断"这一段能不能让人点下一章"。
    async hookCheck(items) {
        if (!items || !items.length) return [];
        const list = items.map(it =>
            `【第${it.number}章${it.title ? ' ' + it.title : ''}】\n${it.tail}`
        ).join('\n\n---\n\n');

        const prompt = `下面是若干章小说的【结尾片段】。读者决定要不要点下一章，就看这几百字。

${list}

请逐章判断这个结尾能不能让人非点下一章不可，对每一章输出一个对象：
- "chapter": 章节号（数字）
- "score": 0-10 的整数，10 = 强烈想知道后面发生了什么，3 以下 = 这段结尾可以直接合上 App
- "type": 悬念 / 反转 / 危机 / 情绪 / 信息缺口 / 平淡
- "problem": 一句话说清问题；score >= 7 时写 "无"
- "fix": 一句话给出可执行的改法（加一句什么、删哪句、把哪个信息提前或押后），要具体到能照做

只输出 JSON 数组，不要解释，不要 markdown 代码块。`;

        const text = await this.chat([
            { role: 'system', content: '你是资深网文编辑，专看章节结尾的钩子。判断狠、建议具体，不说套话。' },
            { role: 'user', content: prompt }
        ], null, 3000);

        return parseHookJson(text, items);
    },

    async reviewChapter(chapterContent, novelInfo, chapterNum) {
        const charContext = chapterNum ? await buildCharacterContext(novelInfo.id, chapterNum) : '';
        const wbContext = chapterNum ? await buildWorldbuildingContext(novelInfo.id) : '';
        const prompt = `请对以下小说章节进行专业审稿：

小说：${novelInfo.title}
${charContext ? '\n角色设定（用于校验角色是否OOC）：\n' + charContext + '\n' : ''}
${wbContext ? '\n世界观设定（用于校验是否违反规则）：\n' + wbContext + '\n' : ''}
章节内容：
${chapterContent}

请从以下维度进行评价（每项满分10分）：
1. 情节连贯性
2. 人物塑造（是否与角色设定一致）
3. 文笔流畅度
4. 场景描写
5. 对话质量
${wbContext ? '6. 设定一致性（是否违反世界观规则）' : ''}

给出具体分数和修改建议。`;

        return await this.chat([
            { role: 'system', content: '你是一位资深小说编辑，擅长审稿和给出建设性意见。' },
            { role: 'user', content: prompt }
        ]);
    }
};

// ===== Novel Data Manager =====
const novelManager = {
    async list() {
        return await db.getAll('novels');
    },

    async get(novelId) {
        return await db.get('novels', novelId);
    },

    // 兼容部分页面使用的 getNovel 命名
    async getNovel(novelId) {
        return await db.get('novels', novelId);
    },

    // ===== 伏笔（v2.6.0 数据层，此前缺失导致伏笔页整条链路报错）=====
    async listForeshadowing(novelId) {
        const novel = await this.get(novelId);
        if (!novel || !Array.isArray(novel.foreshadowing)) return [];
        return novel.foreshadowing;
    },

    async getForeshadowing(foreshadowingId) {
        const novels = await this.list();
        for (const novel of novels) {
            const item = (novel.foreshadowing || []).find(f => f.id === foreshadowingId);
            if (item) return { ...item, novelId: novel.id };
        }
        return null;
    },

    async createForeshadowing(novelId, data) {
        const novel = await this.get(novelId);
        if (!novel) throw new Error('作品不存在');
        if (!Array.isArray(novel.foreshadowing)) novel.foreshadowing = [];
        const item = {
            id: `fs_${novelId}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            novelId,
            description: data.description || '',
            plantChapter: data.plantChapter || 1,
            targetChapter: data.targetChapter || 1,
            impact: data.impact || 'medium',
            status: data.status || 'planted',
            notes: data.notes || '',
            created: Date.now(),
            updated: Date.now()
        };
        novel.foreshadowing.push(item);
        novel.updated = Date.now();
        await db.put('novels', novel);
        return item;
    },

    async updateForeshadowing(foreshadowingId, data) {
        const found = await this.getForeshadowing(foreshadowingId);
        if (!found) throw new Error('伏笔不存在');
        const novel = await this.get(found.novelId);
        const idx = novel.foreshadowing.findIndex(f => f.id === foreshadowingId);
        if (idx < 0) throw new Error('伏笔不存在');
        novel.foreshadowing[idx] = {
            ...novel.foreshadowing[idx],
            ...data,
            updated: Date.now()
        };
        novel.updated = Date.now();
        await db.put('novels', novel);
        return novel.foreshadowing[idx];
    },

    async deleteForeshadowing(foreshadowingId) {
        const found = await this.getForeshadowing(foreshadowingId);
        if (!found) throw new Error('伏笔不存在');
        const novel = await this.get(found.novelId);
        novel.foreshadowing = (novel.foreshadowing || []).filter(f => f.id !== foreshadowingId);
        novel.updated = Date.now();
        await db.put('novels', novel);
        return true;
    },

    async create(title, description = '', genre = '') {
        const id = 'novel_' + Date.now();
        const novel = {
            id,
            title,
            description,
            genre,
            created: Date.now(),
            updated: Date.now(),
            wordCount: 0,
            chapterCount: 0
        };
        await db.put('novels', novel);
        return novel;
    },

    async update(novel) {
        novel.updated = Date.now();
        await db.put('novels', novel);
    },

    async delete(novelId) {
        const chapters = await this.listChapters(novelId);
        for (const ch of chapters) {
            await db.delete('chapters', ch.id);
            const versions = await this.listChapterVersions(novelId, ch.number);
            for (const v of versions) await db.delete('versions', v.id);
        }
        // 角色 / 世界观 / 参考资料 / 审稿记录都要一起清，否则删了书空间也不释放
        const characters = await db.getAll('characters', 'novelId', novelId);
        for (const c of characters) await db.delete('characters', c.id);

        const wbs = await db.getAll('worldbuilding', 'novelId', novelId);
        for (const w of wbs) await db.delete('worldbuilding', w.id);

        const reviews = await db.getAll('reviews');
        for (const r of reviews) {
            if (r && r.novelId === novelId) await db.delete('reviews', r.id);
        }

        await db.delete('novels', novelId);
    },

    async listChapters(novelId) {
        return await db.getAll('chapters', 'novelId', novelId);
    },

    async getChapter(novelId, chapterNum) {
        if (!novelId) return null;
        // 章节主键就是 `${novelId}_ch${number}`（见 saveChapter），直接按主键取，
        // 不用把整本书的章节拉出来再 find。旧实现是 O(n)，编辑长篇小说时
        // 每敲一次自动保存前的读、每次翻章都要扫全书。
        const direct = await db.get('chapters', `${novelId}_ch${chapterNum}`);
        if (direct) return direct;
        // 兜底：极早期版本可能存在 id 规则不同的老数据，扫一遍保证还能打开
        const chapters = await this.listChapters(novelId);
        return chapters.find(ch => ch.number === chapterNum);
    },

    async saveChapter(novelId, chapterNum, title, content, paragraphs = null, opts = {}) {
        const id = `${novelId}_ch${chapterNum}`;
        const existing = await db.get('chapters', id);
        // 覆盖前自动存档旧版本，AI 写崩或误改后可回滚。
        // 自动保存传 archive:false —— 否则每敲几下就多一份全文快照，很快把配额吃光。
        if (existing && existing.content && existing.content !== content && opts.archive !== false) {
            await this.archiveChapterVersion(existing);
        }
        const chapter = {
            id,
            novelId,
            number: chapterNum,
            title: title || `第${chapterNum}章`,
            content,
            wordCount: content.length,
            // 保留首次创建时间（旧代码每次保存都重写 created）
            created: existing && existing.created ? existing.created : Date.now(),
            updated: Date.now()
        };
        if (existing && existing.summary) chapter.summary = existing.summary;
        if (existing && existing.hook) chapter.hook = existing.hook;
        if (paragraphs !== null) {
            chapter.paragraphs = paragraphs;
        }
        await db.put('chapters', chapter);

        // 今日新增字数：自动保存会频繁调用，但每次只累加"比上次多了多少"，
        // 结果就是真实净增量；删字不计入（负数忽略）。
        const prevWords = existing ? (existing.wordCount || 0) : 0;
        const delta = content.length - prevWords;
        if (delta > 0) addTodayWords(delta).catch(() => {});

        // Update novel stats
        const novel = await this.get(novelId);
        if (novel) {
            const chapters = await this.listChapters(novelId);
            novel.chapterCount = chapters.length;
            novel.wordCount = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);
            novel.updated = Date.now();
            await db.put('novels', novel);
        }

        return chapter;
    },

    async deleteChapter(novelId, chapterNum) {
        const id = `${novelId}_ch${chapterNum}`;
        await db.delete('chapters', id);
        const versions = await this.listChapterVersions(novelId, chapterNum);
        for (const v of versions) await db.delete('versions', v.id);

        // 同步作品统计。删章以前只删记录，chapterCount / wordCount 还留着旧值，
        // 书架上的「共 N 章 · X 万字」会一直虚高，导入的旧稿删掉几章后尤其明显。
        const novel = await this.get(novelId);
        if (novel) {
            const chapters = await this.listChapters(novelId);
            novel.chapterCount = chapters.length;
            novel.wordCount = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);
            novel.updated = Date.now();
            await db.put('novels', novel);
        }
    },

    // ===== 分卷（v2.10.1）=====
    // 卷存在 novel.volumes 上，章节上用 volumeId 关联。
    // 不新开表：备份、删除、导入都会自动带上，不用改 DB_VERSION。
    async listVolumes(novelId) {
        const novel = await this.get(novelId);
        if (!novel || !Array.isArray(novel.volumes)) return [];
        return novel.volumes.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    },

    async createVolume(novelId, title) {
        const novel = await this.get(novelId);
        if (!novel) throw new Error('作品不存在');
        if (!Array.isArray(novel.volumes)) novel.volumes = [];
        const vol = {
            // 加随机后缀：连续两次 createVolume 可能落在同一毫秒，只靠时间戳会撞 id，
            // 撞了以后两卷渲染同一批章节，看起来像章节重复
            id: `vol_${novelId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title: (title || '').trim() || `第${novel.volumes.length + 1}卷`,
            order: novel.volumes.length,
            created: Date.now()
        };
        novel.volumes.push(vol);
        novel.updated = Date.now();
        await db.put('novels', novel);
        return vol;
    },

    async renameVolume(novelId, volumeId, title) {
        const novel = await this.get(novelId);
        if (!novel || !Array.isArray(novel.volumes)) throw new Error('作品不存在');
        const vol = novel.volumes.find(v => v.id === volumeId);
        if (!vol) throw new Error('卷不存在');
        vol.title = (title || '').trim() || vol.title;
        novel.updated = Date.now();
        await db.put('novels', novel);
        return vol;
    },

    // 删卷不删章：章节退回「未分卷」，避免误删正文
    async deleteVolume(novelId, volumeId) {
        const novel = await this.get(novelId);
        if (!novel || !Array.isArray(novel.volumes)) throw new Error('作品不存在');
        const chapters = await this.listChapters(novelId);
        for (const ch of chapters) {
            if (ch.volumeId === volumeId) {
                ch.volumeId = null;
                await db.put('chapters', ch);
            }
        }
        novel.volumes = novel.volumes.filter(v => v.id !== volumeId);
        novel.volumes.forEach((v, i) => { v.order = i; });
        novel.updated = Date.now();
        await db.put('novels', novel);
        return true;
    },

    async setChapterVolume(novelId, chapterNum, volumeId) {
        const chapter = await this.getChapter(novelId, chapterNum);
        if (!chapter) throw new Error('章节不存在');
        chapter.volumeId = volumeId || null;
        chapter.updated = Date.now();
        await db.put('chapters', chapter);
        return chapter;
    },

    // ===== 章节重排（v2.10.1）=====
    // 传入「旧章节号的新顺序」，例如 [3,1,2] 表示原第 3 章排到第一位。
    // 章节号就是主键的一部分，改号必须连带重映射所有引用，
    // 否则伏笔、节拍、版本历史、大纲节点会整体串位——这类问题不报错，只会静默错乱。
    async reorderChapters(novelId, orderedNumbers) {
        const database = await db.open();
        const all = await this.listChapters(novelId);
        if (!all.length) return false;
        if (orderedNumbers.length !== all.length) throw new Error('章节数量不一致，请刷新后重试');

        const byNum = {};
        all.forEach(c => { byNum[c.number] = c; });
        if (orderedNumbers.some(n => !byNum[n])) throw new Error('章节列表已变化，请刷新后重试');

        const map = {};                       // 旧号 -> 新号
        orderedNumbers.forEach((oldNum, i) => { map[oldNum] = i + 1; });
        if (!Object.keys(map).some(k => Number(k) !== map[k])) return false;   // 没变化

        // 1) 章节：先把新记录写进去，再删掉不再存在的旧主键
        const newIds = new Set();
        const records = orderedNumbers.map((oldNum, i) => {
            const ch = { ...byNum[oldNum] };
            ch.number = i + 1;
            ch.id = `${novelId}_ch${ch.number}`;
            newIds.add(ch.id);
            return ch;
        });
        const stale = all.filter(c => !newIds.has(c.id)).map(c => c.id);

        await new Promise((resolve, reject) => {
            const tx = database.transaction('chapters', 'readwrite');
            const os = tx.objectStore('chapters');
            try {
                records.forEach(r => os.put(r));
                stale.forEach(id => os.delete(id));
            } catch (e) { reject(e); return; }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        // 2) 版本历史：chapterNum 与 chapterId 一起改
        const versions = await db.getAll('versions');
        const movedVersions = versions.filter(v => v.novelId === novelId && map[v.chapterNum]);
        if (movedVersions.length) {
            await new Promise((resolve, reject) => {
                const tx = database.transaction('versions', 'readwrite');
                const os = tx.objectStore('versions');
                movedVersions.forEach(v => {
                    v.chapterNum = map[v.chapterNum];
                    v.chapterId = `${novelId}_ch${v.chapterNum}`;
                    os.put(v);
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        // 3) 挂在作品上的：节拍、伏笔、大纲节点
        const novel = await this.get(novelId);
        if (novel) {
            if (novel.beats && typeof novel.beats === 'object') {
                const nb = {};
                Object.keys(novel.beats).forEach(k => {
                    const n = Number(k);
                    nb[map[n] || n] = novel.beats[k];
                });
                novel.beats = nb;
            }
            if (Array.isArray(novel.foreshadowing)) {
                novel.foreshadowing.forEach(f => {
                    if (f.plantChapter && map[f.plantChapter]) f.plantChapter = map[f.plantChapter];
                    if (f.targetChapter && map[f.targetChapter]) f.targetChapter = map[f.targetChapter];
                });
            }
            const walk = (node) => {
                if (!node || typeof node !== 'object') return;
                if (node.chapterNum && map[node.chapterNum]) node.chapterNum = map[node.chapterNum];
                (node.children || []).forEach(walk);
            };
            if (Array.isArray(novel.outline)) novel.outline.forEach(walk);
            else if (novel.outline) walk(novel.outline);

            novel.updated = Date.now();
            await db.put('novels', novel);
        }

        // 4) 审稿记录里如果带章节号
        const reviews = await db.getAll('reviews');
        for (const r of reviews) {
            if (!r || r.novelId !== novelId) continue;
            let dirty = false;
            if (typeof r.chapter === 'number' && map[r.chapter]) { r.chapter = map[r.chapter]; dirty = true; }
            if (typeof r.chapterNum === 'number' && map[r.chapterNum]) { r.chapterNum = map[r.chapterNum]; dirty = true; }
            if (dirty) await db.put('reviews', r);
        }

        return true;
    },

    // ===== 章节版本历史（v2.8.0）=====
    async archiveChapterVersion(chapter) {
        const record = {
            id: `ver_${chapter.id}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
            chapterId: chapter.id,
            novelId: chapter.novelId,
            chapterNum: chapter.number,
            title: chapter.title || '',
            content: chapter.content || '',
            wordCount: chapter.wordCount || (chapter.content || '').length,
            source: chapter.lastEditor || 'manual',
            created: Date.now()
        };
        await db.put('versions', record);
        // 每章最多保留 20 份历史，超出丢弃最旧的
        const list = await this.listChapterVersions(chapter.novelId, chapter.number);
        if (list.length > 20) {
            for (const old of list.slice(20)) await db.delete('versions', old.id);
        }
        return record;
    },

    async listChapterVersions(novelId, chapterNum) {
        const chapterId = `${novelId}_ch${chapterNum}`;
        const all = await db.getAll('versions', 'chapterId', chapterId);
        return all.sort((a, b) => (b.created || 0) - (a.created || 0));
    },

    async restoreChapterVersion(versionId) {
        const version = await db.get('versions', versionId);
        if (!version) throw new Error('版本不存在');
        const chapter = await db.get('chapters', version.chapterId);
        // 回滚前先把当前内容也存档，回滚本身可再被撤销
        if (chapter && chapter.content) await this.archiveChapterVersion(chapter);
        await this.saveChapter(version.novelId, version.chapterNum, version.title, version.content);
        return true;
    },

    async saveChapterSummary(novelId, chapterNum, summary) {
        const chapter = await this.getChapter(novelId, chapterNum);
        if (!chapter) throw new Error('章节不存在');
        chapter.summary = summary;
        chapter.summaryUpdated = Date.now();
        chapter.updated = Date.now();
        await db.put('chapters', chapter);
        return chapter;
    },

    // 在大纲根部追加一条拆书/沉淀笔记（type: note）
    async addOutlineNote(novelId, title, summary) {
        let outline = await this.getOutline(novelId);
        if (!outline || outline.type !== 'root' || !Array.isArray(outline.children)) {
            outline = { id: 'root', type: 'root', title: '总纲', summary: '', children: [] };
        }
        const node = {
            id: makeId('note'),
            type: 'note',
            title: title || '拆书笔记',
            summary: summary || '',
            children: []
        };
        outline.children.push(node);
        await this.saveOutline(novelId, outline);
        return node;
    },

    // ===== 场景卡（v2.9.0，对标 yWriter/bibisco 场景卡片）=====
    async getChapterScene(novelId, chapterNum) {
        const chapter = await this.getChapter(novelId, chapterNum);
        return chapter ? (chapter.scene || null) : null;
    },

    async saveChapterScene(novelId, chapterNum, scene) {
        const chapter = await this.getChapter(novelId, chapterNum);
        if (!chapter) throw new Error('章节不存在');
        chapter.scene = {
            pov: (scene.pov || '').trim(),
            goal: (scene.goal || '').trim(),
            conflict: (scene.conflict || '').trim(),
            outcome: (scene.outcome || '').trim()
        };
        chapter.updated = Date.now();
        await db.put('chapters', chapter);
        return chapter;
    },

    async getStats() {
        const novels = await this.list();
        return {
            totalNovels: novels.length,
            totalChapters: novels.reduce((sum, n) => sum + (n.chapterCount || 0), 0),
            totalWords: novels.reduce((sum, n) => sum + (n.wordCount || 0), 0)
        };
    },

    // ===== Outline Evolution (v2.4.0) =====
    async getOutline(novelId) {
        const novel = await this.get(novelId);
        if (!novel) return null;
        // 兼容旧版 flat array → 包装为树
        const raw = novel.outline;
        if (Array.isArray(raw) && raw.length > 0 && raw[0].chapter !== undefined) {
            // 旧格式：flat array of {chapter, title, summary}
            return {
                id: 'root',
                type: 'root',
                title: novel.title,
                summary: novel.description || '',
                children: raw.map(o => ({
                    id: `ch_${o.chapter}`,
                    type: 'chapter',
                    chapterNum: o.chapter,
                    title: o.title || `第${o.chapter}章`,
                    summary: o.summary || '',
                    children: []
                }))
            };
        }
        // 新格式或空
        return raw || {
            id: 'root',
            type: 'root',
            title: novel.title,
            summary: novel.description || '',
            children: []
        };
    },

    async saveOutline(novelId, outline) {
        const novel = await this.get(novelId);
        if (!novel) throw new Error('作品不存在');
        novel.outline = outline;
        novel.updated = Date.now();
        await db.put('novels', novel);
    },

    async getBeats(novelId, chapterNum) {
        const novel = await this.get(novelId);
        if (!novel || !novel.beats) return [];
        return novel.beats[chapterNum] || [];
    },

    async saveBeats(novelId, chapterNum, beats) {
        const novel = await this.get(novelId);
        if (!novel) throw new Error('作品不存在');
        if (!novel.beats) novel.beats = {};
        novel.beats[chapterNum] = beats;
        novel.updated = Date.now();
        await db.put('novels', novel);
    },

    async getPlotBranches(novelId) {
        const novel = await this.get(novelId);
        return novel ? (novel.plotBranches || []) : [];
    },

    async savePlotBranches(novelId, branches) {
        const novel = await this.get(novelId);
        if (!novel) throw new Error('作品不存在');
        novel.plotBranches = branches;
        novel.updated = Date.now();
        await db.put('novels', novel);
    },

    // ===== Character Card Manager (v2.4.0) =====
    async listCharacters(novelId) {
        return await db.getAll('characters', 'novelId', novelId);
    },

    async getCharacter(charId) {
        return await db.get('characters', charId);
    },

    async createCharacter(novelId, data) {
        const id = makeId(`char_${novelId}`);
        const char = {
            id,
            novelId,
            name: data.name || '',
            avatar: data.avatar || '',
            tags: data.tags || [],
            age: data.age || '',
            appearance: data.appearance || '',
            personality: data.personality || '',
            backstory: data.backstory || '',
            catchphrase: data.catchphrase || '',
            currentStatus: data.currentStatus || '',
            relationships: data.relationships || [],
            arc: data.arc || '',
            created: Date.now(),
            updated: Date.now()
        };
        await db.put('characters', char);
        return char;
    },

    async updateCharacter(charId, data) {
        const char = await this.getCharacter(charId);
        if (!char) throw new Error('角色不存在');
        Object.assign(char, data, { updated: Date.now() });
        await db.put('characters', char);
        return char;
    },

    async deleteCharacter(charId) {
        await db.delete('characters', charId);
    },

    async getChapterCharacters(novelId, chapterNum) {
        const chapter = await this.getChapter(novelId, chapterNum);
        return chapter && chapter.characters ? chapter.characters : [];
    },

    async setChapterCharacters(novelId, chapterNum, charIds) {
        const chapter = await this.getChapter(novelId, chapterNum);
        if (chapter) {
            chapter.characters = charIds;
            chapter.updated = Date.now();
            await db.put('chapters', chapter);
        }
    },

    async autoLinkCharacters(novelId, chapterNum) {
        const chapter = await this.getChapter(novelId, chapterNum);
        if (!chapter) return [];
        const chars = await this.listCharacters(novelId);
        const linked = [];
        for (const char of chars) {
            if (char.name && chapter.content && chapter.content.includes(char.name)) {
                linked.push(char.id);
            }
        }
        if (linked.length > 0) {
            await this.setChapterCharacters(novelId, chapterNum, linked);
        }
        return linked;
    },

    // ===== Worldbuilding Manager (v2.5.0) =====
    async listWorldbuilding(novelId, category = null) {
        const items = await db.getAll('worldbuilding', 'novelId', novelId);
        return category ? items.filter(i => i.category === category) : items;
    },

    async getWorldbuilding(id) {
        return await db.get('worldbuilding', id);
    },

    async createWorldbuilding(novelId, data) {
        const id = makeId(`wb_${novelId}`);
        const item = {
            id, novelId,
            category: data.category || 'other',
            title: data.title || '',
            content: data.content || '',
            rules: data.rules || '',
            created: Date.now(),
            updated: Date.now()
        };
        await db.put('worldbuilding', item);
        return item;
    },

    async updateWorldbuilding(id, data) {
        const item = await this.getWorldbuilding(id);
        if (!item) throw new Error('设定不存在');
        Object.assign(item, data, { updated: Date.now() });
        await db.put('worldbuilding', item);
        return item;
    },

    async deleteWorldbuilding(id) {
        await db.delete('worldbuilding', id);
    }
};

// ===== UI Helpers =====
const ui = {
    showToast(message, duration = 2500) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    },

    showLoading(container) {
        container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    },

    showEmptyState(container, { icon = '📚', title = '暂无内容', desc = '点击添加按钮开始创作' }) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${icon}</div>
                <div class="empty-title">${title}</div>
                <div class="empty-desc">${desc}</div>
            </div>`;
    },

    setPageTitle(title) {
        document.getElementById('page-title').textContent = title;
    },

    setHeaderActions(html = '') {
        document.getElementById('header-actions').innerHTML = html;
    }
};

// ===== Page Navigation =====
let pageHistory = [];
let __suppressHistoryPush = false;   // 返回操作本身不再入栈

function navigateTo(page, params = {}, isRootTab = false) {
    // 离开编辑器时退出专注，否则回来还是全屏状态
    if (store.currentPage === 'chapterEdit' && page !== 'chapterEdit') {
        toggleFocusMode(false);
    }

    // 离开听稿页要停止朗读，否则切走了还在念
    if (store.currentPage === 'listen' && page !== 'listen' && typeof listenStop === 'function') {
        listenStop();
        if (typeof keepScreenAwake === 'function') keepScreenAwake(false);
    }

    // 离开编辑器前先把未落盘的内容存下来（只触发一次，随后清空引用）
    if (__editorFlush) {
        const f = __editorFlush;
        __editorFlush = null;
        try { f(); } catch (e) { /* 保存失败已在界面上提示 */ }
    }

    if (!isRootTab && !__suppressHistoryPush) {
        // 连参数一起存，否则返回详情页会丢 novelId 变成白屏
        pageHistory.push({ page: store.currentPage, params: store.currentParams || {} });
    } else if (isRootTab) {
        pageHistory = [];
    }
    __suppressHistoryPush = false;

    store.currentPage = page;
    store.currentParams = params;
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });
    document.querySelectorAll('.page-view').forEach(view => view.classList.remove('active'));

    const mainContent = document.getElementById('main-content');
    let view = document.getElementById(`page-${page}`);
    if (!view) {
        view = document.createElement('div');
        view.id = `page-${page}`;
        view.className = 'page-view active';
        mainContent.appendChild(view);
    } else {
        view.classList.add('active');
    }

    // 注意：所有渲染函数第一个参数都是页面容器 view。
    // 旧代码这里大量漏传 view，导致 container/novelId 参数错位，页面拿不到作品数据而崩溃或空屏。
    const renderers = {
        bookshelf: renderBookshelf,
        writing: renderWriting,
        settings: renderSettings,
        novelDetail: (view) => renderNovelDetail(view, params.novelId),
        chapterEdit: (view) => renderChapterEdit(view, params.novelId, params.chapterNum),
        about: renderAbout,
        chat: renderChat,
        // 技能中心
        skillCenter: renderSkillCenter,
        skillDetail: (view) => renderSkillDetail(view, params.skillId),
        skillUse: (view) => renderSkillUse(view, params.skillId, params.mode),
        skillHistory: renderSkillHistory,
        // Skill 广场
        skillPlaza: renderSkillPlaza,
        // 蒸馏
        distill: renderDistill,
        distillTemplates: renderDistillTemplates,
        distillResult: (view) => renderDistillResult(view, params.templateId),
        distillWrite: (view) => renderDistillWrite(view, params.templateId),
        // 参数配置
        paramConfig: renderParamConfig,
        // 数据管理
        dataManage: renderDataManage,
        // 查资料（联网检索 → 资料库 → 写作上下文）
        research: renderResearch,
        // 大纲编辑器
        outlineEditor: (view) => renderOutlineEditor(view, params.novelId),
        // 情节推演
        plotSimulate: (view) => renderPlotSimulate(view, params.novelId),
        // 章节排序
        chapterSort: (view) => renderChapterSort(view, params.novelId),
        // 听稿校对
        listen: (view) => renderListen(view, params.novelId, params.chapterNum),
        // 多设备同步
        sync: renderSync,
        // 节拍控制
        beatControl: (view) => renderBeatControl(view, params.novelId, params.chapterNum),
        // 角色卡
        characterCards: (view) => renderCharacterCards(view, params.novelId),
        characterEdit: (view) => renderCharacterEdit(view, params.novelId, params.characterId),
        // 世界观
        worldview: (view) => renderWorldView(view, params.novelId),
        worldviewEdit: (view) => renderWorldviewEdit(view, params.novelId, params.worldviewId),
        // 分段编辑（自身按 page id 取容器）
        paragraphEdit: () => renderParagraphEdit(params.novelId, params.chapterNum),
        // 多Agent协作
        agentStudio: (view) => renderAgentStudio(view, params.novelId),
        // 一致性检查
        consistencyCheck: (view) => renderConsistencyCheck(view, params.novelId),
        // 导出分发
        novelExport: (view) => renderNovelExport(view, params.novelId),
        // 伏笔追踪（此前未注册路由，点击菜单只会白屏）
        foreshadowing: (view) => renderForeshadowing(params.novelId, view),
        foreshadowingEdit: (view) => renderForeshadowingEdit(params.novelId, params.foreshadowingId, view)
    };

    if (renderers[page]) {
        renderers[page](view);
    } else {
        // 未注册的 page 名，旧代码只会创建一个空 div，用户看到的是整页白屏、
        // 也没有任何返回入口（只能杀进程重开）。这里给可读提示 + 返回按钮。
        ui.setPageTitle('页面不存在');
        view.innerHTML = `<div class="empty-state">
            <div class="empty-title">这个页面不存在</div>
            <div class="empty-desc">「${escapeHtml(String(page))}」可能已下线或链接不完整</div>
            <button class="btn btn-primary" style="margin-top:16px;" onclick="goBack()">返回上一页</button>
        </div>`;
    }
    stripButtonEmoji(view);
    window.scrollTo(0, 0);
}

// ===== Chat / Home Page =====
async function renderChat(container) {
    ui.setPageTitle('新对话');
    // 模型名以「模型配置」为准（曾硬编码 glm-5.1，与实际配置不一致）
    try {
        const modelConfig = await settings.getModelConfig();
        store.modelName = modelConfig.model || 'glm-5.1';
    } catch (e) { /* 读取失败时保留默认值 */ }
    // 竞品风格：无顶部操作按钮，模型名在标题下方显示
    ui.setHeaderActions(`
        <button class="hamburger-btn" onclick="openChatDrawer()">
            <span></span><span></span><span></span>
        </button>
    `);

    // 会话关联的作品：聊天补设定 → 沉淀入库 → AI 写作自动注入
    if (store.chatNovelId === undefined) {
        try { store.chatNovelId = localStorage.getItem('ow_chat_novel') || null; } catch (e) { store.chatNovelId = null; }
    }

    container.innerHTML = `
        <div style="padding: 0 16px; display: flex; flex-direction: column; height: calc(100vh - 120px); overflow-y: auto;">
            <!-- 顶部模型指示器 -->
            <div style="font-size: 13px; color: var(--text-tertiary); margin: 4px 0 12px;">${store.modelName}</div>

            <!-- 当前关联作品：AI 写作的设定都来自这里 -->
            <div class="chat-novel-ctx" id="chat-novel-ctx" onclick="showChatNovelPicker()"></div>

            <!-- 快捷工具胶囊行 -->
            <div class="chat-tool-row">
                <button class="chat-tool-pill" onclick="showMemo()"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>备忘录</button>
                <button class="chat-tool-pill" onclick="showNameGenerator()"><span class="tool-pill-icon" style="font-size:13px;font-weight:600;">T</span>起名</button>
                <button class="chat-tool-pill primary" onclick="navigateTo('distill')"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 3l9 16H3L12 3z"/><path d="M12 12v4"/></svg></span>蒸馏</button>
                <button class="chat-tool-pill" onclick="showDeconstruct()"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>拆解</button>
            </div>

            <!-- 中央 Logo 区域 -->
            <div class="chat-hero">
                <div class="chat-hero-logo"><svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--primary)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
                <div class="chat-hero-title">OpenWrite</div>
                <div class="chat-hero-subtitle">AI 执笔成文 · 你聊设定</div>
            </div>

            <!-- 操作卡片 -->
            <div class="chat-action-list">
                <div class="chat-action-card" onclick="createNovelWithAI()">
                    <div class="chat-action-icon"><svg viewBox="0 0 24 24" width="24" height="24" stroke="var(--primary)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></div>
                    <div class="chat-action-body">
                        <div class="chat-action-title">新书启航</div>
                        <div class="chat-action-desc">AI 对话式创建，只需输入类型和书名</div>
                    </div>
                    <span class="chat-action-arrow">›</span>
                </div>
                <div class="chat-action-card" onclick="continueWriting()">
                    <div class="chat-action-icon"><svg viewBox="0 0 24 24" width="24" height="24" stroke="#f59e0b" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg></div>
                    <div class="chat-action-body">
                        <div class="chat-action-title">继续写作</div>
                        <div class="chat-action-desc">继续上一次的对话</div>
                    </div>
                    <span class="chat-action-arrow">›</span>
                </div>
                <div class="chat-action-card" onclick="showTutorial()">
                    <div class="chat-action-icon"><svg viewBox="0 0 24 24" width="24" height="24" stroke="#ec4899" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></div>
                    <div class="chat-action-body">
                        <div class="chat-action-title">使用教程</div>
                        <div class="chat-action-desc">查看使用手册</div>
                    </div>
                    <span class="chat-action-arrow">›</span>
                </div>
            </div>

            <!-- 消息区域（默认隐藏，发送消息后显示） -->
            <div id="chat-messages" style="display:none; flex-direction: column; gap: 12px; margin-top: auto; padding-bottom: 16px;"></div>
        </div>

        <!-- 整合式底部输入区 -->
        <div class="chat-composer">
            <div class="composer-input-box">
                <textarea class="composer-textarea" id="chat-input" rows="1"
                          oninput="autoGrowInput(this)"
                          placeholder="和 AI 聊剧情、补设定，让它把正文写出来…"></textarea>
            </div>
            <div class="composer-toolbar">
                <button class="composer-btn composer-net" id="chat-websearch-btn" onclick="showWebSearch()">联网</button>
                <button class="composer-btn" onclick="openSkillPicker()">@ 技能</button>
                <button class="composer-btn" onclick="attachFile()"># 文件</button>
                <button class="composer-btn" onclick="showModelIndicator()">${ICON_GEAR} 默认</button>
                <button class="composer-btn" onclick="showMemory()">设定</button>
                <button class="composer-send" id="chat-send-btn" onclick="sendMessage()">➤</button>
            </div>
        </div>
    `;
    renderChatNovelCtx();
    syncComposerPadding();
}

// 输入框是 fixed 的，内容区要按它的真实高度留白，否则最后一条消息会被压住
// 输入框随内容长高，最多 5 行，超过就内部滚动
function autoGrowInput(el) {
    if (!el) return;
    el.style.height = 'auto';
    const max = 5 * 22 + 20;
    el.style.height = Math.min(el.scrollHeight, max) + 'px';
    syncComposerPadding();
}

function syncComposerPadding() {
    const page = document.getElementById('page-chat');
    if (!page) return;
    const composer = page.querySelector('.chat-composer');
    if (!composer) return;
    page.style.paddingBottom = (composer.offsetHeight + 14) + 'px';
}

// 渲染「当前关联作品」条：未关联 = 自由聊天；关联后 = 设定注入 + 可沉淀
async function renderChatNovelCtx() {
    const el = document.getElementById('chat-novel-ctx');
    if (!el) return;
    const novelId = store.chatNovelId;
    if (!novelId) {
        el.innerHTML = `<span class="cnc-dot"></span><span class="cnc-text">未关联作品 · 自由聊天（点此关联，AI 写作时自动带上设定）</span><span class="cnc-arrow">›</span>`;
        el.classList.remove('bound');
        return;
    }
    let novel = null;
    try { novel = await novelManager.get(novelId); } catch (e) { /* ignore */ }
    if (!novel) {
        store.chatNovelId = null;
        try { localStorage.removeItem('ow_chat_novel'); } catch (e) { /* ignore */ }
        renderChatNovelCtx();
        return;
    }
    const chars = await novelManager.listCharacters(novelId).catch(() => []);
    const wbs = await novelManager.listWorldbuilding(novelId).catch(() => []);
    el.innerHTML = `<span class="cnc-dot on"></span><span class="cnc-text">📖 《${escapeHtml(novel.title)}》 · 角色 ${chars.length} · 设定 ${wbs.length}（聊天中可一键沉淀）</span><span class="cnc-arrow">›</span>`;
    el.classList.add('bound');
}

async function showChatNovelPicker() {
    const novels = await novelManager.list();
    const options = novels.map(n => `
        <div class="skill-pick-item" onclick="bindChatNovel('${n.id}')">
            <span>📖</span>
            <div style="flex:1;">
                <div style="font-weight:600;">${escapeHtml(n.title)}</div>
                <div style="font-size:12px;color:var(--text-secondary);">${n.chapterCount || 0}章 · ${(n.wordCount || 0).toLocaleString()}字</div>
            </div>
            ${store.chatNovelId === n.id ? '<span style="color:var(--primary);font-weight:700;">✓</span>' : '<span style="color:var(--text-secondary);">›</span>'}
        </div>`).join('');
    const modal = createModal('关联作品', `
        <div class="draft-hint">关联后：AI 聊天时自动带上本书的角色与设定；你在对话里补充的世界观、主角性格，可一键沉淀为设定，AI 写正文时自动遵守。</div>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:56vh;overflow-y:auto;margin-top:10px;">
            <div class="skill-pick-item" onclick="bindChatNovel('')">
                <span>💬</span>
                <div style="flex:1;"><div style="font-weight:600;">不关联（自由聊天）</div>
                <div style="font-size:12px;color:var(--text-secondary);">只聊构思，不写入任何作品的设定</div></div>
                ${!store.chatNovelId ? '<span style="color:var(--primary);font-weight:700;">✓</span>' : ''}
            </div>
            ${options || '<div class="empty-state"><div class="empty-title">还没有作品</div></div>'}
        </div>`);
    modal.show();
}

async function bindChatNovel(novelId) {
    store.chatNovelId = novelId || null;
    try {
        if (novelId) localStorage.setItem('ow_chat_novel', novelId);
        else localStorage.removeItem('ow_chat_novel');
    } catch (e) { /* ignore */ }
    closeModal();
    renderChatNovelCtx();
    if (novelId) {
        const novel = await novelManager.get(novelId);
        ui.showToast(`已关联《${novel ? novel.title : ''}》，聊天和写作都会带上它的设定`);
    } else {
        ui.showToast('已取消关联，进入自由聊天');
    }
}

// 组装关联作品的设定包（注入聊天 systemPrompt，让 AI 聊设定时心里有数）
async function buildChatNovelContext(novelId) {
    if (!novelId) return '';
    try {
        const novel = await novelManager.get(novelId);
        if (!novel) return '';
        const lines = [`【当前作品】《${novel.title}》｜类型：${novel.genre || '未指定'}｜${novel.description || ''}`];
        const chars = await novelManager.listCharacters(novelId);
        if (chars.length) {
            lines.push('【已建档角色（不得与之矛盾）】\n' + chars.slice(0, 10).map(formatCharBrief).join('\n'));
        }
        const wbs = await novelManager.listWorldbuilding(novelId);
        if (wbs.length) {
            lines.push('【已建档世界观（不得违反）】\n' + wbs.slice(0, 8).map(w => `- ${w.title}：${(w.content || '').slice(0, 200)}`).join('\n'));
        }
        const chapters = await novelManager.listChapters(novelId);
        const sorted = chapters.slice().sort((a, b) => a.number - b.number);
        if (sorted.length) {
            const recent = sorted.slice(-3).map(c => `第${c.number}章 ${c.title}${c.summary ? '：' + c.summary.slice(0, 120) : ''}`).join('\n');
            lines.push(`【最新进度（已写 ${sorted.length} 章）】\n${recent}`);
        }
        return lines.join('\n\n');
    } catch (e) {
        return '';
    }
}

// 底部工具栏用 SVG：部分安卓机没有彩色 emoji 字体，🧠 🎲 会渲染成空心方块
const _ic = (d, size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">${d}</svg>`;
const ICON_GEAR = _ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>');
const ICON_BOOK = _ic('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 18.5V5.5"/>');
const ICON_DICE = _ic('<rect x="3" y="3" width="18" height="18" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>');

// ===== 聊天消息发送 =====
// v2.9.0：AI 主写手范式。
// - 关联作品后，systemPrompt 注入该书设定包，AI 聊设定/剧情时始终心里有数；
// - AI 给出的新设定用 :::setting 块输出，前端渲染成「可沉淀设定卡」，一键入库；
// - 入库后的角色/世界观会自动进入写作上下文（buildLayeredContext）。
// v2.15.0：从「AI 直接开写」改成「先把人立起来，再动笔」。
// 旧版第一句是"默认由你直接产出正文"，模型照做——用户只说"写小说"，
// 它就跳过全部设定直接输出正文，人物是它临时编的，作者没有代入感。
const CHAT_WRITER_PROMPT = `你是 OpenWrite 的写作搭档。写小说不是写文案：读者记住的永远是人，不是设定。所以你的工作分两步——先把人和世界立起来，再动笔。

【什么时候还不能写】
下面这些没弄清楚之前，不要写正文：
· 主角是谁（名字、身份、眼下处境）
· 主角想要什么，或被什么困住
· 故事的世界有什么特别的规矩（类型已经暗示的部分够用，就不必再问）

【怎么问】
· 一次只问一个问题，问最要紧的那个。不要列 1/2/3 清单，不要把三四个问题塞进同一段话。
· 问完就停，等对方回答。不要自问自答。
· 每个问题顺带给两三个具体选项，让对方好接话。比如"他是刚入行的新人，还是干了十年的老手？"
· 对方说"你定""随便""看着办"，就直接给一个具体方案，让他只需点头或摇头，别再反问。
· 语气像同行聊天，不像表单填写。

【什么时候可以写】
· 上面三条都清楚了：先用两三句话复述你理解的故事（谁、要什么、卡在哪），问一句"是这么回事吗"，确认之后再写。
· 对方明确说"直接写""别问了""先来一段"：立刻写，不要再问。缺的细节你自己补，写完用一句说明你替他定了什么。
· 已经关联作品、角色和世界观也已建档：直接用档案写，不要重复问。

【写的时候】
· 直接从第一句正文开始，不要"以下是正文"这类前言，不要小标题。
· 默认 1500-2500 字，段落之间空一行。
· 信息不足宁可写短，也不要编出与人设冲突的内容。

回答简洁、直接，有行动建议。`;

const SETTING_BLOCK_INSTRUCTION = `
【设定沉淀协议】当你在对话中提出或完善了新的世界观规则、角色性格/外貌/身份等设定时，除正常回答外，必须把该设定单独输出为一个块，格式严格如下（供用户一键存入设定库）：
:::setting{"type":"character","name":"设定名称"}
设定的具体内容，可多行
:::
type 只能是 character（角色）或 world（世界观）。name 填角色名或设定条目名。没有新设定时不要输出此块。`;

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    const messagesBox = document.getElementById('chat-messages');
    
    // 竞品风格：消息区域从隐藏切换为显示
    if (messagesBox) {
        messagesBox.style.display = 'flex';
    }

    // 隐藏首页内容（hero、卡片等），切换到对话模式
    const hero = document.querySelector('.chat-hero');
    const actionList = document.querySelector('.chat-action-list');
    if (hero) hero.style.display = 'none';
    if (actionList) actionList.style.display = 'none';

    // 用户消息（带 ⋮ 沉淀菜单）
    const userMsg = document.createElement('div');
    userMsg.className = 'msg-row user';
    userMsg.innerHTML = `<div class="msg-bubble user">${escapeHtml(text)}</div><button class="msg-more" onclick="showSinkMenu(this)" data-text="${escapeHtml(text).replace(/"/g, '&quot;')}" title="沉淀为设定">⋮</button>`;
    messagesBox.appendChild(userMsg);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    // AI 思考中
    const aiLoading = document.createElement('div');
    aiLoading.className = 'msg-row ai';
    aiLoading.innerHTML = `<div class="msg-bubble ai loading">AI 思考中<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    messagesBox.appendChild(aiLoading);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    // 判定是否带技能上下文
    let systemPrompt = CHAT_WRITER_PROMPT;
    const activeSkill = store.activeChatSkill;
    if (activeSkill) {
        const skill = await skillManager.get(activeSkill);
        if (skill && skill.enabled) {
            systemPrompt = `你是资深中文小说编辑，正在使用技能《${skill.name}》辅助创作。以下是技能规则，请按规则处理用户需求：\n\n${skill.content}\n\n请按技能要求给出专业回答。`;
        }
    }

    // 关联作品 → 注入设定包 + 设定沉淀协议
    if (store.chatNovelId) {
        const novelCtx = await buildChatNovelContext(store.chatNovelId);
        if (novelCtx) systemPrompt += `\n\n${novelCtx}\n\n${SETTING_BLOCK_INSTRUCTION}`;
    }

    // 联网：先检索，再把这批资料作为「事实依据」塞进系统提示。
    // 检索失败不阻断对话——用户要的是回答，不是一句报错。
    // 续写类短指令（继续 / 好的 / 嗯）拿去搜网只会搜回噪音，还白花一次搜索钱，直接跳过。
    const isContinuation = /^(继续(写|吧)?|接着(写|来)?|好(的|吧)?|嗯|可以|谢谢|再来(一段|一章)?|下一段|下一章|往下写|就这样)[吧呢啊呀。！!，,～~…\s]*$/.test(text.trim());
    let webHits = [];
    if (store.webSearchOn && isContinuation) {
        ui.showToast('续写指令：跳过联网检索（省一次搜索）', 2500);
    } else if (store.webSearchOn) {
        aiLoading.innerHTML = `<div class="msg-bubble ai loading">正在联网检索…</div>`;
        messagesBox.scrollTop = messagesBox.scrollHeight;
        try {
            webHits = await researchSearch(text);
            if (webHits.length) {
                systemPrompt += buildWebContext(webHits);
                // 只统计成功返回内容的检索（DeepSeek 只对成功请求计费）
                store.searchCount = (store.searchCount || 0) + 1;
                renderWebSearchBtn();
            }
        } catch (e) {
            ui.showToast('联网检索失败，本条按普通对话回答：' + e.message, 4500);
        }
        aiLoading.innerHTML = `<div class="msg-bubble ai loading">AI 思考中<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    }

    try {
        let fullText = '';
        // 流式渲染节流：旧实现每个 chunk 都重写整块 innerHTML，一段 4 万字的回复
        // 会重排上千次（O(n²)），手机上直接卡死。这里 80ms 合并一次，
        // 最终版本由下面的完成渲染兜底，所以节流不会丢内容。
        let paintTimer = null;
        const paintStream = () => {
            paintTimer = null;
            if (!fullText) return;
            const parsed = parseSettingBlocks(fullText);
            aiLoading.innerHTML = `<div class="msg-bubble ai">${escapeHtml(parsed.clean).replace(/\n/g, '<br>')}</div>`;
            messagesBox.scrollTop = messagesBox.scrollHeight;
        };
        const response = await ai.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ], (chunk, full) => {
            fullText = full;
            // 排队中就不再追加定时器
            if (!paintTimer) paintTimer = setTimeout(paintStream, 80);
        }, 4000);

        // 关键：先取消还在排队的流式渲染，否则它可能在下面带设定卡的最终渲染之后执行，
        // 把卡片覆盖成纯文本。
        if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }

        if (!fullText) fullText = response;
        // 完成后：拆分正文与设定块，渲染可沉淀设定卡
        const finalParsed = parseSettingBlocks(fullText);
        window.__lastAiSettings = finalParsed.settings;
        const cardsHtml = finalParsed.settings.length
            ? `<div class="setting-cards">${finalParsed.settings.map((s, i) => renderSettingCard(s, i)).join('')}</div>`
            : '';
        aiLoading.innerHTML = `<div class="msg-bubble ai">${escapeHtml(finalParsed.clean).replace(/\n/g, '<br>')}</div>${cardsHtml}<button class="msg-more ai-more" onclick="showSinkMenu(this)" data-text="${escapeHtml(finalParsed.clean).replace(/"/g, '&quot;')}" title="沉淀为设定">⋮</button>`;
        // 来源单独插在消息行外面：msg-row 是 flex 行，塞进去会被挤到气泡右侧
        if (webHits.length) {
            const sites = webHits.slice(0, 3).map(h => escapeHtml(h.site || h.title || '来源')).join('、');
            aiLoading.insertAdjacentHTML('afterend',
                `<div class="web-src">已联网检索 ${webHits.length} 条：${sites}${webHits.length > 3 ? ' 等' : ''}</div>`);
        }

        // 保存消息（去掉设定块，保留干净正文）
        try {
            // 之前硬编码 'main'，导致「新对话」建出来的会话永远没有消息，抽屉里只剩一个
            const sid = store.currentSessionId || 'main';
            await db.put('messages', { sessionId: sid, role: 'user', content: text, created: Date.now() });
            await db.put('messages', { sessionId: sid, role: 'assistant', content: finalParsed.clean, created: Date.now() });
        } catch (e) { /* ignore */ }
    } catch (err) {
        aiLoading.innerHTML = `<div class="msg-bubble ai error">⚠️ ${escapeHtml(err.message)}</div>`;
    }
    messagesBox.scrollTop = messagesBox.scrollHeight;
}

// ===== 设定块解析与沉淀 =====
// 兼容 :::setting{"type":"character","name":"林渊"} ... ::: 形式
function parseSettingBlocks(text) {
    const raw = String(text || '');
    const settings = [];
    const re = /:::setting\s*(\{[\s\S]*?\})\s*\n?([\s\S]*?)\s*:::/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        let meta = {};
        try { meta = JSON.parse(m[1]); } catch (e) { meta = {}; }
        const content = (m[2] || '').trim();
        if (content) {
            settings.push({
                type: meta.type === 'world' ? 'world' : 'character',
                name: String(meta.name || '').trim() || '未命名设定',
                content
            });
        }
    }
    const clean = raw.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
    return { clean, settings };
}

function renderSettingCard(s, idx) {
    const typeLabel = s.type === 'world' ? '🌍 世界观' : '👤 角色';
    const sinkLabel = s.type === 'world' ? '存入世界观' : '存入角色卡';
    const bound = !!store.chatNovelId;
    return `
    <div class="setting-card" data-sink-idx="${idx}">
        <div class="setting-card-head">${typeLabel}「${escapeHtml(s.name)}」 · 可沉淀</div>
        <div class="setting-card-body">${escapeHtml(s.content).replace(/\n/g, '<br>')}</div>
        <div class="setting-card-actions">
            ${bound
                ? `<button class="btn btn-primary btn-sm" onclick="sinkParsedSetting(${idx})">${sinkLabel}</button>`
                : `<span class="setting-card-hint">关联作品后可存入角色卡 / 世界观</span>`}
            <button class="btn btn-outline btn-sm" onclick="sinkParsedSetting(${idx}, true)">存备忘录</button>
        </div>
    </div>`;
}

async function sinkParsedSetting(idx, asMemo = false) {
    const settings = window.__lastAiSettings || [];
    const s = settings[idx];
    if (!s) { ui.showToast('设定已失效，请重新生成'); return; }
    await sinkChatSetting(asMemo ? 'memo' : s.type, s.name, s.content);
}

// 通用沉淀：角色卡 / 世界观 / 备忘录（含同名合并）
async function sinkChatSetting(type, title, content) {
    const novelId = store.chatNovelId;
    const cleanContent = String(content || '').trim();
    if (!cleanContent) { ui.showToast('内容为空'); return; }
    try {
        if (type === 'character') {
            if (!novelId) { ui.showToast('请先关联作品'); return; }
            const chars = await novelManager.listCharacters(novelId);
            const dup = chars.find(c => c.name === title);
            if (dup) {
                if (!confirm(`已存在角色「${title}」，把这段内容追加到 TA 的档案里？`)) return;
                await novelManager.updateCharacter(dup.id, {
                    personality: ((dup.personality || '') + '\n' + cleanContent).trim()
                });
                ui.showToast(`已追加到角色「${title}」的档案`);
            } else {
                await novelManager.createCharacter(novelId, { name: title, personality: cleanContent, backstory: '' });
                ui.showToast(`已存入角色卡「${title}」，AI 写作时会自动参考`);
            }
            renderChatNovelCtx();
            return;
        }
        if (type === 'world') {
            if (!novelId) { ui.showToast('请先关联作品'); return; }
            const wbs = await novelManager.listWorldbuilding(novelId);
            const dup = wbs.find(w => w.title === title);
            if (dup) {
                if (!confirm(`已存在设定「${title}」，把这段内容追加进去？`)) return;
                await novelManager.updateWorldbuilding(dup.id, {
                    content: ((dup.content || '') + '\n' + cleanContent).trim()
                });
                ui.showToast(`已追加到设定「${title}」`);
            } else {
                await novelManager.createWorldbuilding(novelId, { category: 'other', title, content: cleanContent });
                ui.showToast(`已存入世界观「${title}」，AI 写作时会自动参考`);
            }
            renderChatNovelCtx();
            return;
        }
        // 备忘录
        await db.put('memos', {
            id: 'memo_' + Date.now(),
            title: title || '聊天沉淀',
            content: cleanContent,
            category: novelId ? 'inspiration' : 'default',
            created: Date.now(),
            updated: Date.now()
        });
        ui.showToast('已存入备忘录');
    } catch (e) {
        ui.showToast('沉淀失败: ' + e.message);
    }
}

// 消息 ⋮ 菜单：把任意一条聊天消息沉淀为设定
async function showSinkMenu(btn) {
    const raw = btn.dataset.text || '';
    const ta = document.createElement('textarea');
    ta.innerHTML = raw;
    const text = ta.value;
    if (!text.trim()) { ui.showToast('这条消息是空的'); return; }
    const bound = !!store.chatNovelId;
    const modal = createModal('沉淀这条消息', `
        <div class="draft-hint">把对话内容转成正式设定，之后 AI 写正文时会自动带上它。</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
            <div class="form-group">
                <label class="form-label">名称（角色名 / 设定条目名）</label>
                <input type="text" class="form-input" id="sink-title" placeholder="如：林渊 / 修行体系">
            </div>
            <div class="form-group">
                <label class="form-label">内容（可修改）</label>
                <textarea class="form-input" id="sink-content" rows="8">${escapeHtml(text)}</textarea>
            </div>
            <button class="btn btn-primary btn-block" ${bound ? '' : 'disabled'} onclick="sinkFromMenu('character')">👤 存为角色卡</button>
            <button class="btn btn-primary btn-block" ${bound ? '' : 'disabled'} onclick="sinkFromMenu('world')">🌍 存为世界观</button>
            <button class="btn btn-outline btn-block" onclick="sinkFromMenu('memo')">📝 存为备忘录</button>
            ${bound ? '' : '<div style="font-size:12px;color:var(--text-tertiary);text-align:center;">关联作品后即可存为角色卡 / 世界观</div>'}
        </div>`);
    modal.show();
}

async function sinkFromMenu(type) {
    const title = document.getElementById('sink-title')?.value.trim() || '';
    const content = document.getElementById('sink-content')?.value || '';
    if (!title && type !== 'memo') { ui.showToast('请先填写名称'); return; }
    closeModal();
    await sinkChatSetting(type, title || '聊天沉淀', content);
}

// 技能选择器（聊天中 @ 技能）
async function openSkillPicker() {
    const skills = await skillManager.getAll();
    const enabled = skills.filter(s => s.enabled);
    if (!enabled.length) {
        ui.showToast('没有已启用的技能，请先到技能中心启用');
        navigateTo('skillCenter');
        return;
    }
    const options = enabled.map(s => `<div class="skill-pick-item" onclick="pickChatSkill('${s.id}')"><span>${s.icon}</span><div style="flex:1;"><div style="font-weight:600;">${escapeHtml(s.name)}</div><div style="font-size:12px;color:var(--text-secondary);">${escapeHtml((s.description||'').slice(0, 30))}...</div></div><span style="color:var(--text-secondary);">›</span></div>`).join('');
    const modal = createModal('选择技能', `
        <div style="display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow-y:auto;">
            ${options}
            ${store.activeChatSkill ? `<button class="btn btn-secondary btn-block" style="margin-top:8px;" onclick="clearChatSkill()">清除当前技能</button>` : ''}
        </div>`);
    modal.show();
}

async function pickChatSkill(id) {
    store.activeChatSkill = id;
    closeModal();
    const skill = await skillManager.get(id);
    ui.showToast(`已启用技能：${skill.name}，聊天将按此技能规则执行`);
}

async function clearChatSkill() {
    store.activeChatSkill = null;
    closeModal();
    ui.showToast('已清除聊天技能');
}

// ===== 模型/记忆/起名/蒸馏/拆解/扫榜 入口 =====
function showModelIndicator() { showModelConfigModal(); }
// 「记忆」这个按钮指的是这本书的设定集：角色 + 世界观 + 参考资料，全在作品里，
// 没必要另造一套存储，直接把用户送到那里。
function showMemory() {
    if (!store.chatNovelId) {
        ui.showToast('先关联一部作品，记忆库就是它的角色与设定');
        showChatNovelPicker();
        return;
    }
    navigateTo('worldview', { novelId: store.chatNovelId });
}
function showNameGenerator() {
    const modal = createModal('AI 起名', `
        <div class="form-group">
            <label class="form-label">题材 / 风格</label>
            <select class="form-input" id="ng-genre">
                <option>玄幻</option>
                <option>仙侠</option>
                <option>都市</option>
                <option>科幻</option>
                <option>西幻</option>
                <option>武侠</option>
                <option>民国</option>
                <option>悬疑</option>
                <option>通用</option>
            </select>
        </div>
        <div class="form-group">
            <label class="form-label">身份（选填）</label>
            <input type="text" class="form-input" id="ng-role" placeholder="如：主角、女主、反派、门派长老">
        </div>
        <div class="form-group">
            <label class="form-label">性别</label>
            <select class="form-input" id="ng-gender">
                <option value="不限">不限</option>
                <option value="男">男</option>
                <option value="女">女</option>
            </select>
        </div>
        <div class="form-group">
            <label class="form-label">姓氏（选填）</label>
            <input type="text" class="form-input" id="ng-surname" placeholder="如：叶、苏、萧，留空自由发挥">
        </div>
        <button class="btn btn-primary btn-block" id="ng-btn" onclick="runNameGenerator()">生成名字</button>
        <div id="ng-result" style="margin-top: 16px; color: var(--text-tertiary); font-size: 13px;">未配置 API Key 时无法生成，请先在「设置 → 模型配置」填写。</div>
    `);
    modal.show();
}

async function runNameGenerator() {
    const genre = document.getElementById('ng-genre')?.value || '通用';
    const role = document.getElementById('ng-role')?.value.trim() || '';
    const gender = document.getElementById('ng-gender')?.value || '不限';
    const surname = document.getElementById('ng-surname')?.value.trim() || '';
    const resultEl = document.getElementById('ng-result');
    const btn = document.getElementById('ng-btn');

    btn.disabled = true;
    btn.textContent = '生成中…';
    if (resultEl) resultEl.innerHTML = '<div style="color: var(--text-tertiary); font-size: 13px;">正在构思名字…</div>';

    const prompt = `请为一部${genre}小说构思人名。
要求：
- 身份：${role || '不限'}
- 性别：${gender}
- ${surname ? `姓氏固定为「${surname}」` : '姓氏不限，可自行搭配合适的复姓或单姓'}
- 共给出 10 个候选，兼顾字面意境、读音和记忆点，避免烂大街的名字

请严格输出JSON格式（不要markdown代码块）：
{"names": [{"name": "完整姓名", "style": "名字风格/气质", "reason": "一句话构思说明"}]}`;

    try {
        const result = await ai.chat([
            { role: 'system', content: '你是精通中文姓名文化与网文角色命名的起名专家，擅长为不同类型小说角色取贴合气质的名字。' },
            { role: 'user', content: prompt }
        ], null, 2000);

        let data = null;
        try {
            const cleaned = result.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
            data = JSON.parse(cleaned);
        } catch (_) {
            const m = result.match(/\{[\s\S]*\}/);
            if (m) { try { data = JSON.parse(m[0]); } catch (_) {} }
        }
        const names = (data && Array.isArray(data.names)) ? data.names : [];
        if (!names.length) throw new Error('未解析到有效结果');

        if (resultEl) {
            resultEl.innerHTML = names.map(n => `
                <div class="ng-item">
                    <div class="ng-main">
                        <div class="ng-name">${escapeHtml(n.name || '')}</div>
                        <div class="ng-meta">${escapeHtml(n.style || '')}</div>
                        <div class="ng-reason">${escapeHtml(n.reason || '')}</div>
                    </div>
                    <button class="btn btn-outline btn-sm" onclick="copyName('${escapeHtml((n.name || '').replace(/'/g, "\\'"))}')">复制</button>
                </div>
            `).join('');
        }
    } catch (e) {
        if (resultEl) resultEl.innerHTML = `<div style="color: var(--error, #ef4444); font-size: 13px;">生成失败：${escapeHtml(e.message)}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '生成名字';
    }
}

async function copyName(name) {
    if (!name) return;
    try {
        await navigator.clipboard.writeText(name);
        ui.showToast('已复制：' + name);
    } catch (e) {
        // WebView 剪贴板权限受限时的降级方案
        try {
            const ta = document.createElement('textarea');
            ta.value = name;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            ui.showToast('已复制：' + name);
        } catch (_) {
            ui.showToast('复制失败，请手动选择');
        }
    }
}
// ===== 拆书（v2.9.0）=====
// 粘贴/导入他人文本 → AI 结构化拆解 → 可转成自己的大纲笔记
async function showDeconstruct() {
    const modal = createModal('📚 拆书', `
        <div class="draft-hint">粘贴一段小说原文（或导入 txt/md），AI 帮你拆出：题材卖点、开篇钩子、结构节奏、可借鉴技巧，并给出一份「如果我来写」的大纲骨架。</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px;">
            <input type="file" id="deconstruct-file" accept=".txt,.md,text/plain,text/markdown" style="display:none" onchange="loadDeconstructFile(this)">
            <button class="btn btn-outline btn-block" onclick="document.getElementById('deconstruct-file').click()">📂 导入 txt / md 文件</button>
            <textarea class="form-input" id="deconstruct-text" rows="9" placeholder="或直接粘贴原文（建议 2000 字以上，拆解更准）..."></textarea>
            <input type="text" class="form-input" id="deconstruct-focus" placeholder="拆解重点（可选）：如「开篇钩子」「打脸节奏」「感情线推进」">
            <button class="btn btn-primary btn-block" onclick="runDeconstruct()">🔍 开始拆解</button>
        </div>`);
    modal.show();
}

async function loadDeconstructFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const ta = document.getElementById('deconstruct-text');
        if (ta) ta.value = text.slice(0, 20000);
        ui.showToast(`已导入 ${text.length.toLocaleString()} 字`);
    } catch (e) {
        ui.showToast('读取文件失败: ' + e.message);
    }
}

async function runDeconstruct() {
    const text = document.getElementById('deconstruct-text')?.value.trim() || '';
    const focus = document.getElementById('deconstruct-focus')?.value.trim() || '';
    if (text.length < 200) { ui.showToast('内容太短，至少 200 字'); return; }
    closeModal();
    ui.showToast('AI 正在拆解...');
    try {
        const result = await ai.deconstruct(text.slice(0, 12000), focus);
        showDeconstructResult(result);
    } catch (e) {
        ui.showToast('拆解失败: ' + e.message);
    }
}

function showDeconstructResult(markdown) {
    window.__lastDeconstruct = markdown;
    const novelId = store.chatNovelId;
    const modal = createModal('📚 拆解结果', `
        <div class="draft-hint">拆书是为了借鉴结构与技巧，不是照搬文字。</div>
        <div class="deconstruct-result MD" id="deconstruct-result">${renderDeconstructMarkdown(markdown)}</div>
        <div class="draft-actions">
            <button class="btn btn-outline" onclick="copyName(window.__lastDeconstruct || '')">复制</button>
            <button class="btn btn-outline" onclick="sinkDeconstruct('memo')">📝 存备忘录</button>
            ${novelId ? `<button class="btn btn-primary" onclick="sinkDeconstruct('outline')">📋 转成我的大纲笔记</button>` : ''}
        </div>`);
    modal.show();
}

async function sinkDeconstruct(target) {
    const md = window.__lastDeconstruct || '';
    if (!md.trim()) { ui.showToast('没有可保存的内容'); return; }
    const novelId = store.chatNovelId;
    if (target === 'outline' && novelId) {
        try {
            const novel = await novelManager.get(novelId);
            await novelManager.addOutlineNote(novelId, '📚 拆书笔记 ' + new Date().toLocaleDateString('zh-CN'), md.slice(0, 2000));
            closeModal();
            ui.showToast(`已作为大纲笔记加入《${novel ? novel.title : ''}》，去大纲页可查看`);
        } catch (e) {
            ui.showToast('保存失败: ' + e.message);
        }
        return;
    }
    await sinkChatSetting('memo', '📚 拆书笔记', md);
    closeModal();
}

// 极简 Markdown 渲染（拆解结果展示用，逐行处理，不引第三方库；避开 skills.js 同名函数）
function renderDeconstructMarkdown(md) {
    const lines = String(md || '').split('\n');
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</div>'); inList = false; } };
    for (const line of lines) {
        const t = line.trim();
        if (!t) { closeList(); continue; }
        let m;
        if ((m = t.match(/^### (.*)$/))) { closeList(); out.push(`<h4>${escapeHtml(m[1])}</h4>`); }
        else if ((m = t.match(/^## (.*)$/))) { closeList(); out.push(`<h3>${escapeHtml(m[1])}</h3>`); }
        else if ((m = t.match(/^# (.*)$/))) { closeList(); out.push(`<h2>${escapeHtml(m[1])}</h2>`); }
        else if ((m = t.match(/^\d+\.\s+(.*)$/))) {
            if (!inList) { out.push('<div class="md-list">'); inList = true; }
            out.push(`<div class="md-li">${escapeHtml(m[1])}</div>`);
        }
        else if ((m = t.match(/^[-*]\s+(.*)$/))) {
            if (!inList) { out.push('<div class="md-list">'); inList = true; }
            out.push(`<div class="md-li">• ${escapeHtml(m[1])}</div>`);
        }
        else {
            closeList();
            out.push(`<p>${escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`);
        }
    }
    closeList();
    return out.join('');
}
// 「继续写作」原来只是跳到书架，还得自己点进书、再点进章。
// 它应该直接落到上次写的那一章。
async function continueWriting() {
    try {
        const novels = await novelManager.list();
        if (!novels || !novels.length) { navigateTo('bookshelf'); return; }
        const recent = novels.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
        const chs = await novelManager.listChapters(recent.id);
        const last = chs.slice().sort((a, b) => b.number - a.number)[0];
        if (last) navigateTo('chapterEdit', { novelId: recent.id, chapterNum: last.number });
        else navigateTo('novelDetail', { novelId: recent.id });
    } catch (e) {
        navigateTo('bookshelf');
    }
}
function showTutorial() { showTutorialModal(); }
function showDistill() { navigateTo('distill'); }
function useSkill() { openSkillPicker(); }
// 附件：读文本文件，把内容接到输入框（不直接发送，用户还能编辑）。
// 手机上用 <input type=file> 会唤起系统文件选择器，WebView 同样支持。
function attachFile() {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.txt,.md,.markdown,.text,text/plain';
    picker.onchange = async () => {
        const f = picker.files && picker.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) {
            ui.showToast('文件超过 2MB，先截取需要的部分再放进来', 4000);
            return;
        }
        try {
            const text = await f.text();
            const box = document.getElementById('chat-input');
            if (!box) return;
            const LIMIT = 6000;
            const clipped = text.length > LIMIT;
            const body = `【附件：${f.name}】\n${text.slice(0, LIMIT)}${clipped ? '\n…（已截取前 6000 字）' : ''}`;
            box.value = (box.value ? box.value + '\n\n' : '') + body;
            box.focus();
            box.selectionStart = box.selectionEnd = box.value.length;
            ui.showToast(`已读入 ${f.name}（${text.length} 字）${clipped ? '，已截断' : ''}`);
        } catch (e) {
            ui.showToast('读取失败：' + e.message, 4000);
        }
    };
    picker.click();
}
function rollDice() { ui.showToast(`🎲 ${Math.floor(Math.random() * 6) + 1}`); }
// 联网开关：原来按钮指向 showWebSearch()，而这个函数根本没定义，点了直接 ReferenceError；
// 旁边的 webSearch() 只弹一句"开发中"。等于完全没实现。
// 花钱的路径（DeepSeek 内置搜索按次计费）必须先讲清楚，不能让人点一下就开始花。
async function showWebSearch() {
    if (store.webSearchOn) {
        store.webSearchOn = false;
        try { localStorage.setItem('ow_web_search', '0'); } catch (e) { /* 忽略 */ }
        renderWebSearchBtn();
        ui.showToast('已关闭联网');
        return;
    }

    // 模型自己能联网就直接开，不拿配置页挡人。
    // 只有既没内置能力、也没填搜索 Key 时，才需要用户做选择。
    const picked = await resolveSearchMode();
    if (picked.mode === 'off') {
        // 说清楚「为什么不能联网 + 怎么修」，别让人猜
        let mc = null;
        try { mc = await settings.getModelConfig(); } catch (e) { /* 忽略 */ }
        const d = describeBuiltinSearch(mc || {});
        ui.showToast(`${d.reason}：${d.fix}`, 6000);
        openResearchConfig();
        return;
    }

    if (picked.mode === 'builtin') {
        let mc = null;
        try { mc = await settings.getModelConfig(); } catch (e) { /* 忽略 */ }
        const isDeepseek = /deepseek/i.test((mc && mc.model) || '') ||
                           /deepseek/i.test((mc && mc.baseUrl) || '');
        // DeepSeek 服务端搜索按成功请求计费，首次开启要明确告知
        if (isDeepseek && localStorage.getItem('ow_search_cost_ack') !== '1') {
            showSearchCostConfirm();
            return;
        }
        enableWebSearch(true);
        return;
    }

    enableWebSearch(false);
}

function enableWebSearch(isPaid) {
    store.webSearchOn = true;
    store.searchCount = 0;
    try { localStorage.setItem('ow_web_search', '1'); } catch (e) { /* 忽略 */ }
    renderWebSearchBtn();
    ui.showToast(isPaid
        ? '已联网：DeepSeek 搜索约 ¥0.005/次（11/1 起计费）'
        : '已联网：发消息前会先检索资料', 4000);
}

// 首次开启 DeepSeek 内置搜索的确认框：把价格、计费起点、省钱办法一次讲完
function showSearchCostConfirm() {
    const body = `
        <div class="rs-cfg">
            <p style="margin:0 0 10px">DeepSeek 的联网搜索由服务端执行，<b>按成功请求计费</b>：</p>
            <ul style="margin:0 0 12px;padding-left:18px;line-height:1.9">
                <li>官方价格 <b>5 元 / 1000 次</b>，约 <b>¥0.005 一次</b></li>
                <li><b>2026 年 11 月 1 日 00:00 起</b>正式收费，之前免费</li>
                <li>搜索无结果、请求失败或超时 <b>不计费</b></li>
            </ul>
            <p style="margin:0 0 12px">开启后，每发一条消息会检索一次（「继续」这类续写指令除外，不花这次钱）；按钮上会显示本次已检索次数。主搜索不可用时会自动切到备用搜索，不会卡住。</p>
            <p style="margin:0 0 6px"><b>想完全免费</b>：改用搜索 API —— Tavily 每月 1000 次免费、Serper 注册送 2500 次、博查有免费额度，结果还能沉淀成资料。</p>
            <label class="rs-check-line" style="margin-top:12px">
                <input type="checkbox" id="rs-cost-ack">
                <span>以后不再提示</span>
            </label>
        </div>
        <div class="rs-cfg-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="acceptSearchCost()">继续联网</button>
        </div>`;
    createModal('联网会产生费用', body).show();
}

function acceptSearchCost() {
    const ack = document.getElementById('rs-cost-ack');
    if (ack && ack.checked) {
        try { localStorage.setItem('ow_search_cost_ack', '1'); } catch (e) { /* 忽略 */ }
    }
    closeModal();
    enableWebSearch(true);
}

function renderWebSearchBtn() {
    const b = document.getElementById('chat-websearch-btn');
    if (!b) return;
    const on = !!store.webSearchOn;
    const n = store.searchCount || 0;
    b.classList.toggle('on', on);
    // 手机上没有 hover，次数直接写在按钮上，花了多少次一眼能看到
    b.textContent = on ? (n > 0 ? `联网中 ${n}` : '联网中') : '联网';
    b.title = on ? `已联网 · 本次开启后已检索 ${n} 次` : '开启后每条消息先联网检索资料';
}

// 把检索结果压成一段可注入的事实依据。压缩到 500 字/条：
// 全文塞进去会把对话挤爆，而 500 字足够覆盖"品级、年代、名词解释"这类查证需求。
function buildWebContext(hits) {
    if (!hits || !hits.length) return '';
    const lines = hits.slice(0, 4).map((r, i) => {
        const tail = r.fullText ? String(r.fullText).slice(0, 800) : String(r.snippet || '').slice(0, 500);
        return `[${i + 1}] ${r.title}${r.site ? '（' + r.site + '）' : ''}\n${tail}`;
    });
    return `\n\n【联网检索结果】下面是刚刚实时检索到的资料，涉及事实、数据、专有名词时以它们为准；`
        + `没查到或资料互相矛盾，就说明不确定，不要凭印象编造。与当前问题无关的内容可以忽略。\n\n`
        + lines.join('\n\n');
}

// ===== Bookshelf Page (v2.2.0 with stats dashboard) =====
async function renderBookshelf(container) {
    ui.setPageTitle('我的小说');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="importNovel()">导入</button>
        <button class="header-btn" onclick="createNovelWithAI()">+ 新建</button>
    `);
    ui.showLoading(container);

    try {
        const novels = await novelManager.list();
        const stats = await novelManager.getStats();
        store.novels = novels;

        if (novels.length === 0) {
            container.innerHTML = `
                <div class="stats-dashboard">
                    <div class="stats-dashboard-title">📊 数据统计</div>
                    <div class="stats-grid-3">
                        <div class="stat-card">
                            <div class="stat-card-icon">📚</div>
                            <div class="stat-card-value">0</div>
                            <div class="stat-card-label">作品总数</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-card-icon">📝</div>
                            <div class="stat-card-value">0</div>
                            <div class="stat-card-label">章节总数</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-card-icon">📊</div>
                            <div class="stat-card-value">0</div>
                            <div class="stat-card-label">总字数</div>
                        </div>
                    </div>
                </div>
                <div class="empty-state">
                    <div class="empty-icon">📖</div>
                    <div class="empty-title">书架空空如也</div>
                    <div class="empty-desc">新建一本开始写，或者把旧稿导进来</div>
                    <div class="empty-actions">
                        <button class="btn btn-primary" onclick="createNovelWithAI()">新建作品</button>
                        <button class="btn btn-outline" onclick="importNovel()">导入旧稿</button>
                    </div>
                </div>
            `;
            return;
        }

        const todayWords = await getTodayWords();
        const dailyGoal = await getDailyGoal();
        const dgPct = Math.min(100, Math.round(todayWords / dailyGoal * 100));
        const dgLeft = Math.max(0, dailyGoal - todayWords);
        const dailyHtml = `
            <div class="daily-goal" onclick="showDailyGoalSetting()">
                <div class="dg-top">
                    <span class="dg-k">今日</span>
                    <span class="dg-num">${todayWords.toLocaleString()}<i> / ${dailyGoal.toLocaleString()}</i></span>
                    <span class="dg-hint">${dgLeft > 0 ? `还差 ${dgLeft.toLocaleString()} 字` : '已达标'}</span>
                </div>
                <div class="dg-bar"><i style="width:${dgPct}%"></i></div>
            </div>`;

        // 写作 App 的第一动作是「接着上次写」，所以把最近一章放到最上面
        let resumeHtml = '';
        const recent = novels.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
        if (recent) {
            try {
                const chs = await novelManager.listChapters(recent.id);
                const last = chs.slice().sort((a, b) => b.number - a.number)[0];
                if (last) {
                    const chTitle = (last.title || '').replace(/^第\d+章\s*/, '') || '未命名';
                    resumeHtml = `
                        <div class="resume-card" onclick="navigateTo('chapterEdit', { novelId: '${recent.id}', chapterNum: ${last.number} })">
                            <div class="resume-cover">${escapeHtml((recent.title || '书').charAt(0))}</div>
                            <div class="resume-main">
                                <div class="resume-k">继续写作</div>
                                <div class="resume-t">第 ${last.number} 章 · ${escapeHtml(chTitle)}</div>
                                <div class="resume-m">${formatDate(last.updated || recent.updated)} · ${(last.wordCount || 0).toLocaleString()} 字</div>
                            </div>
                            <div class="resume-go">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.5 5.2l11 6.8-11 6.8z"/></svg>
                            </div>
                        </div>`;
                }
            } catch (e) { /* 章节读不出来就不显示，不影响书架 */ }
        }

        container.innerHTML = `
            ${dailyHtml}
            ${resumeHtml}
            <div class="stats-dashboard">
                <div class="stats-dashboard-title">📊 数据统计</div>
                <div class="stats-grid-3">
                    <div class="stat-card">
                        <div class="stat-card-icon">📚</div>
                        <div class="stat-card-value">${stats.totalNovels}</div>
                        <div class="stat-card-label">作品总数</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-icon">📝</div>
                        <div class="stat-card-value">${stats.totalChapters}</div>
                        <div class="stat-card-label">章节总数</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-icon">📊</div>
                        <div class="stat-card-value">${(stats.totalWords).toLocaleString()}</div>
                        <div class="stat-card-label">总字数</div>
                    </div>
                </div>
            </div>
            <div class="novel-list">
                ${novels.map(novel => `
                    <div class="novel-item" onclick="navigateTo('novelDetail', { novelId: '${novel.id}' })">
                        <div class="novel-cover">${escapeHtml((novel.title || "?").charAt(0))}</div>
                        <div class="novel-info">
                            <div class="novel-title">${escapeHtml(novel.title)}</div>
                            <div class="novel-meta">${novel.chapterCount || 0}章 · ${(novel.wordCount || 0).toLocaleString()}字 · ${formatDate(novel.updated)}</div>
                            ${novel.genre ? `<div class="novel-genre">${escapeHtml(novel.genre)}</div>` : ''}
                        </div>
                        <div class="novel-badge">当前</div>
                    </div>
                `).join('')}
            </div>`;
    } catch (err) {
        ui.showEmptyState(container, { icon: '⚠️', title: '加载失败', desc: err.message });
    }
}

// ===== Novel Detail Page =====
async function renderNovelDetail(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) {
        ui.showToast('作品不存在');
        navigateTo('bookshelf');
        return;
    }

    ui.setPageTitle(novel.title);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('bookshelf')">返回</button>
    `);
    ui.showLoading(container);

    try {
        const chapters = await novelManager.listChapters(novelId);
        store.currentNovel = novel;

        // Build tree data
        // 大纲兼容两种格式：旧版扁数组 + 树形大纲（outlineEditor/saveOutline 存的是树）
        // 此前只按扁数组读，保存过树形大纲的作品进详情页直接「outlineItems.map is not a function」
        const outlineItems = getFlatOutlineItems(novel);
        const characters = novel.characters || [];
        const volumes = await novelManager.listVolumes(novelId);
        
        container.innerHTML = `
            <div class="novel-header-card">
                <div class="novel-header-cover">${escapeHtml((novel.title || "?").charAt(0))}</div>
                <div class="novel-header-info">
                    <div class="novel-header-title">${escapeHtml(novel.title)}</div>
                    <div class="novel-header-meta">${novel.chapterCount || 0}章 · ${(novel.wordCount || 0).toLocaleString()}字</div>
                    <div class="novel-header-desc">${escapeHtml(novel.description || '暂无简介')}</div>
                </div>
            </div>

            <div class="action-buttons-row" style="margin-bottom: 12px;">
                <button class="btn btn-primary" onclick="aiWriteNextDirect('${novelId}')">⚡ AI写下一章</button>
                <button class="btn btn-secondary" onclick="showWriteChapterModal('${novelId}')">✍️ 带提示写章节</button>
            </div>

            <div class="action-buttons-row nd-actions" style="margin-bottom: 14px;">
                <button class="btn btn-outline" onclick="navigateTo('outlineEditor', { novelId: '${novelId}' })">📋 大纲</button>
                <button class="btn btn-outline" onclick="navigateTo('plotSimulate', { novelId: '${novelId}' })">🔮 推演</button>
                <button class="btn btn-outline" onclick="navigateTo('characterCards', { novelId: '${novelId}' })">👥 角色</button>
                <button class="btn btn-outline" onclick="navigateTo('worldview', { novelId: '${novelId}' })">🌍 世界观</button>
                <button class="btn btn-outline" onclick="navigateTo('foreshadowing', { novelId: '${novelId}' })">🧵 伏笔</button>
                <button class="btn btn-outline" onclick="showReaderAuditModal('${novelId}')">📈 体检</button>
                <button class="btn btn-outline" onclick="scanChapterHooks('${novelId}')">🪝 钩子</button>
                <button class="btn btn-outline" onclick="navigateTo('agentStudio', { novelId: '${novelId}' })">🎭 多Agent</button>
                <button class="btn btn-outline" onclick="navigateTo('consistencyCheck', { novelId: '${novelId}' })">🔍 一致性</button>
                <button class="btn btn-outline" onclick="navigateTo('novelExport', { novelId: '${novelId}' })">📤 导出</button>
            </div>

            <!-- 目录树形结构 -->
            <div class="novel-tree">
                <!-- 大纲 -->
                <div class="tree-folder" onclick="toggleTreeFolder(this)">
                    <div class="tree-folder-header">
                        <span class="tree-toggle">▼</span>
                        <span class="tree-icon">📋</span>
                        <span class="tree-label">大纲</span>
                        <span class="tree-count">${outlineItems.length}项</span>
                    </div>
                    <div class="tree-folder-content">
                        ${outlineItems.length === 0 
                            ? '<div class="tree-empty">暂无大纲</div>'
                            : outlineItems.map((item, idx) => `
                                <div class="tree-file" onclick="event.stopPropagation(); viewOutlineItem('${novelId}', ${idx})">
                                    <span class="tree-file-icon">📄</span>
                                    <span class="tree-file-name">第${item.chapter}章 ${escapeHtml(item.title || '')}</span>
                                    <span class="tree-file-meta">${escapeHtml((item.summary || '').substring(0, 20))}...</span>
                                </div>
                            `).join('')}
                    </div>
                </div>

                <!-- 资料 -->
                <div class="tree-folder" onclick="toggleTreeFolder(this)">
                    <div class="tree-folder-header">
                        <span class="tree-toggle">▼</span>
                        <span class="tree-icon">📁</span>
                        <span class="tree-label">资料</span>
                        <span class="tree-count">${characters.length}项</span>
                    </div>
                    <div class="tree-folder-content">
                        ${characters.length === 0
                            ? '<div class="tree-empty">暂无资料</div>'
                            : characters.map((char, idx) => `
                                <div class="tree-file" onclick="event.stopPropagation(); viewCharacter('${novelId}', ${idx})">
                                    <span class="tree-file-icon">👤</span>
                                    <span class="tree-file-name">${escapeHtml(char.name || '')}</span>
                                    <span class="tree-file-meta">${escapeHtml(char.role || '角色')}</span>
                                </div>
                            `).join('')}
                    </div>
                </div>

                <!-- 章节/正文 -->
                <div class="tree-folder expanded" onclick="toggleTreeFolder(this)">
                    <div class="tree-folder-header">
                        <span class="tree-toggle">▼</span>
                        <span class="tree-icon">📝</span>
                        <span class="tree-label">正文</span>
                        <span class="tree-count">${chapters.length}章${volumes.length ? ` · ${volumes.length}卷` : ''}</span>
                        <span class="tree-tools" onclick="event.stopPropagation()">
                            <button class="tree-tool" onclick="addVolume('${novelId}')">＋卷</button>
                            <button class="tree-tool" onclick="navigateTo('chapterSort', { novelId: '${novelId}' })">排序</button>
                        </span>
                    </div>
                    <div class="tree-folder-content">
                        ${buildChapterTreeHtml(chapters, volumes, novelId)}
                    </div>
                </div>
            </div>
        `;
    } catch (err) {
        ui.showEmptyState(container, { icon: '⚠️', title: '加载失败', desc: err.message });
    }
}

// ===== 每日字数目标（v2.17.0）=====
// 码字类 App 唯一被验证有效的留人机制：每天有个"还差 800 字"的钩子。
const DAILY_GOAL_DEFAULT = 2000;

function todayKey() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

async function getDailyGoal() {
    const v = await settings.get('dailyGoal', DAILY_GOAL_DEFAULT);
    return Number(v) > 0 ? Number(v) : DAILY_GOAL_DEFAULT;
}

async function getTodayWords() {
    const rec = await settings.get('dailyWords', null);
    return rec && rec.date === todayKey() ? (rec.words || 0) : 0;
}

async function addTodayWords(delta) {
    if (!delta || delta <= 0) return;
    const key = todayKey();
    const rec = await settings.get('dailyWords', null);
    const cur = rec && rec.date === key ? (rec.words || 0) : 0;
    await settings.set('dailyWords', { date: key, words: cur + delta });
}

async function showDailyGoalSetting() {
    const goal = await getDailyGoal();
    const today = await getTodayWords();
    createModal('每日写作目标', `
        <div class="imp-summary">今天已写 <b>${today.toLocaleString()}</b> 字</div>
        <div class="form-group">
            <label class="form-label">每天目标（字）</label>
            <input class="input" id="dg-input" type="number" min="100" step="100" value="${goal}">
        </div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="saveDailyGoal()">保存</button>
        </div>`).show();
}

async function saveDailyGoal() {
    const el = document.getElementById('dg-input');
    const v = Number((el && el.value) || 0);
    if (!v || v < 100) { ui.showToast('目标至少 100 字'); return; }
    await settings.set('dailyGoal', v);
    closeModal();
    ui.showToast(`目标已设为每天 ${v.toLocaleString()} 字`);
    if (store.currentPage === 'bookshelf') navigateTo('bookshelf', {}, true);
}

// ===== 专注模式（v2.17.0）=====
// 写作时界面该退到背景里：只留正文和字数，其余全隐。
function toggleFocusMode(on) {
    const next = typeof on === 'boolean' ? on : !document.body.classList.contains('focus-mode');
    document.body.classList.toggle('focus-mode', next);

    const old = document.getElementById('focus-exit-btn');
    if (old) old.remove();

    if (next) {
        const btn = document.createElement('button');
        btn.id = 'focus-exit-btn';
        btn.className = 'focus-exit';
        btn.textContent = '退出专注';
        btn.onclick = () => toggleFocusMode(false);
        document.body.appendChild(btn);
        const ta = document.getElementById('chapter-content');
        if (ta) ta.focus();
    }
}

// ===== 导入旧稿（v2.17.0）=====
// 换软件最大的门槛不是功能，是手里那几十万字搬不过来。
// 这里按「第N章」切分，识别不出来就整篇作为一章，反正能进来就能改。

function splitChapters(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n');
    // 只认行首、独立成行的章节标题，避免把正文里的「第三章」误判
    const re = /^[ \t]*(第\s*[0-9零一二三四五六七八九十百千两]+\s*[章节回][^\n]{0,40})[ \t]*$/gm;
    const marks = [];
    let m;
    while ((m = re.exec(t)) !== null) marks.push({ index: m.index, title: m[1].trim() });

    if (!marks.length) {
        const body = t.trim();
        return body ? [{ title: '全文', content: body }] : [];
    }

    const out = [];
    const pre = t.slice(0, marks[0].index).trim();
    if (pre.length > 20) out.push({ title: '序章', content: pre });

    marks.forEach((mk, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].index : t.length;
        const body = t.slice(mk.index + mk.title.length, end).trim();
        out.push({ title: mk.title, content: body });
    });
    return out.filter(c => c.content.length > 0);
}

function pickTextFile(onText) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.txt,.md,.markdown,text/plain';
    picker.onchange = async () => {
        const f = picker.files && picker.files[0];
        if (!f) return;
        try {
            const text = await f.text();
            onText(text, f.name.replace(/\.[^.]+$/, ''));
        } catch (e) {
            ui.showToast('读取失败：' + e.message);
        }
    };
    picker.click();
}

async function importNovel() {
    pickTextFile(async (text, fallbackTitle) => {
        const chapters = splitChapters(text);
        if (!chapters.length) { ui.showToast('这个文件里没有可导入的文字'); return; }

        const total = chapters.reduce((s, c) => s + c.content.length, 0);
        const novels = await novelManager.list();
        const options = novels.map(n => `<option value="${escapeAttr(n.id)}">${escapeHtml(n.title)}（追加）</option>`).join('');

        createModal('导入旧稿', `
            <div class="imp-summary">
                识别到 <b>${chapters.length}</b> 章 · 共 <b>${total.toLocaleString()}</b> 字
            </div>
            <div class="form-group">
                <label class="form-label">放进哪里</label>
                <select class="input" id="imp-target">
                    <option value="">新建一本《${escapeHtml(fallbackTitle || '导入的书')}》</option>
                    ${options}
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">前 3 章预览</label>
                <div class="imp-preview">
                    ${chapters.slice(0, 3).map((c, i) => `
                        <div class="imp-row">
                            <span class="imp-idx">${i + 1}</span>
                            <span class="imp-title">${escapeHtml(c.title)}</span>
                            <span class="imp-len">${c.content.length.toLocaleString()} 字</span>
                        </div>`).join('')}
                    ${chapters.length > 3 ? `<div class="imp-more">… 还有 ${chapters.length - 3} 章</div>` : ''}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-outline" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="doImport('${escapeAttr(fallbackTitle || '导入的书')}')">导入</button>
            </div>`).show();

        window.__importChapters = chapters;
    });
}

async function doImport(fallbackTitle) {
    const chapters = window.__importChapters || [];
    if (!chapters.length) return;
    const sel = document.getElementById('imp-target');
    const targetId = sel ? sel.value : '';

    ui.showToast('正在导入…', 3000);
    try {
        let novelId = targetId;
        if (!novelId) {
            const novel = await novelManager.create(fallbackTitle || '导入的书', '', '');
            novelId = novel.id;
        }
        const existing = await novelManager.listChapters(novelId);
        let num = existing.length;
        for (const ch of chapters) {
            num += 1;
            await novelManager.saveChapter(novelId, num, ch.title, ch.content, null, { archive: false });
        }
        window.__importChapters = null;
        closeModal();
        ui.showToast(`已导入 ${chapters.length} 章，共 ${chapters.reduce((s,c)=>s+c.content.length,0).toLocaleString()} 字`, 4000);
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        ui.showToast('导入失败：' + e.message, 4500);
    }
}

// ===== 分卷 / 章节排序（v2.10.1）=====
function chapterRowHtml(ch, novelId) {
    // 标题本身常带「第N章」，再前缀一次会变成「第1章 第1章」
    const raw = (ch.title || '').trim();
    const stripped = raw.replace(/^第\d+章\s*/, '').trim();
    const shown = stripped || raw.replace(/^第\d+章\s*/, '') || '';
    return `<div class="tree-file ch-row" onclick="event.stopPropagation(); navigateTo('chapterEdit', { novelId: '${novelId}', chapterNum: ${ch.number} })">
        <span class="tree-file-icon">📄</span>
        <span class="tree-file-name">第${ch.number}章${shown ? ' ' + escapeHtml(shown) : ''}</span>
        <span class="tree-file-meta">${(ch.wordCount || 0).toLocaleString()}字</span>
        <button class="ch-more" onclick="event.stopPropagation(); showChapterActions('${novelId}', ${ch.number})">⋯</button>
    </div>`;
}

function buildChapterTreeHtml(chapters, volumes, novelId) {
    if (!chapters.length) return '<div class="tree-empty">暂无章节</div>';
    const sorted = chapters.slice().sort((a, b) => a.number - b.number);

    // 没有卷时保持原来的平铺样式，老用户看不到任何变化
    if (!volumes || !volumes.length) {
        return sorted.map(ch => chapterRowHtml(ch, novelId)).join('');
    }

    const volIds = new Set(volumes.map(v => v.id));
    const loose = sorted.filter(c => !c.volumeId || !volIds.has(c.volumeId));

    let html = '';
    volumes.forEach(v => {
        const list = sorted.filter(c => c.volumeId === v.id);
        const words = list.reduce((sum, c) => sum + (c.wordCount || 0), 0);
        html += `<div class="vol-head" onclick="event.stopPropagation(); showVolumeActions('${novelId}', '${v.id}')">
            <span class="vol-icon">📖</span>
            <span class="vol-title">${escapeHtml(v.title)}</span>
            <span class="vol-meta">${list.length}章 · ${words.toLocaleString()}字</span>
            <span class="vol-more">⋯</span>
        </div>`;
        html += list.length
            ? list.map(ch => chapterRowHtml(ch, novelId)).join('')
            : '<div class="tree-empty vol-empty">本卷还没有章节，可从其他卷移入</div>';
    });

    if (loose.length) {
        html += `<div class="vol-head vol-head-loose">
            <span class="vol-icon">📄</span>
            <span class="vol-title">未分卷</span>
            <span class="vol-meta">${loose.length}章</span>
        </div>`;
        html += loose.map(ch => chapterRowHtml(ch, novelId)).join('');
    }
    return html;
}

function addVolume(novelId) {
    const modal = createModal('新建卷', `
        <div class="form-group">
            <label class="form-label">卷名</label>
            <input class="input" id="vol-title" placeholder="例如：第一卷 北镇抚司" maxlength="40">
        </div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="createVolumeAndRefresh('${novelId}')">创建</button>
        </div>`);
    modal.show();
    setTimeout(() => { const el = document.getElementById('vol-title'); if (el) el.focus(); }, 120);
}

async function createVolumeAndRefresh(novelId) {
    const input = document.getElementById('vol-title');
    const title = (input && input.value || '').trim();
    try {
        await novelManager.createVolume(novelId, title);
        closeModal();
        ui.showToast('已新建卷');
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        ui.showToast('创建失败：' + e.message);
    }
}

async function showVolumeActions(novelId, volumeId) {
    const volumes = await novelManager.listVolumes(novelId);
    const vol = volumes.find(v => v.id === volumeId);
    if (!vol) return;
    const chapters = await novelManager.listChapters(novelId);
    const count = chapters.filter(c => c.volumeId === volumeId).length;

    createModal(`📖 ${vol.title}`, `
        <div class="vol-action-note">本卷 ${count} 章。删除卷不会删除章节，章节会退回「未分卷」。</div>
        <div class="form-group">
            <label class="form-label">卷名</label>
            <input class="input" id="vol-rename" value="${escapeAttr(vol.title)}" maxlength="40">
        </div>
        <div class="modal-actions">
            <button class="btn btn-danger" onclick="deleteVolumeConfirm('${novelId}', '${volumeId}')">删除卷</button>
            <button class="btn btn-primary" onclick="renameVolumeAndRefresh('${novelId}', '${volumeId}')">保存</button>
        </div>`).show();
}

async function renameVolumeAndRefresh(novelId, volumeId) {
    const input = document.getElementById('vol-rename');
    try {
        await novelManager.renameVolume(novelId, volumeId, (input && input.value || '').trim());
        closeModal();
        ui.showToast('已重命名');
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        ui.showToast('重命名失败：' + e.message);
    }
}

async function deleteVolumeConfirm(novelId, volumeId) {
    if (!confirm('确定删除这一卷？章节会保留，退回「未分卷」。')) return;
    try {
        await novelManager.deleteVolume(novelId, volumeId);
        closeModal();
        ui.showToast('已删除卷，章节已保留');
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        ui.showToast('删除失败：' + e.message);
    }
}

async function showChapterActions(novelId, chapterNum) {
    const volumes = await novelManager.listVolumes(novelId);
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!chapter) return;

    const options = [`<option value="">未分卷</option>`]
        .concat(volumes.map(v => `<option value="${escapeAttr(v.id)}" ${chapter.volumeId === v.id ? 'selected' : ''}>${escapeHtml(v.title)}</option>`))
        .join('');

    createModal(`第${chapterNum}章`, `
        <div class="form-group">
            <label class="form-label">所在卷</label>
            <select class="input" id="ch-volume">${options}</select>
        </div>
        <div class="vol-action-note">排序（拖动调整章节顺序）在「正文 → 排序」里。</div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="moveChapterToVolume('${novelId}', ${chapterNum})">保存</button>
        </div>`).show();
}

async function moveChapterToVolume(novelId, chapterNum) {
    const sel = document.getElementById('ch-volume');
    try {
        await novelManager.setChapterVolume(novelId, chapterNum, sel ? sel.value : '');
        closeModal();
        ui.showToast('已更新所属卷');
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        ui.showToast('保存失败：' + e.message);
    }
}

// ===== 章节排序页 =====
let __sortState = null;
let __sortDragBound = false;

async function renderChapterSort(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    const chapters = (await novelManager.listChapters(novelId)).sort((a, b) => a.number - b.number);

    ui.setPageTitle('调整章节顺序');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="saveChapterOrder('${novelId}')">保存</button>`);

    if (!chapters.length) {
        ui.showEmptyState(container, { icon: '📄', title: '还没有章节', desc: '先写几章再来排序' });
        return;
    }

    const byNum = {};
    chapters.forEach(c => { byNum[c.number] = c; });
    __sortState = { novelId, order: chapters.map(c => c.number), byNum };

    container.innerHTML = `
        <div class="sort-wrap">
            <div class="sort-tip">按住 ≡ 拖动调整顺序，或用 ↑ ↓ 微调。保存后会重新编号，伏笔、节拍、版本历史会一并跟着走。</div>
            <div id="sort-list" class="sort-list"></div>
        </div>`;

    sortRenderList();
    initSortDrag(container);
}

function sortRenderList() {
    const box = document.getElementById('sort-list');
    if (!box || !__sortState) return;
    const st = __sortState;

    box.innerHTML = st.order.map((num, i) => {
        const ch = st.byNum[num] || {};
        const rawTitle = (ch.title || '').trim();
        const title = rawTitle.replace(/^第\d+章\s*/, '').trim() || rawTitle || '未命名';
        return `<div class="sort-row" data-idx="${i}" data-num="${num}">
            <span class="sort-handle" title="拖动排序">≡</span>
            <span class="sort-idx">${i + 1}</span>
            <div class="sort-main">
                <div class="sort-title">${escapeHtml(title)}</div>
                <div class="sort-sub">原第${num}章 · ${(ch.wordCount || 0).toLocaleString()}字</div>
            </div>
            <button class="sort-btn" onclick="sortMove(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="sort-btn" onclick="sortMove(${i}, 1)" ${i === st.order.length - 1 ? 'disabled' : ''}>↓</button>
        </div>`;
    }).join('');
}

function sortMove(i, delta) {
    if (!__sortState) return;
    const to = i + delta;
    const arr = __sortState.order;
    if (to < 0 || to >= arr.length) return;
    const [m] = arr.splice(i, 1);
    arr.splice(to, 0, m);
    sortRenderList();
}

function initSortDrag(container) {
    if (__sortDragBound) return;
    __sortDragBound = true;
    let dragIdx = -1;

    document.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest && e.target.closest('.sort-handle');
        if (!handle) return;
        const row = handle.closest('.sort-row');
        if (!row) return;
        e.preventDefault();
        dragIdx = Number(row.dataset.idx);
        row.classList.add('sort-dragging');
    });

    document.addEventListener('pointermove', (e) => {
        if (dragIdx < 0 || !__sortState) return;
        e.preventDefault();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const row = el && el.closest ? el.closest('.sort-row') : null;
        if (!row) return;
        const to = Number(row.dataset.idx);
        if (to === dragIdx) return;
        const arr = __sortState.order;
        const [m] = arr.splice(dragIdx, 1);
        arr.splice(to, 0, m);
        dragIdx = to;
        sortRenderList();
        const fresh = document.querySelector(`.sort-row[data-idx="${dragIdx}"]`);
        if (fresh) fresh.classList.add('sort-dragging');
    }, { passive: false });

    const end = () => {
        if (dragIdx >= 0) {
            document.querySelectorAll('.sort-row.sort-dragging').forEach(el => el.classList.remove('sort-dragging'));
            dragIdx = -1;
        }
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
}

async function saveChapterOrder(novelId) {
    if (!__sortState) return;
    try {
        const changed = await novelManager.reorderChapters(novelId, __sortState.order);
        ui.showToast(changed ? '章节已重新编号' : '顺序没有变化');
        __sortState = null;
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        ui.showToast('保存失败：' + e.message, 4000);
    }
}

// ===== 章末钩子检查（v2.13.0）=====
// 只判断「这一段能不能让人点下一章」，不预测追读率——后者是平台后台的数据，本地没有。

function hookTail(content, len = 280) {
    const t = String(content || '').replace(/\r/g, '').trim();
    if (t.length <= len) return t;
    const cut = t.slice(-len);
    // 尽量从句子开头截，别把半句话喂给 AI
    const m = cut.match(/[。！？…\n]/);
    return m ? cut.slice(m.index + 1).trim() || cut : cut;
}

function parseHookJson(text, items) {
    let s = String(text || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    let arr = [];
    if (a >= 0 && b > a) {
        try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e) { arr = []; }
    }
    if (!Array.isArray(arr)) arr = [];

    const valid = new Set((items || []).map(it => Number(it.number)));
    return arr.map(r => ({
        chapter: Number(r.chapter),
        score: Math.max(0, Math.min(10, Math.round(Number(r.score) || 0))),
        type: String(r.type || '未知').slice(0, 12),
        problem: String(r.problem || '').slice(0, 120),
        fix: String(r.fix || '').slice(0, 160)
    }))
        .filter(r => valid.has(r.chapter))
        .sort((x, y) => x.chapter - y.chapter);
}

async function checkChapterHook(novelId, chapterNum) {
    const ch = await novelManager.getChapter(novelId, chapterNum);
    const ta = document.getElementById('chapter-content');
    const content = ta ? ta.value : (ch && ch.content);
    if (!content || !content.trim()) { ui.showToast('这一章还没有正文'); return; }

    ui.showToast('正在看章末…');
    try {
        const rows = await ai.hookCheck([{
            number: chapterNum,
            title: (ch && ch.title || '').replace(/^第\d+章\s*/, ''),
            tail: hookTail(content)
        }]);
        if (!rows.length) { ui.showToast('没解析出结果，再试一次'); return; }

        const r = Object.assign({}, rows[0], { title: (ch && ch.title || '').replace(/^第\d+章\s*/, ''), at: Date.now() });
        if (ch) { ch.hook = r; await db.put('chapters', ch); }
        showHookModal(novelId, [r], '第' + chapterNum + '章');
    } catch (e) {
        ui.showToast('检查失败：' + e.message, 4000);
    }
}

// 一次扫最近 30 章：更早的章节对"留人"影响已经很小，没必要为它烧 token
async function scanChapterHooks(novelId) {
    const all = (await novelManager.listChapters(novelId)).sort((a, b) => a.number - b.number);
    if (!all.length) { ui.showToast('还没有章节'); return; }
    const target = all.slice(-30);

    const rows = [];
    const CHUNK = 10;
    for (let i = 0; i < target.length; i += CHUNK) {
        const slice = target.slice(i, i + CHUNK);
        ui.showToast(`检查 ${i + 1}-${Math.min(i + CHUNK, target.length)} / ${target.length}…`, 2500);
        try {
            const got = await ai.hookCheck(slice.map(c => ({
                number: c.number,
                title: (c.title || '').replace(/^第\d+章\s*/, ''),
                tail: hookTail(c.content)
            })));
            got.forEach(r => {
                const c = slice.find(x => x.number === r.chapter);
                rows.push(Object.assign({}, r, { title: (c && c.title || '').replace(/^第\d+章\s*/, ''), at: Date.now() }));
            });
        } catch (e) {
            ui.showToast('第 ' + slice[0].number + ' 章起检查失败：' + e.message, 4000);
            break;
        }
    }

    if (!rows.length) { ui.showToast('没有拿到结果'); return; }

    for (const r of rows) {
        const c = all.find(x => x.number === r.chapter);
        if (c) { c.hook = r; await db.put('chapters', c); }
    }
    showHookModal(novelId, rows, `最近 ${target.length} 章`);
}

function hookTone(score) {
    if (score >= 7) return 'good';
    if (score >= 4) return 'mid';
    return 'bad';
}

function showHookModal(novelId, rows, label) {
    const list = rows.slice().sort((a, b) => a.score - b.score);
    const avg = (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1);
    const weak = rows.filter(r => r.score < 4).length;

    if (rows.length === 1) {
        const r = rows[0];
        createModal(`🪝 ${label} · 章末钩子`, `
            <div class="hook-single">
                <div class="hook-score ${hookTone(r.score)}">${r.score}<span>/10</span></div>
                <div class="hook-type">类型：${escapeHtml(r.type)}</div>
                <div class="hook-block">
                    <div class="hook-lb">问题</div>
                    <div class="hook-txt">${escapeHtml(r.problem || '无')}</div>
                </div>
                <div class="hook-block">
                    <div class="hook-lb">怎么改</div>
                    <div class="hook-txt">${escapeHtml(r.fix || '暂无建议')}</div>
                </div>
                <div class="hook-note">只看这一章结尾的最后 280 字。这是编辑视角的判断，不是平台的真实追读数据。</div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-outline" onclick="closeModal()">知道了</button>
                <button class="btn btn-primary" onclick="closeModal();checkChapterHook('${novelId}', ${r.chapter})">重新检查</button>
            </div>`).show();
        return;
    }

    createModal(`🪝 ${label} · 章末钩子`, `
        <div class="hook-summary">
            <div><b>${avg}</b><span>平均分</span></div>
            <div><b>${weak}</b><span>4 分以下</span></div>
            <div><b>${rows.length}</b><span>已检查</span></div>
        </div>
        <div class="hook-list">
            ${list.map(r => `
                <div class="hook-row" onclick="closeModal(); navigateTo('chapterEdit', { novelId: '${novelId}', chapterNum: ${r.chapter} })">
                    <span class="hook-score-sm ${hookTone(r.score)}">${r.score}</span>
                    <div class="hook-row-main">
                        <div class="hook-row-title">第${r.chapter}章 ${escapeHtml(r.title || '')}</div>
                        <div class="hook-row-sub">${escapeHtml(r.type)} · ${escapeHtml(r.problem || '无')}</div>
                    </div>
                    <span class="hook-row-arrow">›</span>
                </div>`).join('')}
        </div>
        <div class="hook-note">按分数从低到高排。分数低的是"读者可能在这里合上 App"的地方，点进去能直接改。</div>
    `).show();
}

// ===== Chapter Edit Page =====
async function renderChapterEdit(container, novelId, chapterNum) {
    const novel = await novelManager.get(novelId);
    const chapter = await novelManager.getChapter(novelId, chapterNum);

    ui.setPageTitle(chapter ? chapter.title : `第${chapterNum}章`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="toggleFocusMode(true)">专注</button>
        <button class="header-btn" onclick="saveAndBack('${novelId}', ${chapterNum})">保存</button>
    `);

    const title = chapter ? chapter.title : `第${chapterNum}章`;
    const content = chapter ? chapter.content : '';
    const scene = chapter && chapter.scene ? chapter.scene : { pov: '', goal: '', conflict: '', outcome: '' };
    const sceneFilled = scene.pov || scene.goal || scene.conflict || scene.outcome;

    container.innerHTML = `
        <div class="editor-container">
            <input type="text" class="editor-title-input" id="chapter-title" value="${escapeHtml(title)}" placeholder="章节标题...">
            <div class="editor-save-state" id="editor-save-status">已保存</div>
            <textarea class="editor-content" id="chapter-content" placeholder="在此开始写作...">${escapeHtml(content)}</textarea>
        </div>
        ${chapter && chapter.summary ? `
        <div class="chapter-summary-box">
            <div class="chapter-summary-title">📌 本章摘要（供后续章节回顾）</div>
            <div class="chapter-summary-text">${escapeHtml(chapter.summary).replace(/\n/g, '<br>')}</div>
        </div>` : ''}
        <div class="scene-card ${sceneFilled ? 'scene-card-filled' : ''}" id="scene-card">
            <div class="scene-card-head" onclick="toggleSceneCard()">
                <span>🎬 场景卡${sceneFilled ? '' : '（未填写）'}</span>
                <span class="scene-card-toggle" id="scene-card-toggle">${sceneFilled ? '▼' : '▶'}</span>
            </div>
            <div class="scene-card-body" id="scene-card-body" style="display:${sceneFilled ? 'block' : 'none'};">
                <div class="scene-card-hint">写好场景卡，AI 写作时会按这个结构成文（对标 yWriter 场景卡片）</div>
                <input type="text" class="input scene-input" id="scene-pov" placeholder="视角人物：这一章以谁的视角写" value="${escapeHtml(scene.pov)}">
                <input type="text" class="input scene-input" id="scene-goal" placeholder="本章目标：TA 想达成什么" value="${escapeHtml(scene.goal)}">
                <input type="text" class="input scene-input" id="scene-conflict" placeholder="核心冲突：什么在阻碍 TA" value="${escapeHtml(scene.conflict)}">
                <input type="text" class="input scene-input" id="scene-outcome" placeholder="章末结果/转折：胜负或新悬念" value="${escapeHtml(scene.outcome)}">
                <button class="btn btn-outline btn-sm" onclick="saveSceneCard('${novelId}', ${chapterNum})">保存场景卡</button>
            </div>
        </div>
        <div class="action-buttons-row" style="margin-top: 12px;">
            <button class="btn btn-secondary" onclick="reviewThisChapter('${novelId}', ${chapterNum})">🔍 AI审稿</button>
            <button class="btn btn-primary" onclick="aiContinueChapter('${novelId}', ${chapterNum})">✨ AI续写本章</button>
        </div>
        <div class="action-buttons-row" style="margin-top: 8px;">
            <button class="btn btn-outline" onclick="navigateTo('beatControl', { novelId: '${novelId}', chapterNum: ${chapterNum} })">🎬 节拍控制</button>
            <button class="btn btn-outline" onclick="navigateTo('paragraphEdit', { novelId: '${novelId}', chapterNum: ${chapterNum} })">📄 分段编辑</button>
            <button class="btn btn-outline" onclick="aiReaderSimulate('${novelId}', ${chapterNum})">🎭 AI读者</button>
        </div>
        <div class="action-buttons-row" style="margin-top: 8px;">
            <button class="btn btn-outline" onclick="generateChapterSummary('${novelId}', ${chapterNum})">📝 生成摘要</button>
            <button class="btn btn-outline" onclick="showChapterHistory('${novelId}', ${chapterNum})">🕘 历史版本</button>
            <button class="btn btn-outline" onclick="showResearchSheet('${novelId}')">🔎 查资料</button>
            <button class="btn btn-outline" onclick="navigateTo('listen', { novelId: '${novelId}', chapterNum: ${chapterNum} })">🎧 听稿</button>
            <button class="btn btn-outline" onclick="checkChapterHook('${novelId}', ${chapterNum})">🪝 章末钩子</button>
        </div>
    `;

    bindEditorAutosave(novelId, chapterNum);
}

// ===== 编辑器自动保存 =====
// 之前只有右上角一个「保存」按钮，切后台被系统回收就整章丢失。
// 这里做：输入后 1 秒落盘、切后台立刻落盘、离开页面前强制落盘。
// 自动保存不写版本历史（saveChapter 的 archive:false），版本只保留有意义的快照。
let __editorFlush = null;

// 全局只注册一次：切后台 / 页面卸载时，如果编辑器还挂着，立刻保存
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && __editorFlush) __editorFlush();
});
window.addEventListener('pagehide', () => { if (__editorFlush) __editorFlush(); });

function bindEditorAutosave(novelId, chapterNum) {
    const titleEl = document.getElementById('chapter-title');
    const bodyEl = document.getElementById('chapter-content');
    const statusEl = document.getElementById('editor-save-status');
    if (!titleEl || !bodyEl) return;

    let timer = null;
    let lastSaved = `${titleEl.value}\u0000${bodyEl.value}`;
    let saving = false;
    let pending = false;

    const setStatus = (text, cls) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'editor-save-state' + (cls ? ' ' + cls : '');
    };

    const flush = async () => {
        if (timer) { clearTimeout(timer); timer = null; }
        const snapshot = `${titleEl.value}\u0000${bodyEl.value}`;
        if (snapshot === lastSaved) return;
        if (saving) { pending = true; return; }

        saving = true;
        try {
            await novelManager.saveChapter(
                novelId, chapterNum,
                titleEl.value.trim() || `第${chapterNum}章`,
                bodyEl.value, null, { archive: false }
            );
            lastSaved = snapshot;
            const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            setStatus(`已自动保存 ${t}`);
        } catch (e) {
            // 配额满等情况必须让用户看见，否则会以为已经存上了
            setStatus('保存失败：' + e.message, 'err');
        } finally {
            saving = false;
            if (pending) { pending = false; flush(); }
        }
    };

    const schedule = () => {
        setStatus('未保存…', 'dirty');
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 1000);
    };

    titleEl.addEventListener('input', schedule);
    bodyEl.addEventListener('input', schedule);
    __editorFlush = flush;
}

// 场景卡折叠 / 保存
function toggleSceneCard() {
    const body = document.getElementById('scene-card-body');
    const toggle = document.getElementById('scene-card-toggle');
    if (!body || !toggle) return;
    const show = body.style.display === 'none';
    body.style.display = show ? 'block' : 'none';
    toggle.textContent = show ? '▼' : '▶';
}

async function saveSceneCard(novelId, chapterNum) {
    try {
        await novelManager.saveChapterScene(novelId, chapterNum, {
            pov: document.getElementById('scene-pov')?.value || '',
            goal: document.getElementById('scene-goal')?.value || '',
            conflict: document.getElementById('scene-conflict')?.value || '',
            outcome: document.getElementById('scene-outcome')?.value || ''
        });
        document.getElementById('scene-card')?.classList.add('scene-card-filled');
        ui.showToast('场景卡已保存，AI 写作时会按此结构成文');
    } catch (e) {
        ui.showToast('保存失败: ' + e.message);
    }
}

// 生成章节摘要：后续章节的上下文会用到，避免长篇失忆
async function generateChapterSummary(novelId, chapterNum) {
    try {
        ui.showToast('AI 正在生成摘要...');
        const summary = await ai.summarizeChapter(novelId, chapterNum);
        ui.showToast('摘要已保存');
        navigateTo('chapterEdit', { novelId, chapterNum });
    } catch (e) {
        ui.showToast('摘要生成失败: ' + e.message);
    }
}

async function showChapterHistory(novelId, chapterNum) {
    const versions = await novelManager.listChapterVersions(novelId, chapterNum);
    const body = versions.length === 0
        ? '<div class="empty-state"><div class="empty-title">暂无历史版本</div><div class="empty-desc">每次保存/覆盖时会自动存档旧内容</div></div>'
        : versions.map(v => `
            <div class="version-item">
                <div class="version-meta">
                    <div class="version-time">${formatDate(v.created)} · ${v.wordCount || 0} 字</div>
                    <div class="version-title">${escapeHtml(v.title || '')}</div>
                    <div class="version-preview">${escapeHtml((v.content || '').substring(0, 80))}…</div>
                </div>
                <div class="version-actions">
                    <button class="btn btn-outline btn-sm" onclick="previewChapterVersion('${v.id}')">查看</button>
                    <button class="btn btn-primary btn-sm" onclick="confirmRestoreVersion('${v.id}', '${novelId}', ${chapterNum})">回滚</button>
                </div>
            </div>`).join('');
    const modal = createModal('🕘 历史版本', `<div class="version-list">${body}</div>`);
    modal.show();
}

async function previewChapterVersion(versionId) {
    const v = await db.get('versions', versionId);
    if (!v) { ui.showToast('版本不存在'); return; }
    createModal('版本内容', `<div style="white-space: pre-wrap; max-height: 60vh; overflow-y: auto; font-size: 14px; line-height: 1.7;">${escapeHtml(v.content || '')}</div>`).show();
}

async function confirmRestoreVersion(versionId, novelId, chapterNum) {
    if (!confirm('回滚会用该版本覆盖当前内容（当前内容也会存档，可再回滚回来）。确定继续？')) return;
    try {
        await novelManager.restoreChapterVersion(versionId);
        ui.showToast('已回滚到所选版本');
        closeModal();
        navigateTo('chapterEdit', { novelId, chapterNum });
    } catch (e) {
        ui.showToast('回滚失败: ' + e.message);
    }
}

// ===== 全书追读力体检（v2.9.0，对标 webnovel-writer 追读力系统）=====
async function runReaderAudit(novelId) {
    try {
        const novel = await novelManager.get(novelId);
        const chapters = await novelManager.listChapters(novelId);
        const fs = await novelManager.listForeshadowing(novelId);
        if (!chapters.length) { ui.showToast('还没有章节，先让 AI 写几章'); return; }
        closeModal();
        ui.showToast('AI 读者正在通读全书...');
        const result = await ai.readerAudit(novel, chapters, fs);
        const report = parseReaderAudit(result);
        if (!report) { ui.showToast('体检报告解析失败，请重试'); return; }
        // 存档报告（最多 10 份）
        const entry = { created: Date.now(), ...report };
        if (!Array.isArray(novel.readerAudits)) novel.readerAudits = [];
        novel.readerAudits.unshift(entry);
        if (novel.readerAudits.length > 10) novel.readerAudits = novel.readerAudits.slice(0, 10);
        await novelManager.update(novel);
        showReaderAuditModal(novelId);
    } catch (e) {
        ui.showToast('体检失败: ' + e.message);
    }
}

function parseReaderAudit(text) {
    let cleaned = String(text || '').replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
    let data = null;
    try { data = JSON.parse(cleaned); } catch (_) {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) { try { data = JSON.parse(m[0]); } catch (_) {} }
    }
    if (!data || !data.scores) return null;
    const s = data.scores;
    return {
        scores: {
            hook: clampScore(s.hook),
            payoff: clampScore(s.payoff),
            anticipation: clampScore(s.anticipation),
            prose: clampScore(s.prose)
        },
        debts: Array.isArray(data.debts) ? data.debts.filter(d => d && d.detail).slice(0, 10) : [],
        highlights: Array.isArray(data.highlights) ? data.highlights.slice(0, 6) : [],
        verdict: String(data.verdict || '').slice(0, 300)
    };
}

function clampScore(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(10, n));
}

const READER_AUDIT_DIMS = [
    { key: 'hook', label: '钩子', desc: '开头抓人、章章有悬念' },
    { key: 'payoff', label: '爽点', desc: '压抑-释放是否到位' },
    { key: 'anticipation', label: '期待感', desc: '让读者想追下一章' },
    { key: 'prose', label: '文笔', desc: '文字质感与画面感' }
];

function scoreColor(v) {
    if (v >= 8) return 'var(--primary)';
    if (v >= 6) return '#f59e0b';
    return '#ef4444';
}

async function showReaderAuditModal(novelId) {
    const novel = await novelManager.get(novelId);
    const audits = (novel && Array.isArray(novel.readerAudits)) ? novel.readerAudits : [];
    if (!audits.length) {
        const modal = createModal('📈 读者体检', `
            <div class="draft-hint">以资深读者视角通读全书：四维打分（钩子/爽点/期待感/文笔）+ 追读债务清单（未兑现爽点、逾期伏笔、人设松动、节奏拖沓）。</div>
            <button class="btn btn-primary btn-block" style="margin-top:12px;" onclick="runReaderAudit('${novelId}')">🔍 开始体检</button>`);
        modal.show();
        return;
    }
    const latest = audits[0];
    const chapters = await novelManager.listChapters(novelId);
    const hasChapter = (n) => chapters.some(c => c.number === Number(n));
    const body = `
        <div class="audit-scores">
            ${READER_AUDIT_DIMS.map(d => `
                <div class="audit-dim">
                    <div class="audit-dim-num" style="color:${scoreColor(latest.scores[d.key])}">${latest.scores[d.key]}</div>
                    <div class="audit-dim-label">${d.label}</div>
                    <div class="audit-dim-desc">${d.desc}</div>
                </div>`).join('')}
        </div>
        ${latest.verdict ? `<div class="audit-verdict">总评：${escapeHtml(latest.verdict)}</div>` : ''}
        <div class="audit-section-title">💳 追读债务（${latest.debts.length}）</div>
        ${latest.debts.length === 0 ? '<div class="audit-empty">暂无债务，读者追读体验健康</div>' : latest.debts.map((d, i) => `
            <div class="audit-debt">
                <div class="audit-debt-head">
                    <span class="audit-debt-type">${escapeHtml(d.type || '问题')}</span>
                    ${d.chapter && hasChapter(d.chapter) ? `<button class="btn btn-outline btn-sm" onclick="closeModal();navigateTo('chapterEdit', { novelId: '${novelId}', chapterNum: ${Number(d.chapter)} })">第${Number(d.chapter)}章 →</button>` : ''}
                </div>
                <div class="audit-debt-detail">${escapeHtml(d.detail || '')}</div>
                ${d.suggestion ? `<div class="audit-debt-sugg">建议：${escapeHtml(d.suggestion)}</div>` : ''}
            </div>`).join('')}
        ${latest.highlights.length ? `
        <div class="audit-section-title">✨ 亮点</div>
        <div class="audit-highlights">${latest.highlights.map(h => `<div class="audit-hl">• ${escapeHtml(h)}</div>`).join('')}</div>` : ''}
        ${audits.length > 1 ? `
        <div class="audit-section-title">🕘 历史报告（${audits.length}）</div>
        <div class="audit-history">
            ${audits.map((a, i) => `
                <div class="audit-history-item ${i === 0 ? 'current' : ''}">
                    <span>${formatDate(a.created)}</span>
                    <span class="audit-history-scores">钩${a.scores.hook} 爽${a.scores.payoff} 期${a.scores.anticipation} 文${a.scores.prose} · 债务${a.debts.length}</span>
                </div>`).join('')}
        </div>` : ''}
        <div class="draft-actions" style="margin-top:14px;">
            <button class="btn btn-outline" onclick="runReaderAudit('${novelId}')">重新体检</button>
        </div>`;
    const modal = createModal(`📈 读者体检 · ${formatDate(latest.created)}`, body);
    modal.show();
}

// ===== Writing Page =====
function renderWriting(container) {
    ui.setPageTitle('写作');
    ui.setHeaderActions();

    container.innerHTML = `
        <div class="card">
            <div class="card-title">✨ AI 智能写作</div>
            <div class="card-subtitle">选择作品开始创作</div>
            <select class="input" id="writing-novel-select" style="margin-bottom: 12px;">
                <option value="">选择作品...</option>
                ${store.novels.map(n => `<option value="${escapeAttr(n.id)}">${escapeHtml(n.title)}</option>`).join('')}
            </select>
            <input type="number" class="input" id="writing-chapter-num" placeholder="章节号（如：1）" style="margin-bottom: 12px;">
            <textarea class="textarea" id="writing-prompt" placeholder="输入写作提示（可选）：本章剧情走向、必须出场的角色、要埋的伏笔..."></textarea>
            <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--text-secondary);">
                <input type="checkbox" id="writing-draftmode">
                草稿模式（先生成草稿、我确认后再写入。默认 AI 直接写成，可撤回）
            </label>
            <button class="btn btn-primary btn-block" style="margin-top: 12px;" onclick="startWriting()">🤖 开始写作</button>
        </div>
        <div class="card" style="margin-top: 12px;">
            <div class="card-title">📊 写作统计</div>
            <div class="stats-grid">
                <div class="stat-item"><div class="stat-value">0</div><div class="stat-label">今日字数</div></div>
                <div class="stat-item"><div class="stat-value">0</div><div class="stat-label">今日章节</div></div>
                <div class="stat-item"><div class="stat-value">0</div><div class="stat-label">连续天数</div></div>
            </div>
        </div>`;
}

// ===== Settings Page (v2.2.0 - stats moved to bookshelf) =====
async function renderSettings(container) {
    ui.setPageTitle('设置');
    ui.setHeaderActions();

    const config = await settings.getModelConfig();
    let tplCount = 0;
    try {
        const tpls = await db.getAll('templates');
        tplCount = tpls.length;
    } catch (e) { tplCount = 0; }

    container.innerHTML = `
        <div class="settings-group">
            <div class="settings-group-title">AI 提供商</div>
                <div class="settings-item" onclick="showModelConfigModal()">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M6 8h.01M10 8h.01M14 8h.01M18 8h.01"/></svg></div>
                    <div>
                        <div class="settings-label">模型配置</div>
                        <div class="settings-value" id="model-config-display">加载中…</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('skillCenter')">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
                    <div>
                        <div class="settings-label">Skill 管理</div>
                        <div class="settings-value">浏览、导入与管理写作技能</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('skillPlaza')">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><path d="M3 3h18v18H3zM9 9h6v6H9zM3 9h6M15 9h6M3 15h18M9 3v6M15 3v6M9 15v6M15 15v6"/></svg></div>
                    <div>
                        <div class="settings-label">Skill 广场</div>
                        <div class="settings-value">发现与分享写作技能</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('paramConfig')">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg></div>
                    <div>
                        <div class="settings-label">参数配置</div>
                        <div class="settings-value">温度、上下文窗口、系统提示词</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('research')">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></div>
                    <div>
                        <div class="settings-label">查资料</div>
                        <div class="settings-value">联网检索，结果可沉淀进作品资料库</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('sync')">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-9 9M3 12a9 9 0 0 1 9-9"/><path d="M3 12a9 9 0 0 0 9 9"/><path d="M12 3v18"/><path d="M8 7l4-4 4 4M8 17l4 4 4-4"/></svg></div>
                    <div>
                        <div class="settings-label">多设备同步</div>
                        <div class="settings-value">WebDAV 快照同步，换机不丢稿</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="showDailyGoalSetting()">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
                    <div>
                        <div class="settings-label">每日写作目标</div>
                        <div class="settings-value">给自己一个每天的字数</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('dataManage')">
                <div class="settings-item-left">
                    <div class="settings-icon"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div>
                    <div>
                        <div class="settings-label">数据管理</div>
                        <div class="settings-value">备份与恢复（建议定期备份）</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>

    <div class="settings-group">
        <div class="settings-group-title">关于</div>
        <div class="settings-item">
            <div class="settings-item-left">
                <div class="settings-icon"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 4v16"/></svg></div>
                <div>
                    <div class="settings-label">版本</div>
                    <div class="settings-value">${CONFIG.VERSION}</div>
                </div>
            </div>
        </div>
    </div>
</div>`;

    // 更新模型配置显示
    const displayEl = document.getElementById('model-config-display');
    if (displayEl) {
        const providerMap = {
            'glm': '智谱',
            'deepseek': 'DeepSeek',
            'gpt': 'OpenAI',
            'claude': 'Anthropic'
        };
        const detectProvider = (model) => {
            if (!model) return 'custom';
            for (const [prefix, name] of Object.entries(providerMap)) {
                if (model.toLowerCase().startsWith(prefix)) return name;
            }
            return 'custom';
        };
        const friendlyProvider = detectProvider(config.model);
        const hasKey = config.apiKey ? '<span class="status-dot ok"></span>已配置' : '<span class="status-dot err"></span>未配置';
        displayEl.innerHTML = `${friendlyProvider} · ${config.model || '未选'} ${hasKey}`;
    }
}

// ===== Param Config Page (v2.3.0) =====
async function renderParamConfig(container) {
    ui.setPageTitle('参数配置');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('settings')">返回</button>`);

    const cfg = await settings.getRunConfig();

    container.innerHTML = `
        <div class="settings-group">
            <div class="settings-group-title">生成参数</div>
            <div class="param-block">
                <div class="param-row">
                    <div>
                        <div class="param-label">温度 <span class="param-value-inline" id="param-temp-val">${cfg.temperature}</span></div>
                        <div class="param-hint">越大创作越自由（0.0-2.0），越小回答越稳定</div>
                    </div>
                    <input type="range" id="param-temp" class="param-range" min="0" max="2" step="0.1" value="${cfg.temperature}" oninput="updateTempLabel(this.value)">
                </div>
                <div class="param-row">
                    <div>
                        <div class="param-label">上下文窗口</div>
                        <div class="param-hint">单次对话保留的最大 token 数，超出部分将被截断</div>
                    </div>
                    <input type="number" id="param-context" class="param-input" value="${cfg.contextWindow}" min="1024" max="131072" step="1024">
                </div>
                <div class="param-row">
                    <div>
                        <div class="param-label">最大输出</div>
                        <div class="param-hint">单次回复生成的最大 token 数</div>
                    </div>
                    <input type="number" id="param-output" class="param-input" value="${cfg.maxOutput}" min="256" max="32768" step="256">
                </div>
                <div class="param-row param-switch-row">
                    <div>
                        <div class="param-label">自动压缩上下文</div>
                        <div class="param-hint">超出窗口时自动摘要较早对话，保留最近内容</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="param-compress" ${cfg.autoCompress ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">系统提示词</div>
            <div class="param-block">
                <div class="param-row">
                    <div>
                        <div class="param-label">自定义系统提示词</div>
                        <div class="param-hint">注入到每次对话开头，可定义写作风格与角色（如：你是资深网文编辑…）</div>
                    </div>
                </div>
                <textarea id="param-prompt" class="param-textarea" rows="5" placeholder="例如：你是经验丰富的网络小说编辑，回复用中文，善于调动读者情绪，注重爽点和节奏。">${escapeHtml(cfg.systemPrompt)}</textarea>
            </div>
        </div>

        <button class="btn-primary param-save-btn" onclick="saveParamConfig()">保存参数</button>`;
}

function updateTempLabel(v) {
    const el = document.getElementById('param-temp-val');
    if (el) el.textContent = parseFloat(v).toFixed(1);
}

async function saveParamConfig() {
    const cfg = {
        temperature: parseFloat(document.getElementById('param-temp').value) || 0.7,
        contextWindow: parseInt(document.getElementById('param-context').value, 10) || 8192,
        maxOutput: parseInt(document.getElementById('param-output').value, 10) || 4000,
        autoCompress: document.getElementById('param-compress').checked,
        systemPrompt: (document.getElementById('param-prompt').value || '').trim()
    };
    await settings.setRunConfig(cfg);
    ui.showToast('参数已保存');
}

// ===== Data Manage Page (v2.3.0) =====
async function renderDataManage(container) {
    ui.setPageTitle('数据备份与恢复');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('settings')">返回</button>`);

    // 统计各 store 数据量
    const stats = {};
    let totalRecords = 0;
    let totalBytes = 0;
    for (const store of db.STORES) {
        try {
            const records = await db.getAll(store);
            stats[store] = records.length;
            totalRecords += records.length;
            totalBytes += JSON.stringify(records).length;
        } catch (e) {
            stats[store] = 0;
        }
    }

    const fmt = (n) => n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB'
        : n >= 1024 ? (n / 1024).toFixed(1) + ' KB'
        : n + ' B';

    container.innerHTML = `
        <div class="data-stats">
            <div class="data-stat-card">
                <div class="data-stat-num">${stats.novels || 0}</div>
                <div class="data-stat-label">作品</div>
            </div>
            <div class="data-stat-card">
                <div class="data-stat-num">${stats.chapters || 0}</div>
                <div class="data-stat-label">章节</div>
            </div>
            <div class="data-stat-card">
                <div class="data-stat-num">${(stats.skills || 0) + (stats.skillStore || 0)}</div>
                <div class="data-stat-label">Skill</div>
            </div>
            <div class="data-stat-card">
                <div class="data-stat-num">${stats.memos || 0}</div>
                <div class="data-stat-label">备忘录</div>
            </div>
        </div>
        <div class="data-summary">共 ${totalRecords} 条记录 · 约 ${fmt(totalBytes)}</div>

        <div class="settings-group">
            <div class="settings-group-title">备份</div>
            <div class="param-block">
                <div class="param-row">
                    <div>
                        <div class="param-label">导出全部数据</div>
                        <div class="param-hint">将作品、章节、技能、备忘录等保存为一个 JSON 文件</div>
                    </div>
                </div>
                <button class="btn-primary params-btn" id="btn-export" onclick="exportAllData()">导出数据</button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">恢复</div>
            <div class="param-block">
                <div class="param-row">
                    <div>
                        <div class="param-label">导入备份文件</div>
                        <div class="param-hint">从 JSON 备份恢复。⚠️ 将覆盖当前全部本地数据</div>
                    </div>
                </div>
                <button class="btn-primary params-btn params-btn-danger" id="btn-import" onclick="document.getElementById('import-file').click()">选择备份文件导入</button>
                <input type="file" id="import-file" accept=".json,application/json" style="display:none" onchange="handleImportFile(this)">
            </div>
        </div>`;
}

async function exportAllData() {
    try {
        const btn = document.getElementById('btn-export');
        if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
        const data = await db.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const filename = `openwrite-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
        const mode = await exportDownloadBlob(blob, filename);
        await settings.set('lastBackupAt', Date.now());
        ui.showToast(mode === 'shared' ? '备份已生成，选择「保存到文件」即可' : '备份文件已导出');
    } catch (e) {
        ui.showToast('导出失败: ' + e.message);
    } finally {
        const btn = document.getElementById('btn-export');
        if (btn) { btn.disabled = false; btn.textContent = '导出数据'; }
    }
}

// 数据安全：作品只在本机，7 天没备份就主动提醒一次
async function checkBackupReminder() {
    try {
        if (!store.novels || store.novels.length === 0) return;
        const last = await settings.get('lastBackupAt', 0);
        const later = await settings.get('backupRemindLaterAt', 0);
        const day = 24 * 60 * 60 * 1000;
        const daysSince = last ? Math.floor((Date.now() - last) / day) : null;
        const need = !last || daysSince >= 7;
        if (!need) return;
        if (later && Date.now() - later < 3 * day) return; // 3 天内不重复打扰
        const words = (store.novels || []).reduce((s, n) => s + (n.wordCount || 0), 0);
        const modal = createModal('💾 建议备份一次', `
            <div class="draft-hint">作品数据只保存在这台设备上。清缓存、换机、卸载 App 都会丢失，且无法找回。</div>
            <div style="font-size: 14px; line-height: 1.8;">
                当前共 <b>${store.novels.length}</b> 部作品，约 <b>${words}</b> 字。<br>
                ${daysSince === null ? '你还没有做过任何备份。' : `距上次备份已 ${daysSince} 天。`}
            </div>
            <div class="draft-actions">
                <button class="btn btn-outline" onclick="settings.set('backupRemindLaterAt', Date.now()); closeModal();">稍后再说</button>
                <button class="btn btn-primary" onclick="closeModal(); navigateTo('dataManage');">立即备份</button>
            </div>`);
        modal.show();
    } catch (e) { /* 提醒失败不影响主流程 */ }
}

function handleImportFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!confirm('导入将覆盖当前全部本地数据，确定继续吗？')) {
        input.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const data = JSON.parse(reader.result);
            if (!data || typeof data !== 'object' || !data.stores) {
                throw new Error('不是有效的 OpenWrite 备份文件');
            }
            ui.showToast('正在恢复数据…');
            const r = await db.importAll(data);
            let msg = `已恢复 ${r.imported} 条`;
            if (r.droppedModel) msg += '，模型配置已保留本机设置';
            if (r.droppedSync) msg += '，同步配置已保留本机设置';
            if (r.dropped) msg += `，过滤 ${r.dropped} 条异常记录`;
            ui.showToast(msg, 3500);
            input.value = '';
            navigateTo('dataManage');
        } catch (e) {
            ui.showToast('导入失败: ' + e.message);
            input.value = '';
        }
    };
    reader.onerror = () => { ui.showToast('读取文件失败'); input.value = ''; };
    reader.readAsText(file);
}

// ===== About Page =====
function renderAbout(container) {
    ui.setPageTitle('关于');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('settings')">返回</button>`);

    container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px;">
            <div class="app-logo">✨</div>
            <h1 style="font-size: 24px; margin-bottom: 8px;">OpenWrite</h1>
            <div class="version-badge">版本 ${CONFIG.VERSION}</div>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 32px;">你的 AI 小说写作助手</p>
        </div>
        <div class="settings-group">
            <div class="settings-group-title">加入社区</div>
            <div class="settings-item" onclick="window.open('https://github.com/LiPu-jpg/Openwrite', '_blank')">
                <div class="settings-item-left">
                    <div class="settings-icon">💬</div>
                    <div><div class="settings-label">OpenWrite AI 写作交流群</div><div class="settings-value">群号 1106407987</div></div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>
        <div class="settings-group">
            <div class="settings-group-title">资源</div>
            <div class="settings-item">
                <div class="settings-item-left"><div class="settings-icon">📖</div><div><div class="settings-label">使用教程</div><div class="settings-value">快速上手指南</div></div></div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item">
                <div class="settings-item-left"><div class="settings-icon">💻</div><div><div class="settings-label">Windows 版下载</div><div class="settings-value">在电脑上获得完整写作体验</div></div></div>
                <span class="settings-arrow">›</span>
            </div>
        </div>
        <div style="text-align: center; padding: 32px 20px; color: var(--text-secondary); font-size: 12px;">
            <p>基于 OpenWrite 开源项目构建</p><p>Apache-2.0 License</p>
        </div>`;
}

// ===== Actions & Modals =====
function showCreateNovelModal() {
    const modal = createModal('新建作品', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">作品名称</label>
            <input type="text" class="input" id="new-novel-title" placeholder="输入作品名称..."></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">简介（可选）</label>
            <textarea class="textarea" id="new-novel-desc" placeholder="简单描述你的作品..." style="min-height: 80px;"></textarea></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">类型（可选）</label>
            <select class="input" id="new-novel-genre">
                <option value="">选择类型...</option>
                <option value="玄幻">玄幻</option><option value="仙侠">仙侠</option>
                <option value="都市">都市</option><option value="科幻">科幻</option>
                <option value="历史">历史</option><option value="悬疑">悬疑</option>
                <option value="言情">言情</option><option value="其他">其他</option>
            </select></div>
            <button class="btn btn-primary btn-block" onclick="createNovel()">手动创建</button>
            <button class="btn btn-secondary btn-block" onclick="createNovelWithAI()">AI 创建</button>
        </div>`);
    modal.show();
}

async function createNovelWithAI() {
    closeModal();
    // 进入对话页并启动小说创建引导会话
    navigateTo('chat');
    // 延迟一点确保页面渲染完成
    setTimeout(() => startNovelCreationGuide(), 300);
}

// ===== 对话式小说创建引导 (v2.7.1) =====
let novelGuideState = null;

function startNovelCreationGuide() {
    novelGuideState = {
        step: 0,
        answers: {},
        messagesBox: document.getElementById('chat-messages'),
        inputBox: document.getElementById('chat-input')
    };
    
    // 显示消息区域，隐藏 hero 和卡片
    const hero = document.querySelector('.chat-hero');
    const actionList = document.querySelector('.chat-action-list');
    if (hero) hero.style.display = 'none';
    if (actionList) actionList.style.display = 'none';
    if (novelGuideState.messagesBox) novelGuideState.messagesBox.style.display = 'flex';
    
    // 第一步：类型。允许模糊描述——很多人这时候脑子里只有一句画面
    addChatMessage('ai', '你好，我是你的写作搭档 ✨\n\n先说个大概：想写哪一类？（玄幻、都市、科幻、悬疑、历史…说不出具体的，描述一句画面也行）');
    setupGuideInputHandler('genre');
}

function addChatMessage(role, text, options = []) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg-row ${role}`;
    
    let optionsHtml = '';
    if (options.length > 0) {
        // 时间戳只能取一次：map 和 forEach 各自调 Date.now()，跨毫秒就会错开，
        // onclick 指向一个从没绑过的名字，按钮看着能点、实际没反应
        const ts = Date.now();
        optionsHtml = `<div class="msg-options">${options.map((opt, i) =>
            `<button class="msg-option-btn" onclick="window._guideOption${ts}_${i}()">${escapeHtml(opt.label)}</button>`
        ).join('')}</div>`;
        options.forEach((opt, i) => {
            window[`_guideOption${ts}_${i}`] = opt.action;
        });
    }
    
    msgDiv.innerHTML = `
        <div class="msg-bubble ${role}">
            ${escapeHtml(text).replace(/\n/g, '<br>')}
            ${optionsHtml}
        </div>`;
    box.appendChild(msgDiv);
    box.scrollTop = box.scrollHeight;
}

async function guideAnswer(key, value) {
    if (!novelGuideState) return;
    novelGuideState.answers[key] = value;
    
    // 显示用户回答
    addChatMessage('user', value);
    
    // 清除选项按钮（通过重新渲染消息）
    // 进入下一步
    novelGuideState.step++;
    await runGuideStep();
}

async function runGuideStep() {
    const { step, answers } = novelGuideState;

    if (step === 1) {
        addChatMessage('ai', `${answers.genre}，行。\n\n书名叫什么？没定就先随便取一个，后面能改。`);
        setupGuideInputHandler('title');
    } else if (step === 2) {
        // 关键一步：旧版在这里直接生成大纲，角色全是 AI 编的，作者没有代入感
        addChatMessage('ai', `《${answers.title}》，记下了。\n\n现在说主角——叫什么名字，是干什么的？一句话就够。`);
        setupGuideInputHandler('protagonist');
    } else if (step === 3) {
        addChatMessage('ai', `主角有了。\n\n他最想要什么，或者被什么事困住？这一条决定整本书往哪走。`, [
            { label: '想不出，你先拟一个', action: () => guideDraftAnswer('desire') },
            { label: '跳过', action: () => guideAnswer('desire', '（未定，由你按类型补）') }
        ]);
        setupGuideInputHandler('desire');
    } else if (step === 4) {
        addChatMessage('ai', `最后一件：这个世界有什么特别的规矩？\n\n比如「修行要先交命」「下雨天不能出门」。想不出就跳过，我按类型常规来。`, [
            { label: '跳过', action: () => guideAnswer('world', '（按类型常规设定）') }
        ]);
        setupGuideInputHandler('world');
    } else if (step === 5) {
        addChatMessage('ai', '够了，我按这些搭故事…');
        await generateNovelFromGuide();
    }
}

// 「你先拟一个」：把建议填进输入框，用户按发送才生效——保留最后决定权
async function guideDraftAnswer(key) {
    if (!novelGuideState) return;
    const a = novelGuideState.answers;
    const ctx = `类型：${a.genre}｜书名：${a.title}｜主角：${a.protagonist}`;
    const ask = key === 'desire'
        ? '给这个主角一个具体、有张力的核心欲望或困境。只输出一句话，不超过 20 字，不要解释、不要引号。'
        : '给这个世界一条具体、有记忆点的规矩。只输出一句话，不超过 25 字，不要解释、不要引号。';

    addChatMessage('ai', '我想想…');
    try {
        const r = await ai.chat([
            { role: 'system', content: '你是小说策划，回答必须极简，只给结论。' },
            { role: 'user', content: `${ctx}\n\n${ask}` }
        ], null, 200);
        const v = (r || '').trim().split('\n')[0].replace(/^["「『]|["」』]$/g, '').trim();
        if (v) {
            const input = document.getElementById('chat-input');
            if (input) { input.value = v; input.focus(); }
            addChatMessage('ai', `先拟这个：${v}\n\n按发送就用它，或者直接改成你的。`);
            return;
        }
    } catch (e) { /* 失败就退回自由输入 */ }
    addChatMessage('ai', '这个我一时没想好，你说个大概方向也行。');
}

function setupGuideInputHandler(expectedKey) {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    if (!input || !sendBtn) return;
    
    // 临时替换发送按钮行为
    const originalOnclick = sendBtn.onclick;
    sendBtn.onclick = async () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        
        novelGuideState.answers[expectedKey] = text;
        addChatMessage('user', text);
        novelGuideState.step++;
        
        // 恢复原始发送按钮
        sendBtn.onclick = originalOnclick;
        await runGuideStep();
    };
    
    // 也支持回车发送
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
        }
    };
}

async function generateNovelFromGuide() {
    const { answers } = novelGuideState;
    const genre = answers.genre || '小说';
    const title = answers.title || '未命名';
    
    try {
        // 旧版只把类型和书名给模型，角色和世界观全由它编——用户拿到的是别人的故事。
        // 现在把用户亲口说过的三件事当作硬约束传进去，模型只补缺口。
        const given = [];
        if (answers.protagonist) given.push(`主角：${answers.protagonist}`);
        if (answers.desire) given.push(`主角的核心欲望或困境：${answers.desire}`);
        if (answers.world) given.push(`世界设定：${answers.world}`);

        const prompt = `请为一部${genre}小说生成完整大纲，书名是《${title}》。

${given.length ? `以下是作者已经定下的设定，必须严格执行，不得改名、不得改成别的身份：
${given.join('\n')}
` : ''}
要求：
1. 10-15 章的章节大纲
2. 角色表：主角必须沿用上面的设定（名字一字不改）；另补 2-4 个配角，写清身份、性格、与主角的关系
3. 世界观简述：已有设定要接着写，不要另起一套；没给的才由你补
4. 故事梗概（100 字左右），要围绕主角的那个欲望或困境展开

请严格输出JSON格式（不要markdown代码块）：
{
  "outline": [
    {"chapter": 1, "title": "第一章标题", "summary": "本章概要"}
  ],
  "characters": [
    {"name": "角色名", "role": "主角", "description": "描述"}
  ],
  "worldbuilding": "世界观简述",
  "synopsis": "故事梗概"
}`;
        
        const result = await ai.chat([
            { role: 'system', content: '你是专业小说编辑，擅长根据简单想法扩展为完整大纲。' },
            { role: 'user', content: prompt }
        ], null, 4000);
        
        // 解析 JSON
        let plan = null;
        try {
            const cleaned = result.replace(/\`\`\`json?\s*/g, '').replace(/\`\`\`\s*/g, '').trim();
            plan = JSON.parse(cleaned);
        } catch (_) {
            const m = result.match(/\{[\s\S]*\}/);
            if (m) { try { plan = JSON.parse(m[0]); } catch (_) {} }
        }
        
        if (!plan || !plan.outline) {
            addChatMessage('ai', '抱歉，大纲生成遇到了问题。请手动创建小说吧。', [
                { label: '手动创建', action: () => { showCreateNovelModal(); novelGuideState = null; } }
            ]);
            return;
        }
        
        // 展示大纲给用户确认（书名使用用户输入的）
        const outlineText = (plan.outline || []).map(o => `第${o.chapter}章 ${o.title}`).join('\n');
        const charsText = (plan.characters || []).map(c => `• ${c.name}（${c.role}）：${c.description}`).join('\n');
        
        const givenLine = answers.protagonist
            ? `\n\n✍️ 主角按你说的：${answers.protagonist}${answers.desire ? `\n　 动机：${answers.desire}` : ''}`
            : '';
        addChatMessage('ai', `📖 大纲已生成！\n\n书名：《${title}》\n\n📋 章节规划：\n${outlineText}\n\n👥 主要角色：\n${charsText}${givenLine}\n\n确认创建这本小说吗？（角色名不对可以点重新生成，或创建后手动改）`, [
            { label: '✅ 确认创建', action: () => guideConfirmCreate(plan, title) },
            { label: '🔄 重新生成', action: () => { novelGuideState.step = 1; runGuideStep(); } },
            { label: '❌ 取消', action: () => { novelGuideState = null; addChatMessage('ai', '已取消。你可以随时重新点击「新书启航」开始。'); } }
        ]);
        
    } catch (e) {
        addChatMessage('ai', '生成失败：' + e.message, [
            { label: '手动创建', action: () => showCreateNovelModal() }
        ]);
    }
}

async function guideConfirmCreate(plan, title) {
    try {
        const novel = await novelManager.create(title || plan.title, plan.worldbuilding || '', '');
        
        // 保存大纲和角色
        if (plan.outline) {
            novel.outline = plan.outline;
        }
        if (plan.characters) {
            novel.characters = plan.characters.map(c => ({
                id: 'char_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                name: c.name,
                charName: c.name,
                role: c.role,
                description: c.description,
                novelId: novel.id
            }));
        }
        await novelManager.update(novel);
        
        addChatMessage('ai', `✅ 小说《${title || plan.title}》已创建！\n\n接下来想做什么？`, [
            { label: '✍️ 直接写第1章', action: () => { novelGuideState = null; navigateTo('chapterEdit', { novelId: novel.id, chapterNum: 1 }); } },
            { label: '📋 查看作品详情', action: () => { novelGuideState = null; navigateTo('novelDetail', { novelId: novel.id }); } },
            { label: '🗺️ 去多Agent协作', action: () => { novelGuideState = null; navigateTo('agentStudio', { novelId: novel.id }); } }
        ]);
        
    } catch (e) {
        addChatMessage('ai', '创建失败：' + e.message);
    }
}

async function createNovel() {
    const title = document.getElementById('new-novel-title').value.trim();
    const desc = document.getElementById('new-novel-desc').value.trim();
    const genre = document.getElementById('new-novel-genre').value;

    if (!title) { ui.showToast('请输入作品名称'); return; }

    try {
        await novelManager.create(title, desc, genre);
        ui.showToast('作品创建成功！');
        closeModal();
        navigateTo('bookshelf');
    } catch (err) {
        ui.showToast('创建失败: ' + err.message);
    }
}

// ===== AI 草稿候选制（v2.8.0）=====
// AI 生成的内容先进候选区，作者确认/修改后才写入正文，避免一键覆盖已有稿件。
function renderMessages(messages) {
    return (messages || []).map(m => `【${m.role}】\n${m.content}`).join('\n\n');
}

function showAIDraftModal(opts) {
    window.__aiDraft = { ...opts };
    const d = window.__aiDraft;
    const modal = createModal(opts.label || 'AI 草稿', `
        <div class="draft-hint">草稿模式（可选）：AI 产出候选，你确认/修改后才写入。默认写作模式为「直接成文」，写坏可一键撤回。</div>
        <div class="form-group">
            <label class="form-label">章节标题</label>
            <input type="text" class="form-input" id="draft-title" value="${escapeHtml(d.title || '')}">
        </div>
        <div class="form-group">
            <label class="form-label">正文（可直接修改后再采用）</label>
            <textarea class="form-input" id="draft-content" rows="12">${escapeHtml(d.content || '')}</textarea>
        </div>
        <div id="draft-prompt" style="display:none; max-height: 34vh; overflow-y: auto; background: var(--bg-secondary, #f6f6f9); padding: 10px; border-radius: 8px; font-size: 12px; white-space: pre-wrap;">${escapeHtml(renderMessages(d.messages))}</div>
        <div class="draft-actions">
            <button class="btn btn-outline" onclick="toggleDraftPrompt()">查看提示词</button>
            <button class="btn btn-outline" onclick="regenerateDraft()">重新生成</button>
            <button class="btn btn-outline" onclick="copyDraft()">复制</button>
            ${opts.mode === 'append' ? `<button class="btn btn-primary" onclick="appendDraft()">追加到当前章节</button>` : `<button class="btn btn-primary" onclick="adoptDraft()">采用并保存</button>`}
        </div>
    `);
    modal.show();
}

function toggleDraftPrompt() {
    const el = document.getElementById('draft-prompt');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function copyDraft() {
    await copyName(document.getElementById('draft-content')?.value || '');
}

async function regenerateDraft() {
    const d = window.__aiDraft;
    if (!d) return;
    try {
        const novel = await novelManager.get(d.novelId);
        const chapters = await novelManager.listChapters(d.novelId);
        ui.showToast('正在重新生成...');
        const content = await ai.continueChapter(novel, chapters, d.chapterNum, d.prompt || '');
        showAIDraftModal({ ...d, content, messages: ai.lastMessages });
    } catch (e) {
        ui.showToast('重新生成失败: ' + e.message);
    }
}

async function adoptDraft() {
    const d = window.__aiDraft;
    if (!d) return;
    const title = document.getElementById('draft-title')?.value.trim() || `第${d.chapterNum}章`;
    const content = document.getElementById('draft-content')?.value || '';
    if (!content.trim()) { ui.showToast('草稿内容为空'); return; }
    try {
        await novelManager.saveChapter(d.novelId, d.chapterNum, title, content);
        ui.showToast('已写入第' + d.chapterNum + '章');
        closeModal();
        navigateTo('chapterEdit', { novelId: d.novelId, chapterNum: d.chapterNum });
    } catch (e) {
        ui.showToast('保存失败: ' + e.message);
    }
}

async function appendDraft() {
    const d = window.__aiDraft;
    if (!d) return;
    const content = document.getElementById('draft-content')?.value || '';
    if (!content.trim()) { ui.showToast('草稿内容为空'); return; }
    const textarea = document.getElementById('chapter-content');
    if (textarea) {
        textarea.value += (textarea.value ? '\n\n' : '') + content;
        ui.showToast('已追加到编辑器，记得保存');
        closeModal();
        return;
    }
    // 编辑器未打开时，直接追加到已保存的章节内容后面
    try {
        const chapter = await novelManager.getChapter(d.novelId, d.chapterNum);
        const merged = (chapter && chapter.content ? chapter.content + '\n\n' : '') + content;
        await novelManager.saveChapter(d.novelId, d.chapterNum, (chapter && chapter.title) || `第${d.chapterNum}章`, merged);
        ui.showToast('已追加保存');
        closeModal();
        navigateTo('chapterEdit', { novelId: d.novelId, chapterNum: d.chapterNum });
    } catch (e) {
        ui.showToast('追加失败: ' + e.message);
    }
}

function showWriteChapterModal(novelId) {
    const modal = createModal('写新章节', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <input type="number" class="input" id="new-chapter-num" placeholder="章节号">
            <input type="text" class="input" id="new-chapter-title" placeholder="章节标题（留空则用 AI 生成的标题）">
            <textarea class="textarea" id="new-chapter-prompt" placeholder="写作提示（可选）：本章要发生的剧情、必须出场的角色..."></textarea>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary);">
                <input type="checkbox" id="new-chapter-draftmode">
                草稿模式（先生成草稿、我确认后再写入。默认 AI 直接写成，可撤回）
            </label>
            <button class="btn btn-primary btn-block" onclick="createAndWriteChapter('${novelId}')">开始写作</button>
        </div>`);
    modal.show();
}

async function createAndWriteChapter(novelId) {
    const num = parseInt(document.getElementById('new-chapter-num').value);
    const title = document.getElementById('new-chapter-title').value.trim();
    const prompt = document.getElementById('new-chapter-prompt').value.trim();
    const draftMode = document.getElementById('new-chapter-draftmode')?.checked;

    if (!num || num < 1) { ui.showToast('请输入有效的章节号'); return; }

    closeModal();

    // 可选的老路径：草稿候选确认制
    if (draftMode) {
        try {
            ui.showToast('AI 正在生成草稿...');
            const novel = await novelManager.get(novelId);
            const chapters = await novelManager.listChapters(novelId);
            const content = await ai.continueChapter(novel, chapters, num, prompt);
            const existing = chapters.find(c => c.number === num);
            showAIDraftModal({
                novelId,
                chapterNum: num,
                title: title || `第${num}章`,
                content,
                messages: ai.lastMessages,
                prompt,
                mode: existing ? 'append' : 'new',
                label: `AI 草稿 · 第${num}章`
            });
        } catch (err) {
            ui.showToast('写作失败: ' + err.message);
        }
        return;
    }

    // 默认路径：AI 直接成文（流式 → 写入 → 可撤回）
    await aiWriteChapterDirect(novelId, num, prompt, { mode: 'new', title });
}async function aiWriteNext(novelId) {
    const chapters = await novelManager.listChapters(novelId);
    const nextNum = (chapters.length > 0 ? Math.max(...chapters.map(c => c.number)) : 0) + 1;
    showWriteChapterModal(novelId);
    document.getElementById('new-chapter-num').value = nextNum;
}

async function saveAndBack(novelId, chapterNum) {
    const title = document.getElementById('chapter-title').value;
    const content = document.getElementById('chapter-content').value;
    try {
        await novelManager.saveChapter(novelId, chapterNum, title, content);
        __editorFlush = null;            // 已手动保存，避免离开时再写一次
        ui.showToast('章节已保存');
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        // 写库失败（配额满、被中止）必须明确告知，不能静默
        ui.showToast('保存失败：' + e.message, 4000);
    }
}

async function reviewThisChapter(novelId, chapterNum) {
    try {
        const novel = await novelManager.get(novelId);
        const chapter = await novelManager.getChapter(novelId, chapterNum);
        if (!chapter) { ui.showToast('章节不存在'); return; }

        ui.showToast('AI 正在审稿...');
        const review = await ai.reviewChapter(chapter.content, novel);

        const modal = createModal('AI 审稿结果', `<div style="white-space: pre-wrap; font-size: 14px; line-height: 1.6; max-height: 60vh; overflow-y: auto;">${review}</div>`);
        modal.show();
    } catch (err) {
        ui.showToast('审稿失败: ' + err.message);
    }
}

// ===== AI 主写流程（v2.9.0）=====
// 产品定位修正：AI 是正文的默认写手，用户通过对话补充设定。
// 生成采用「流式直接成文」：写进章节即自动存档旧版本（versions 表），
// 完成后底部出现结果条，可一键撤回——反悔能力由版本机制承担，
// 不再要求每次生成都手动确认。草稿确认制降级为可选开关（草稿模式）。

// 解析 AI 输出：第一行约定为「第N章 标题」，其余为正文
function parseAiChapterOutput(raw, chapterNum) {
    const text = String(raw || '').replace(/\r\n/g, '\n').trim();
    if (!text) return { title: `第${chapterNum}章`, content: '' };
    const lines = text.split('\n');
    const first = (lines[0] || '').trim();
    const m = first.match(/^第\s*\d+\s*章[：:，,\s]*(.*)$/);
    if (m) {
        const title = (m[1] || '').trim();
        const body = lines.slice(1).join('\n').replace(/^\s*\n/, '');
        return { title: title || `第${chapterNum}章`, content: body.trim() || text };
    }
    return { title: `第${chapterNum}章`, content: text };
}

// 写作进度浮层（流式字数 + 停止按钮）
function showWritingProgress(novelId, chapterNum, mode) {
    hideWritingProgress();
    const el = document.createElement('div');
    el.id = 'ai-write-progress';
    el.className = 'ai-write-progress';
    el.innerHTML = `
        <div class="awp-card">
            <div class="awp-title">🤖 AI 正在${mode === 'continue' ? '续写' : '写'}第${chapterNum}章</div>
            <div class="awp-count" id="awp-count">已生成 0 字</div>
            <div class="awp-hint">直接成文模式：写完后可一键撤回，历史版本随时可回滚</div>
            <button class="btn btn-outline btn-sm" onclick="abortAiWrite()">⏹ 停止并保存已写部分</button>
        </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('active'));
}

function updateWritingProgress(chars) {
    const el = document.getElementById('awp-count');
    if (el) el.textContent = `已生成 ${chars.toLocaleString()} 字`;
}

function hideWritingProgress() {
    const el = document.getElementById('ai-write-progress');
    if (el) el.remove();
}

// 当前进行中的 AI 写作控制句柄
let __aiWriteCtl = null;

async function aiWriteChapterDirect(novelId, chapterNum, prompt, opts = {}) {
    const mode = opts.mode || 'new'; // new=新建/覆盖  continue=追加续写
    if (__aiWriteCtl) { ui.showToast('AI 正在写作中，请先等待或停止'); return; }
    try {
        const novel = await novelManager.get(novelId);
        if (!novel) { ui.showToast('作品不存在'); return; }
        const chapters = await novelManager.listChapters(novelId);
        const existing = chapters.find(c => c.number === chapterNum);

        const controller = new AbortController();
        __aiWriteCtl = { controller, novelId, chapterNum, mode, existing, partial: '' };
        showWritingProgress(novelId, chapterNum, mode);

        let raw = '';
        try {
            raw = await ai.continueChapter(novel, chapters, chapterNum, prompt,
                (chunk, full) => {
                    __aiWriteCtl.partial = full;
                    updateWritingProgress(full.length);
                },
                controller.signal);
        } catch (err) {
            if (err && err.name === 'AbortError') {
                raw = __aiWriteCtl.partial;
                if (!raw.trim()) { hideWritingProgress(); __aiWriteCtl = null; ui.showToast('已停止，没有生成内容'); return; }
                await finishAiWrite(novelId, chapterNum, raw, mode, existing, true, opts.title);
            } else {
                hideWritingProgress();
                ui.showToast('AI 写作失败: ' + err.message);
            }
            __aiWriteCtl = null;
            return;
        }
        __aiWriteCtl = null;
        await finishAiWrite(novelId, chapterNum, raw, mode, existing, false, opts.title);
    } catch (err) {
        hideWritingProgress();
        __aiWriteCtl = null;
        ui.showToast('AI 写作失败: ' + err.message);
    }
}

function abortAiWrite() {
    if (__aiWriteCtl && __aiWriteCtl.controller) {
        __aiWriteCtl.controller.abort();
    }
}

// 写入完成：直接落库（saveChapter 会自动存档被覆盖的旧内容），弹出可撤回结果条
// 返回 savePromise，调用方可 await 写入完成
function finishAiWrite(novelId, chapterNum, raw, mode, existing, aborted, userTitle) {
    const parsed = parseAiChapterOutput(raw, chapterNum);
    if (!parsed.content.trim()) { hideWritingProgress(); ui.showToast('AI 没有产出正文'); return Promise.resolve(); }

    let finalTitle = existing ? existing.title : (userTitle || parsed.title);
    let finalContent = parsed.content;
    if (mode === 'continue' && existing) {
        finalContent = (existing.content ? existing.content + '\n\n' : '') + parsed.content;
    }
    // 快照写入前状态，供「撤回」
    const before = existing ? { title: existing.title, content: existing.content || '' } : null;

    return novelManager.saveChapter(novelId, chapterNum, finalTitle, finalContent)
        .then(() => {
            hideWritingProgress();
            showWriteResultBar({
                novelId, chapterNum, before, mode,
                wordCount: finalContent.length,
                aborted: !!aborted
            });
        })
        .catch(e => {
            hideWritingProgress();
            ui.showToast('保存失败: ' + e.message);
        });
}

// AI 写入结果条：查看 / 撤回
function showWriteResultBar(info) {
    const old = document.getElementById('ai-write-result');
    if (old) old.remove();
    // 撤回快照放内存，避免经 DOM  attribute 传大段正文
    window.__lastAiWrite = { novelId: info.novelId, chapterNum: info.chapterNum, before: info.before || null };
    const el = document.createElement('div');
    el.id = 'ai-write-result';
    el.className = 'ai-write-result';
    const modeText = info.aborted ? '已保存部分内容' : '已完成';
    el.innerHTML = `
        <div class="awr-text">✅ 第${info.chapterNum}章${modeText}（${info.wordCount.toLocaleString()} 字）</div>
        <div class="awr-actions">
            <button class="btn btn-primary btn-sm" onclick="openAfterAiWrite('${info.novelId}', ${info.chapterNum})">查看</button>
            <button class="btn btn-outline btn-sm" onclick="undoAiWrite()">撤回</button>
            <button class="awr-close" onclick="this.closest('.ai-write-result').remove()">✕</button>
        </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('active'));
    setTimeout(() => { if (el.isConnected) el.remove(); }, 15000);
}

function openAfterAiWrite(novelId, chapterNum) {
    const bar = document.getElementById('ai-write-result');
    if (bar) bar.remove();
    navigateTo('chapterEdit', { novelId, chapterNum });
}

// 撤回 AI 写入：恢复写入前快照（saveChapter 内部会再存一次版本，撤回本身也可撤销）
async function undoAiWrite() {
    const info = window.__lastAiWrite;
    if (!info) { ui.showToast('没有可撤回的 AI 写入'); return; }
    try {
        if (!info.before) {
            await novelManager.deleteChapter(info.novelId, info.chapterNum);
        } else {
            await novelManager.saveChapter(info.novelId, info.chapterNum, info.before.title, info.before.content);
        }
        const bar = document.getElementById('ai-write-result');
        if (bar) bar.remove();
        window.__lastAiWrite = null;
        ui.showToast('已撤回 AI 写入，可在历史版本中找回');
    } catch (e) {
        ui.showToast('撤回失败: ' + e.message);
    }
}

// 作品详情页一键直达：AI 直接写下一章（跳过弹窗）
async function aiWriteNextDirect(novelId) {
    const chapters = await novelManager.listChapters(novelId);
    const nextNum = (chapters.length > 0 ? Math.max(...chapters.map(c => c.number)) : 0) + 1;
    await aiWriteChapterDirect(novelId, nextNum, '', { mode: 'new' });
}

async function aiContinueChapter(novelId, chapterNum) {
    // AI 主写手：流式直接续写并追加进当前章节，可撤回
    await aiWriteChapterDirect(novelId, chapterNum, '', { mode: 'continue' });
}

async function startWriting() {
    const novelId = document.getElementById('writing-novel-select').value;
    const chapterNum = parseInt(document.getElementById('writing-chapter-num').value);
    const prompt = document.getElementById('writing-prompt').value.trim();
    const draftMode = document.getElementById('writing-draftmode')?.checked;

    if (!novelId) { ui.showToast('请选择作品'); return; }
    if (!chapterNum || chapterNum < 1) { ui.showToast('请输入有效的章节号'); return; }

    // 可选的老路径：草稿候选确认制
    if (draftMode) {
        try {
            const novel = await novelManager.get(novelId);
            const chapters = await novelManager.listChapters(novelId);
            ui.showToast('AI 正在生成草稿...');
            const content = await ai.continueChapter(novel, chapters, chapterNum, prompt);
            const existing = chapters.find(c => c.number === chapterNum);
            showAIDraftModal({
                novelId,
                chapterNum,
                title: existing ? existing.title : `第${chapterNum}章`,
                content,
                messages: ai.lastMessages,
                prompt,
                mode: existing ? 'append' : 'new',
                label: `AI 草稿 · 第${chapterNum}章`
            });
        } catch (err) {
            ui.showToast('写作失败: ' + err.message);
        }
        return;
    }

    // 默认路径：AI 直接成文
    await aiWriteChapterDirect(novelId, chapterNum, prompt, { mode: 'new' });
}

async function showModelConfigModal() {
    // 读取已保存的配置，预填充到弹窗
    const saved = await settings.getModelConfig();
    const isCustom = saved.model && !['glm-5.1','glm-4.5','glm-4','deepseek-chat','deepseek-reasoner','deepseek-v4-flash','gpt-4o','gpt-4','gpt-3.5-turbo','claude-3.5-sonnet'].includes(saved.model);
    const modelValue = isCustom ? 'custom' : (saved.model || 'deepseek-chat');
    const customModelValue = isCustom ? (saved.model || '') : '';
    const apiKeyValue = saved.apiKey || '';
    const baseUrlValue = saved.baseUrl || '';

    const modal = createModal('模型配置', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">API Key</label>
            <input type="password" class="input" id="model-api-key" placeholder="输入你的 API Key..." value="${escapeHtml(apiKeyValue)}"></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">模型</label>
            <select class="input" id="model-name" onchange="toggleCustomModelRow()">
                <option value="glm-5.1" ${modelValue==='glm-5.1'?'selected':''}>GLM-5.1（智谱）</option>
                <option value="glm-4.5" ${modelValue==='glm-4.5'?'selected':''}>GLM-4.5（智谱）</option>
                <option value="glm-4" ${modelValue==='glm-4'?'selected':''}>GLM-4（智谱）</option>
                <option value="deepseek-chat" ${modelValue==='deepseek-chat'?'selected':''}>DeepSeek Chat</option>
                <option value="deepseek-reasoner" ${modelValue==='deepseek-reasoner'?'selected':''}>DeepSeek Reasoner</option>
                <option value="deepseek-v4-flash" ${modelValue==='deepseek-v4-flash'?'selected':''}>DeepSeek V4 Flash（可联网）</option>
                <option value="gpt-4o" ${modelValue==='gpt-4o'?'selected':''}>GPT-4o</option>
                <option value="gpt-4" ${modelValue==='gpt-4'?'selected':''}>GPT-4</option>
                <option value="gpt-3.5-turbo" ${modelValue==='gpt-3.5-turbo'?'selected':''}>GPT-3.5 Turbo</option>
                <option value="claude-3.5-sonnet" ${modelValue==='claude-3.5-sonnet'?'selected':''}>Claude 3.5 Sonnet（需兼容网关）</option>
                <option value="custom" ${modelValue==='custom'?'selected':''}>自定义模型名</option>
            </select></div>
            <div id="custom-model-row" style="display:${isCustom?'block':'none'};"><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">模型名</label>
            <input type="text" class="input" id="model-custom-name" placeholder="如：glm-5.1" value="${escapeHtml(customModelValue)}"></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">Base URL（可选）</label>
            <input type="text" class="input" id="model-base-url" placeholder="https://api.deepseek.com" value="${escapeHtml(baseUrlValue)}"></div>
            <button class="btn btn-primary btn-block" onclick="configureModel()">保存配置</button>
        </div>`);
    modal.show();
}

function toggleCustomModelRow() {
    const select = document.getElementById('model-name');
    const row = document.getElementById('custom-model-row');
    if (select && row) {
        row.style.display = select.value === 'custom' ? 'block' : 'none';
    }
}

async function configureModel() {
    const apiKey = document.getElementById('model-api-key').value.trim();
    let model = document.getElementById('model-name').value;
    const baseUrl = document.getElementById('model-base-url').value.trim();
    if (model === 'custom') {
        model = document.getElementById('model-custom-name').value.trim();
        if (!model) { ui.showToast('请输入自定义模型名'); return; }
    }

    if (!apiKey) { ui.showToast('请输入 API Key'); return; }

    // Anthropic 官方接口是 /v1/messages + x-api-key，和本应用使用的 OpenAI 兼容格式对不上。
    // 选了 Claude 却把地址留空或填 api.anthropic.com，请求必然 404，而报错发生在保存之后，
    // 用户会误以为是 Key 的问题。保存前先说明。
    if (/^claude/i.test(model)) {
        const target = (baseUrl || '').toLowerCase();
        if (!baseUrl || target.includes('anthropic.com')) {
            ui.showToast('Claude 要填 OpenAI 兼容网关地址（如 OpenRouter），Anthropic 官方接口不兼容', 5200);
        }
    }

    try {
        const providerMap = {
            'glm': '智谱',
            'deepseek': 'DeepSeek',
            'gpt': 'OpenAI',
            'claude': 'Anthropic'
        };
        const detectProvider = (model) => {
            if (!model) return 'custom';
            for (const [prefix, name] of Object.entries(providerMap)) {
                if (model.toLowerCase().startsWith(prefix)) return name;
            }
            return 'custom';
        };
        const friendlyProvider = detectProvider(model);
        const hasKey = apiKey ? ' ✅已配置' : ' ❌未配置';
        const displayText = `${friendlyProvider} · ${model || '未选'}${hasKey}`;
        
        await settings.setModelConfig({
            provider: friendlyProvider,
            model,
            apiKey,
            baseUrl: baseUrl || undefined
        });
        ui.showToast(`模型配置成功！${displayText}`);
        closeModal();
        // 如果当前在设置页，刷新设置页显示
        if (store.currentPage === 'settings') {
            const container = document.getElementById('page-settings');
            if (container) renderSettings(container);
        }
    } catch (err) {
        ui.showToast('配置失败: ' + err.message);
    }
}

// ===== Modal System =====
function createModal(title, content) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title">${title}</div>
                <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            </div>
            <div class="modal-body">${content}</div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    return { show: () => overlay.classList.add('active'), close: () => overlay.remove() };
}

function closeModal() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) modal.remove();
}

// ===== Utilities =====
function formatDate(timestamp) {
    if (!timestamp) return '未知';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
    return date.toLocaleDateString('zh-CN');
}

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW registered'))
            .catch(err => console.log('SW failed', err));
    });
}

// ===== Global Store =====
const store = {
    currentPage: 'chat',
    currentParams: {},          // 当前页面参数，供返回时还原
    webSearchOn: false,         // 聊天页联网开关（持久化在 localStorage）
    searchCount: 0,             // 本次开启联网后已检索次数（不持久化）
    currentSessionId: 'main',   // 对话会话 id（老数据都在 main 下）
    currentNovel: null,
    currentChapter: null,
    novels: [],
    modelName: 'glm-5.1',
    activeChatSkill: null,      // 聊天中启用的技能
    lastPolish: null,           // 最近一次润色结果
    lastImitation: null,        // 最近一次仿写结果
    pendingDistillText: '',     // 待蒸馏文本
    pendingDistillName: '',     // 待蒸馏书名
    pendingDistillGenre: ''     // 待蒸馏类型
};

// ===== 通用工具 =====
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 统一 id 生成：时间戳 + 随机后缀。
// 同一毫秒内连续创建两条记录（如 AI 批量生成人物）会撞主键，put 会静默覆盖前一条。
function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// 属性值转义：escapeHtml 已覆盖引号，这里再挡一下反引号，供 onclick/option 等属性用
function escapeAttr(str) {
    return escapeHtml(str).replace(/`/g, '&#96;');
}

// ===== 使用教程 =====
function showTutorialModal() {
    const modal = createModal('使用教程', `
        <div class="tutorial-body">
            <div class="tutorial-section">
                <div class="tutorial-title">✨ 蒸馏 —— 学会一本好书的风格</div>
                <div class="tutorial-text">上传一本你喜欢的书（txt/md），AI 会分析作者的叙事视角、语言风格、人物塑造、节奏等，生成「风格档案」。之后点「用此风格写作」，输入你的创意，AI 就能模仿该作者的笔法创作。</div>
            </div>
            <div class="tutorial-section">
                <div class="tutorial-title">🧪 去AI味 —— 审查与润色</div>
                <div class="tutorial-text">把写好的章节粘贴进来选择「审查文本」，AI 会按 8 种 AI 味症状逐段诊断、给出评分和改写示范；选「全文润色」则直接按规则改写全文。聊天输入框点「@ 技能」可在对话中也启用该技能。</div>
            </div>
            <div class="tutorial-section">
                <div class="tutorial-title">✍️ 写作与审稿</div>
                <div class="tutorial-text">「小说」页可新建作品、写章节、AI 续写、AI 审稿（打分+建议）。编辑器右上角可以保存。</div>
            </div>
            <div class="tutorial-section">
                <div class="tutorial-title">⚙️ 先配置 AI 模型</div>
                <div class="tutorial-text">所有 AI 功能都需要 API Key：进入「设置 → 模型配置」，填入你的 DeepSeek / OpenAI / GLM 等接口的 Key 和模型名。</div>
            </div>
        </div>`);
    modal.show();
}

// 操作按钮上的 emoji 在真机是彩色图标，和纸墨界面打架；统一剥掉，只留文字。
// 注意：渲染函数是 async 的，navigateTo 里同步调用会拿到空容器，
// 所以用 MutationObserver 盯着 DOM，按钮一出现就处理。
const __EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

function stripOneButton(btn) {
    if (!btn || btn.children.length) return;          // 含图标的按钮不动
    const before = btn.textContent;
    const after = before.replace(__EMOJI_RE, '').replace(/\s+/g, ' ').trim();
    if (after && after !== before.trim()) btn.textContent = after;
}

function stripButtonEmoji(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.action-buttons-row .btn').forEach(stripOneButton);
    if (root.matches && root.matches('.action-buttons-row .btn')) stripOneButton(root);
}

const __emojiObserver = new MutationObserver(muts => {
    for (const m of muts) {
        m.addedNodes && m.addedNodes.forEach(node => {
            if (node.nodeType === 1) stripButtonEmoji(node);
        });
    }
});
document.addEventListener('DOMContentLoaded', () => {
    __emojiObserver.observe(document.body, { childList: true, subtree: true });
});

// ===== 返回 / 原生壳 =====
const ROOT_PAGES = ['chat', 'bookshelf', 'settings'];

function goBack(fallback = 'bookshelf') {
    const prev = pageHistory.pop();
    if (!prev || !prev.page) {
        if (store.currentPage !== fallback) navigateTo(fallback, {}, true);
        return;
    }
    const isRoot = ROOT_PAGES.includes(prev.page);
    __suppressHistoryPush = !isRoot;
    navigateTo(prev.page, prev.params || {}, isRoot);
}

function initNativeShell() {
    const C = window.Capacitor;
    if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return;
    const P = C.Plugins || {};

    // 页面已经渲染完，收掉启动图（之前配置无效，因为插件根本没装）
    if (P.SplashScreen) { try { P.SplashScreen.hide(); } catch (e) { /* 忽略 */ } }
    if (P.StatusBar) { try { P.StatusBar.setStyle({ style: 'LIGHT' }); } catch (e) { /* 忽略 */ } }

    // 安卓返回键：原来没接管，在章节页按返回会直接退出整个 App
    if (P.App) {
        P.App.addListener('backButton', () => {
            if (document.querySelector('.modal-overlay')) { closeModal(); return; }
            const drawer = document.getElementById('chat-drawer');
            if (drawer && drawer.classList.contains('active')) { closeChatDrawer(); return; }
            if (pageHistory.length) { goBack(); return; }
            if (!ROOT_PAGES.includes(store.currentPage)) { goBack('bookshelf'); return; }
            P.App.exitApp();
        });
    }
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize IndexedDB on first run
    try {
        await db.open();
        console.log('IndexedDB ready');
    } catch (err) {
        console.error('IndexedDB init failed:', err);
        ui.showToast('本地存储初始化失败，部分功能可能不可用');
    }

    // Load novels for select dropdowns
    try {
        store.novels = await novelManager.list();
    } catch (err) {
        console.error('Failed to load novels:', err);
    }

    // 数据只在本机，超过 7 天没备份时提醒一次
    await checkBackupReminder();

    // Default to chat page (matching competitor)
    navigateTo('chat');

    // 恢复上次的联网开关
    try {
        const wasOn = localStorage.getItem('ow_web_search') === '1';
        let allowRestore = wasOn;
        if (wasOn && localStorage.getItem('ow_search_cost_ack') !== '1') {
            // 升级上来的用户：DeepSeek 内置搜索可能已开始计费，先不自动联网
            const mc = await settings.getModelConfig().catch(() => null);
            const rc = await getResearchConfig().catch(() => null);
            const usingApi = rc && rc.mode === 'api' && rc.apiKey;
            const isDsBuiltin = !usingApi && mc &&
                (/deepseek/i.test(mc.model || '') || /deepseek/i.test(mc.baseUrl || ''));
            if (isDsBuiltin) {
                allowRestore = false;
                try { localStorage.setItem('ow_web_search', '0'); } catch (e) { /* 忽略 */ }
                ui.showToast('联网已暂停：DeepSeek 搜索按次计费，重新开启时会说明价格', 5000);
            }
        }
        store.webSearchOn = allowRestore;
        renderWebSearchBtn();
    } catch (e) { /* 忽略 */ }

    // 原生壳能力：启动图、状态栏、返回键（网页环境自动跳过）
    initNativeShell();

    // 配置过同步的话，启动后静默看一眼云端有没有新版本（失败不打扰）
    if (typeof maybeAutoCheckSync === 'function') setTimeout(() => maybeAutoCheckSync(), 2500);
});

// Prevent double-tap zoom
document.addEventListener('dblclick', (e) => { e.preventDefault(); }, { passive: false });

// ===== Skill Plaza System (v2.2.0) =====
const PLAZA_CATEGORIES = [
    { key: 'all', label: '全部', icon: '🔹' },
    { key: 'de-ai', label: '去AI润色', icon: '🧪' },
    { key: 'style', label: '风格文笔', icon: '✍️' },
    { key: 'pipeline', label: '全流程引擎', icon: '⚙️' },
    { key: 'outline', label: '大纲设定', icon: '📋' },
    { key: 'review', label: '审稿质检', icon: '🔍' },
    { key: 'tools', label: '工具效率', icon: '🛠️' },
    { key: 'genre', label: '题材专项', icon: '🎭' },
    { key: 'other', label: '其他', icon: '📦' }
];

const PLAZA_TYPES = [
    { key: 'all', label: '全部', icon: '🔹' },
    { key: 'default', label: '默认', icon: '📄' },
    { key: 'terminal', label: '终端', icon: '💻' }
];

const skillStoreManager = {
    async list() {
        try { return await db.getAll('skillStore'); } catch (e) { return []; }
    },
    async get(id) {
        try { return await db.get('skillStore', id); } catch (e) { return null; }
    },
    async put(skill) {
        await db.put('skillStore', skill);
    },
    async delete(id) {
        await db.delete('skillStore', id);
    },
    async getNickname() {
        try {
            const rec = await db.get('settings', 'plazaNickname');
            return rec ? rec.value : '';
        } catch (e) { return ''; }
    },
    async setNickname(nickname) {
        await db.put('settings', { key: 'plazaNickname', value: nickname, updated: Date.now() });
    }
};

function renderSkillPlaza(container) {
    ui.setPageTitle('Skill 广场');
    ui.setHeaderActions();
    store.plazaTab = store.plazaTab || 'browse';
    store.plazaFilterCategory = store.plazaFilterCategory || 'all';
    store.plazaFilterType = store.plazaFilterType || 'all';
    store.plazaSearch = store.plazaSearch || '';

    container.innerHTML = `
        <div class="plaza-header">
            <div class="plaza-header-icon">🏪</div>
            <div class="plaza-header-title">Skill 广场</div>
        </div>
        <div class="tab-nav" id="plaza-tabs">
            <button class="tab-item ${store.plazaTab === 'browse' ? 'active' : ''}" onclick="switchPlazaTab('browse')">浏览</button>
            <button class="tab-item ${store.plazaTab === 'upload' ? 'active' : ''}" onclick="switchPlazaTab('upload')">上传</button>
            <button class="tab-item ${store.plazaTab === 'my' ? 'active' : ''}" onclick="switchPlazaTab('my')">我的上传</button>
        </div>
        <div id="plaza-content"></div>
    `;

    const content = document.getElementById('plaza-content');
    if (store.plazaTab === 'browse') renderSkillPlazaBrowse(content);
    else if (store.plazaTab === 'upload') renderSkillPlazaUpload(content);
    else renderSkillPlazaMyUploads(content);
}

async function renderSkillPlazaBrowse(container) {
    const allSkills = await skillStoreManager.list();
    let filtered = allSkills;

    if (store.plazaFilterCategory !== 'all') {
        filtered = filtered.filter(s => (s.category || 'other') === store.plazaFilterCategory);
    }
    if (store.plazaFilterType !== 'all') {
        filtered = filtered.filter(s => (s.type || 'default') === store.plazaFilterType);
    }
    if (store.plazaSearch.trim()) {
        const kw = store.plazaSearch.trim().toLowerCase();
        filtered = filtered.filter(s =>
            (s.name || '').toLowerCase().includes(kw) ||
            (s.description || '').toLowerCase().includes(kw) ||
            (s.author || '').toLowerCase().includes(kw)
        );
    }

    const filterHtml = PLAZA_CATEGORIES.map(c =>
        `<button class="filter-chip ${store.plazaFilterCategory === c.key ? 'active' : ''}" onclick="togglePlazaCategory('${c.key}')">
            <span class="chip-icon">${c.icon}</span>${c.label}
        </button>`
    ).join('');

    const typeHtml = PLAZA_TYPES.map(t =>
        `<button class="filter-chip ${store.plazaFilterType === t.key ? 'active' : ''}" onclick="togglePlazaType('${t.key}')">
            <span class="chip-icon">${t.icon}</span>${t.label}
        </button>`
    ).join('');

    const searchHtml = `
        <div class="search-bar">
            <div class="search-input-wrapper">
                <span class="search-icon">🔍</span>
                <input type="text" class="search-input" id="plaza-search" placeholder="搜索Skill..." value="${escapeHtml(store.plazaSearch)}" oninput="plazaSearchInput(this.value)">
            </div>
            <select class="search-filter" onchange="plazaFilterChange(this.value)">
                <option value="latest">最新</option>
                <option value="popular">最热</option>
            </select>
        </div>
    `;

    const listHtml = filtered.length === 0
        ? `<div class="empty-state" style="padding: 40px 20px;">
            <div class="empty-icon">🏪</div>
            <div class="empty-title">暂无 Skill</div>
            <div class="empty-desc">去「上传」Tab 添加你的第一个 Skill 吧</div>
          </div>`
        : filtered.map(skill => `
            <div class="skill-plaza-card" onclick="downloadPlazaSkill('${skill.id}')">
                <div class="skill-avatar">${getAvatarForSkill(skill.name)}</div>
                <div class="skill-plaza-body">
                    <div class="skill-plaza-title">${escapeHtml(skill.name)}</div>
                    <div class="skill-plaza-desc">${escapeHtml(skill.description || '暂无描述')}</div>
                    <div class="skill-plaza-meta">
                        <span class="skill-plaza-author">by ${escapeHtml(skill.author || '匿名')}</span>
                        <span class="skill-plaza-downloads">⬇ ${formatDownloads(skill.downloads)}</span>
                    </div>
                </div>
                <button class="skill-download-btn" onclick="event.stopPropagation(); downloadPlazaSkill('${skill.id}')">下载</button>
            </div>
        `).join('');

    container.innerHTML = `
        ${searchHtml}
        <div class="filter-section">
            <div class="filter-row">${filterHtml}</div>
            <div class="filter-row">${typeHtml}</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">今日下载 0/10 次</div>
        </div>
        <div class="skill-list">${listHtml}</div>
    `;
}

async function renderSkillPlazaUpload(container) {
    const nickname = await skillStoreManager.getNickname();
    const builtinOptions = BUILTIN_SKILLS.map(s => `<option value="${s.id}">${s.icon} ${escapeHtml(s.name)}</option>`).join('');

    container.innerHTML = `
        <div class="upload-form">
            <div class="form-group">
                <label class="form-label">昵称设置</label>
                <div class="form-row">
                    <input type="text" class="form-input" id="plaza-nickname" placeholder="输入昵称（上传时显示）" value="${escapeHtml(nickname)}">
                    <button class="btn btn-secondary" style="white-space:nowrap;" onclick="savePlazaNickname()">保存昵称</button>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">选择 Skill</label>
                <select class="form-select" id="plaza-skill-select">
                    <option value="">选择要上传的 Skill</option>
                    ${builtinOptions}
                    <option value="custom">自定义 Skill...</option>
                </select>
            </div>
            <div id="plaza-custom-skill" style="display:none;">
                <div class="form-group">
                    <label class="form-label">Skill 名称</label>
                    <input type="text" class="form-input" id="plaza-custom-name" placeholder="输入 Skill 名称">
                </div>
                <div class="form-group">
                    <label class="form-label">Skill 内容</label>
                    <textarea class="form-textarea" id="plaza-custom-content" placeholder="粘贴 Skill 的完整提示词内容..."></textarea>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Skill 类型</label>
                <div class="filter-row">
                    <button class="filter-chip active" id="plaza-type-default" onclick="selectPlazaType('default')">📄 默认</button>
                    <button class="filter-chip" id="plaza-type-terminal" onclick="selectPlazaType('terminal')">💻 终端</button>
                </div>
                <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">使用提示词和参考文本，可在手机与电脑端使用。</div>
            </div>
            <div class="form-group">
                <label class="form-label">分类</label>
                <div class="filter-row">
                    ${PLAZA_CATEGORIES.slice(1).map(c =>
                        `<button class="filter-chip" id="plaza-cat-${c.key}" onclick="selectPlazaCategory('${c.key}')">${c.icon} ${c.label}</button>`
                    ).join('')}
                </div>
                <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">不选则按名称自动归类。</div>
            </div>
            <div class="form-group">
                <label class="form-label">描述</label>
                <textarea class="form-textarea" id="plaza-desc" placeholder="简要描述 Skill 的功能和用途..."></textarea>
            </div>
            <button class="upload-submit-btn" onclick="uploadPlazaSkill()">
                <span>☁️</span> 上传到广场
            </button>
        </div>
    `;

    document.getElementById('plaza-skill-select').addEventListener('change', function() {
        const customDiv = document.getElementById('plaza-custom-skill');
        customDiv.style.display = this.value === 'custom' ? 'block' : 'none';
    });
}

async function renderSkillPlazaMyUploads(container) {
    const allSkills = await skillStoreManager.list();
    const myNickname = await skillStoreManager.getNickname();
    const mySkills = allSkills.filter(s => s.author === myNickname || s.isLocal);

    const listHtml = mySkills.length === 0
        ? `<div class="empty-state" style="padding: 40px 20px;">
            <div class="empty-icon">📦</div>
            <div class="empty-title">暂无上传</div>
            <div class="empty-desc">你还没有上传过任何 Skill</div>
          </div>`
        : mySkills.map(skill => `
            <div class="skill-plaza-card">
                <div class="skill-avatar">${getAvatarForSkill(skill.name)}</div>
                <div class="skill-plaza-body">
                    <div class="skill-plaza-title">${escapeHtml(skill.name)}</div>
                    <div class="skill-plaza-desc">${escapeHtml(skill.description || '暂无描述')}</div>
                    <div class="skill-plaza-meta">
                        <span class="skill-plaza-author">by ${escapeHtml(skill.author || '匿名')}</span>
                        <span class="skill-plaza-downloads">⬇ ${formatDownloads(skill.downloads)}</span>
                    </div>
                </div>
                <button class="skill-download-btn" style="border-color:var(--danger);color:var(--danger);" onclick="deletePlazaSkill('${skill.id}')">删除</button>
            </div>
        `).join('');

    container.innerHTML = `<div class="skill-list">${listHtml}</div>`;
}

// ===== Plaza Actions =====
function switchPlazaTab(tab) {
    store.plazaTab = tab;
    const content = document.getElementById('plaza-content');
    document.querySelectorAll('#plaza-tabs .tab-item').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    if (tab === 'browse') renderSkillPlazaBrowse(content);
    else if (tab === 'upload') renderSkillPlazaUpload(content);
    else renderSkillPlazaMyUploads(content);
}

function plazaSearchInput(value) {
    store.plazaSearch = value;
    if (store.plazaTab === 'browse') {
        const content = document.getElementById('plaza-content');
        renderSkillPlazaBrowse(content);
    }
}

function plazaFilterChange(value) {
    // 排序逻辑预留
    ui.showToast('排序: ' + (value === 'popular' ? '最热' : '最新'));
}

function togglePlazaCategory(key) {
    store.plazaFilterCategory = store.plazaFilterCategory === key ? 'all' : key;
    if (store.plazaTab === 'browse') {
        const content = document.getElementById('plaza-content');
        renderSkillPlazaBrowse(content);
    }
}

function togglePlazaType(key) {
    store.plazaFilterType = store.plazaFilterType === key ? 'all' : key;
    if (store.plazaTab === 'browse') {
        const content = document.getElementById('plaza-content');
        renderSkillPlazaBrowse(content);
    }
}

function selectPlazaType(type) {
    document.querySelectorAll('[id^="plaza-type-"]').forEach(el => el.classList.remove('active'));
    document.getElementById('plaza-type-' + type).classList.add('active');
    store.plazaUploadType = type;
}

function selectPlazaCategory(cat) {
    document.querySelectorAll('[id^="plaza-cat-"]').forEach(el => el.classList.remove('active'));
    document.getElementById('plaza-cat-' + cat).classList.add('active');
    store.plazaUploadCategory = cat;
}

async function savePlazaNickname() {
    const nickname = document.getElementById('plaza-nickname').value.trim();
    if (!nickname) { ui.showToast('请输入昵称'); return; }
    await skillStoreManager.setNickname(nickname);
    ui.showToast('昵称已保存: ' + nickname);
}

async function uploadPlazaSkill() {
    const nickname = await skillStoreManager.getNickname();
    if (!nickname) { ui.showToast('请先设置昵称'); document.getElementById('plaza-nickname').focus(); return; }

    const skillSelect = document.getElementById('plaza-skill-select').value;
    let name, content, description;

    if (skillSelect === 'custom') {
        name = document.getElementById('plaza-custom-name').value.trim();
        content = document.getElementById('plaza-custom-content').value.trim();
        if (!name) { ui.showToast('请输入 Skill 名称'); return; }
        if (!content) { ui.showToast('请输入 Skill 内容'); return; }
    } else if (skillSelect) {
        const builtin = BUILTIN_SKILLS.find(s => s.id === skillSelect);
        if (!builtin) { ui.showToast('选择的 Skill 不存在'); return; }
        name = builtin.name;
        content = builtin.content;
    } else {
        ui.showToast('请选择或填写 Skill'); return;
    }

    description = document.getElementById('plaza-desc').value.trim();
    const type = store.plazaUploadType || 'default';
    const category = store.plazaUploadCategory || 'other';

    const skill = {
        id: 'plaza_' + Date.now(),
        name,
        content,
        description: description || name,
        author: nickname,
        type,
        category,
        downloads: 0,
        isLocal: true,
        created: Date.now()
    };

    await skillStoreManager.put(skill);
    ui.showToast('Skill 上传成功！');
    switchPlazaTab('browse');
}

async function downloadPlazaSkill(id) {
    const skill = await skillStoreManager.get(id);
    if (!skill) { ui.showToast('Skill 不存在'); return; }

    // 导入到 skills store（技能中心可用）
    const importedSkill = {
        id: skill.id,
        name: skill.name,
        icon: '📦',
        enabled: true,
        category: skill.category || '自定义',
        version: 'v1.0',
        description: skill.description || skill.name,
        content: skill.content || ''
    };

    // 检查是否已存在
    const existing = await skillManager.get(skill.id);
    if (existing) {
        ui.showToast('该 Skill 已在技能中心');
    } else {
        await skillManager.put(importedSkill);
        skill.downloads = (skill.downloads || 0) + 1;
        await skillStoreManager.put(skill);
        ui.showToast(`已下载: ${skill.name}`);
    }
}

async function deletePlazaSkill(id) {
    if (!confirm('确定要删除这个 Skill 吗？')) return;
    await skillStoreManager.delete(id);
    ui.showToast('已删除');
    const content = document.getElementById('plaza-content');
    renderSkillPlazaMyUploads(content);
}

// ===== Plaza Helpers =====
function getAvatarForSkill(name) {
    if (!name) return '?';
    const char = name.trim().charAt(0);
    return /[\u4e00-\u9fa5]/.test(char) ? char : char.toUpperCase();
}

function getCategoryLabel(key) {
    const cat = PLAZA_CATEGORIES.find(c => c.key === key);
    return cat ? cat.label : key;
}

function formatDownloads(n) {
    if (!n) return '0';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
}

// ===== Chat Drawer & Session Management =====

let chatDrawerBatchMode = false;

function openChatDrawer() {
    const overlay = document.getElementById('drawer-overlay');
    const drawer = document.getElementById('chat-drawer');
    if (overlay && drawer) {
        overlay.classList.add('active');
        drawer.classList.add('active');
        renderChatDrawer();
    }
}

function closeChatDrawer() {
    const overlay = document.getElementById('drawer-overlay');
    const drawer = document.getElementById('chat-drawer');
    if (overlay && drawer) {
        overlay.classList.remove('active');
        drawer.classList.remove('active');
    }
}

async function renderChatDrawer() {
    const listEl = document.getElementById('drawer-list');
    if (!listEl) return;

    try {
        const allMessages = await db.getAll('messages');
        
        // 按 sessionId 分组
        const sessions = {};
        allMessages.forEach(msg => {
            const sid = msg.sessionId || 'default';
            if (!sessions[sid]) {
                sessions[sid] = {
                    id: sid,
                    messages: [],
                    lastTime: msg.created || Date.now(),
                    title: ''
                };
            }
            sessions[sid].messages.push(msg);
            if (msg.created && msg.created > sessions[sid].lastTime) {
                sessions[sid].lastTime = msg.created;
            }
        });

        // 为每个会话提取标题（第一条用户消息的前20字）
        Object.values(sessions).forEach(s => {
            const firstUser = s.messages.find(m => m.role === 'user');
            s.title = firstUser ? firstUser.content.substring(0, 20) + (firstUser.content.length > 20 ? '...' : '') : '新对话';
        });

        // 按时间排序
        const sorted = Object.values(sessions).sort((a, b) => b.lastTime - a.lastTime);

        if (sorted.length === 0) {
            listEl.innerHTML = '<div class="drawer-empty">暂无对话记录</div>';
            return;
        }

        // 按日期分组
        const today = new Date().setHours(0,0,0,0);
        const yesterday = today - 86400000;
        
        let html = '';
        let currentGroup = '';
        
        sorted.forEach(session => {
            const date = new Date(session.lastTime);
            const dateStr = date.setHours(0,0,0,0);
            let groupLabel;
            if (dateStr === today) groupLabel = '今天';
            else if (dateStr === yesterday) groupLabel = '昨天';
            else groupLabel = `${date.getMonth()+1}月${date.getDate()}日`;
            
            if (groupLabel !== currentGroup) {
                currentGroup = groupLabel;
                html += `<div class="drawer-date-group">${groupLabel}</div>`;
            }

            const isActive = store.currentSessionId === session.id;
            const timeStr = `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
            
            html += `
                <div class="drawer-item ${isActive ? 'active-session' : ''}" onclick="switchChatSession('${session.id}')">
                    <div class="drawer-item-icon">💬</div>
                    <div class="drawer-item-text">
                        <div class="drawer-item-title">${escapeHtml(session.title)}</div>
                        <div class="drawer-item-meta">${session.messages.length}条 · ${timeStr}</div>
                    </div>
                    <button class="drawer-item-delete ${chatDrawerBatchMode ? 'visible' : ''}" onclick="event.stopPropagation(); deleteChatSession('${session.id}')">🗑</button>
                </div>
            `;
        });

        listEl.innerHTML = html;
    } catch (e) {
        listEl.innerHTML = '<div class="drawer-empty">加载失败</div>';
    }
}

function startNewChatSession() {
    store.currentSessionId = 'chat_' + Date.now();
    store.chatMessages = [];
    store.activeChatSkill = null;
    closeChatDrawer();
    navigateTo('chat');
}

async function switchChatSession(sessionId) {
    store.currentSessionId = sessionId;
    closeChatDrawer();
    navigateTo('chat');
    
    // 加载该会话的消息
    try {
        const msgs = await db.getAll('messages', 'sessionId', sessionId);
        store.chatMessages = msgs.sort((a, b) => (a.created || 0) - (b.created || 0));
        
        // 更新UI显示消息
        const container = document.getElementById('page-chat');
        if (container) {
            // 隐藏hero和卡片，显示消息
            const hero = container.querySelector('.chat-hero');
            const actionList = container.querySelector('.chat-action-list');
            const messagesBox = container.querySelector('#chat-messages');
            if (hero) hero.style.display = 'none';
            if (actionList) actionList.style.display = 'none';
            if (messagesBox) {
                messagesBox.style.display = 'flex';
                messagesBox.innerHTML = store.chatMessages.map(m => `
                    <div class="msg-row ${m.role}">
                        <div class="msg-bubble ${m.role}">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        console.error('加载会话失败:', e);
    }
}

async function deleteChatSession(sessionId) {
    if (!confirm('确定要删除这个会话吗？')) return;
    
    try {
        const msgs = await db.getAll('messages', 'sessionId', sessionId);
        for (const msg of msgs) {
            await db.delete('messages', msg.id);
        }
        
        // 如果删除的是当前会话，重置
        if (store.currentSessionId === sessionId) {
            store.currentSessionId = 'chat_' + Date.now();
            store.chatMessages = [];
        }
        
        ui.showToast('会话已删除');
        renderChatDrawer();
    } catch (e) {
        ui.showToast('删除失败');
    }
}

function toggleBatchDelete() {
    chatDrawerBatchMode = !chatDrawerBatchMode;
    const btn = document.querySelector('.drawer-batch-btn');
    if (btn) btn.classList.toggle('active', chatDrawerBatchMode);
    renderChatDrawer();
}

// ===== Memo System =====

const MEMO_CATEGORIES = [
    { key: 'default', label: '默认', icon: '📝' },
    { key: 'inspiration', label: '灵感', icon: '💡' },
    { key: 'outline', label: '大纲', icon: '📋' }
];

async function showMemo() {
    const container = document.getElementById('page-chat');
    if (!container) return;
    
    const memos = await db.getAll('memos') || [];
    const currentCategory = store.memoCategory || 'default';
    const filtered = memos.filter(m => m.category === currentCategory).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    
    const modal = createModal('备忘录', `
        <div style="margin-bottom: 16px;">
            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                ${MEMO_CATEGORIES.map(c => `
                    <button class="filter-chip ${currentCategory === c.key ? 'active' : ''}" onclick="filterMemos('${c.key}')">
                        ${c.icon} ${c.label}
                    </button>
                `).join('')}
            </div>
            <button class="btn btn-primary btn-block" onclick="showCreateMemoModal()">+ 新建备忘录</button>
        </div>
        <div class="memo-list">
            ${filtered.length === 0 ? '<div class="empty-state" style="padding: 40px 20px;"><div class="empty-title">暂无备忘录</div></div>' : 
                filtered.map(m => `
                    <div class="card" style="cursor: pointer;" onclick="viewMemo('${m.id}')">
                        <div class="card-title">${escapeHtml(m.title)}</div>
                        <div class="card-subtitle">${escapeHtml(m.content.substring(0, 60))}${m.content.length > 60 ? '...' : ''}</div>
                        <div style="font-size: 12px; color: var(--text-tertiary);">${formatDate(m.updated)}</div>
                    </div>
                `).join('')}
        </div>
    `);
    modal.show();
}

function filterMemos(category) {
    store.memoCategory = category;
    showMemo();
}

function showCreateMemoModal() {
    const modal = createModal('新建备忘录', `
        <div class="form-group">
            <label class="form-label">标题</label>
            <input type="text" class="form-input" id="memo-title" placeholder="输入标题">
        </div>
        <div class="form-group">
            <label class="form-label">分类</label>
            <select class="form-select" id="memo-category">
                ${MEMO_CATEGORIES.map(c => `<option value="${c.key}">${c.icon} ${c.label}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label class="form-label">内容</label>
            <textarea class="form-textarea" id="memo-content" placeholder="写下你的想法..."></textarea>
        </div>
        <button class="btn btn-primary btn-block" onclick="saveMemo()">保存</button>
    `);
    modal.show();
}

async function saveMemo() {
    const title = document.getElementById('memo-title').value.trim();
    const content = document.getElementById('memo-content').value.trim();
    const category = document.getElementById('memo-category').value;
    
    if (!title || !content) {
        ui.showToast('请填写标题和内容');
        return;
    }
    
    const memo = {
        id: 'memo_' + Date.now(),
        title,
        content,
        category,
        created: Date.now(),
        updated: Date.now()
    };
    
    await db.put('memos', memo);
    ui.showToast('备忘录已保存');
    showMemo();
}

async function viewMemo(id) {
    const m = await db.get('memos', id);
    if (!m) { ui.showToast('找不到这条备忘录'); return; }
    const modal = createModal('备忘录', `
        <div class="form-group">
            <label class="form-label">标题</label>
            <input class="input" id="memo-title" value="${escapeAttr(m.title || '')}">
        </div>
        <div class="form-group">
            <label class="form-label">内容</label>
            <textarea class="input" id="memo-body" rows="9">${escapeHtml(m.content || '')}</textarea>
        </div>
        <div class="modal-actions">
            <button class="btn btn-danger" onclick="deleteMemoConfirm('${m.id}')">删除</button>
            <button class="btn btn-primary" onclick="saveMemoEdit('${m.id}')">保存</button>
        </div>`);
    modal.show();
}

async function saveMemoEdit(id) {
    const m = await db.get('memos', id);
    if (!m) { ui.showToast('找不到这条备忘录'); return; }
    const t = (document.getElementById('memo-title') || {}).value || '';
    const b = (document.getElementById('memo-body') || {}).value || '';
    m.title = t.trim() || m.title;
    m.content = b;
    m.updated = Date.now();
    await db.put('memos', m);
    closeModal();
    ui.showToast('已保存');
    showMemo();
}

async function deleteMemoConfirm(id) {
    if (!confirm('删除这条备忘录？删了找不回来。')) return;
    await db.delete('memos', id);
    closeModal();
    ui.showToast('已删除');
    showMemo();
}

// ===== Novel Tree Browser Helpers =====

function toggleTreeFolder(folderEl) {
    folderEl.classList.toggle('collapsed');
}

async function viewOutlineItem(novelId, index) {
    const novel = await novelManager.get(novelId);
    if (!novel) {
        ui.showToast('大纲条目不存在');
        return;
    }
    // 兼容树形大纲：按扁数组化后的列表取条目
    const items = getFlatOutlineItems(novel);
    const item = items[index];
    if (!item) {
        ui.showToast('大纲条目不存在');
        return;
    }
    const modal = createModal(`第${item.chapter}章 ${escapeHtml(item.title || '')}`, `
        <div style="font-size: 14px; line-height: 1.8; color: var(--text);">
            <div style="margin-bottom: 12px; padding: 12px; background: var(--bg); border-radius: 8px;">
                <div style="font-weight: 600; margin-bottom: 4px;">章节概要</div>
                <div style="color: var(--text-secondary);">${escapeHtml(item.summary || '暂无概要')}</div>
            </div>
            <div style="font-size: 12px; color: var(--text-tertiary);">章节编号: ${item.chapter}</div>
        </div>
    `);
    modal.show();
}

async function viewCharacter(novelId, index) {
    const novel = await novelManager.get(novelId);
    if (!novel || !novel.characters || !novel.characters[index]) {
        ui.showToast('角色资料不存在');
        return;
    }
    
    const char = novel.characters[index];
    const modal = createModal(char.name, `
        <div style="font-size: 14px; line-height: 1.8; color: var(--text);">
            <div style="margin-bottom: 12px; padding: 12px; background: var(--bg); border-radius: 8px;">
                <div style="font-weight: 600; margin-bottom: 4px;">${char.role || '角色'}</div>
                <div style="color: var(--text-secondary);">${escapeHtml(char.description || '暂无描述')}</div>
            </div>
        </div>
    `);
    modal.show();
}

// ===== Outline Editor Page (v2.4.0) =====
let outlineEditData = null; // { novelId, outline }

async function renderOutlineEditor(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    ui.setPageTitle('大纲编辑');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="saveOutlineEdit()">保存</button>
    `);

    const outline = await novelManager.getOutline(novelId);
    outlineEditData = { novelId, outline, originalOutline: JSON.parse(JSON.stringify(outline)) };

    container.innerHTML = `
        <div style="padding: 12px 16px;">
            <div style="font-size: 13px; color: var(--text-tertiary); margin-bottom: 12px;">
                📋 树形大纲：总纲 → 卷 → 章 → 节。点击节点可折叠/展开，点击 ✎ 可编辑。
            </div>
            <div id="outline-tree-root" class="novel-tree"></div>
        </div>
    `;
    renderOutlineNode(document.getElementById('outline-tree-root'), outline, 'root');
}

function renderOutlineNode(container, node, path) {
    if (!node) return;
    const hasChildren = node.children && node.children.length > 0;
    const isRoot = node.type === 'root';
    const icon = isRoot ? '📚' : node.type === 'volume' ? '📖' : node.type === 'chapter' ? '📄' : '•';
    const count = hasChildren ? `(${node.children.length})` : '';

    const row = document.createElement('div');
    row.className = `outline-node ${hasChildren ? '' : 'leaf'}`;
    row.dataset.path = path;

    row.innerHTML = `
        <div class="outline-node-row" onclick="toggleOutlineNode(this)">
            <span class="outline-toggle" style="visibility:${hasChildren ? 'visible' : 'hidden'}">▼</span>
            <span class="outline-icon">${icon}</span>
            <div class="outline-text">
                <div class="outline-title">${escapeHtml(node.title || node.id)} ${count}</div>
                <div class="outline-summary">${escapeHtml(node.summary || '')}</div>
            </div>
            <button class="outline-menu-btn" onclick="event.stopPropagation(); showOutlineNodeMenu('${path}')">✎</button>
        </div>
        <div class="outline-children" id="oc-${path}"></div>
    `;
    container.appendChild(row);

    if (hasChildren) {
        const childBox = row.querySelector(`#oc-${CSS.escape(path)}`);
        if (!childBox) return;
        node.children.forEach((child, idx) => {
            renderOutlineNode(childBox, child, `${path}_c${idx}`);
        });
    }
}

function toggleOutlineNode(el) {
    const node = el.closest('.outline-node');
    if (!node) return;
    const children = node.querySelector('.outline-children');
    const toggle = node.querySelector('.outline-toggle');
    if (!children) return;
    const collapsed = node.classList.toggle('collapsed');
    if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
}

function showOutlineNodeMenu(path) {
    const { outline } = outlineEditData || {};
    const node = findOutlineNode(outline, path);
    if (!node) return;
    const modal = createModal('编辑节点', `
        <div style="display:flex;flex-direction:column;gap:12px;">
            <div><label style="font-size:13px;color:var(--text-secondary);display:block;margin-bottom:4px;">标题</label>
            <input type="text" class="input" id="on-title" value="${escapeHtml(node.title || '')}"></div>
            <div><label style="font-size:13px;color:var(--text-secondary);display:block;margin-bottom:4px;">概要</label>
            <textarea class="textarea" id="on-summary" rows="3">${escapeHtml(node.summary || '')}</textarea></div>
            <div style="display:flex;gap:8px;">
                <button class="btn btn-primary btn-block" onclick="applyOutlineEdit('${path}')">保存</button>
                ${node.type !== 'root' ? `<button class="btn btn-outline btn-block" onclick="applyOutlineDelete('${path}')">删除</button>` : ''}
            </div>
            <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px;">
                <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">添加子节点</div>
                <div style="display:flex;gap:8px;">
                    <select class="input" id="on-add-type" style="width:100px;flex-shrink:0;">
                        <option value="volume">卷</option>
                        <option value="chapter">章</option>
                        <option value="scene">节</option>
                    </select>
                    <input type="text" class="input" id="on-add-title" placeholder="标题" style="flex:1;">
                </div>
                <button class="btn btn-secondary btn-block" style="margin-top:8px;" onclick="applyOutlineAddChild('${path}')">添加子节点</button>
            </div>
        </div>`);
    modal.show();
}

function findOutlineNode(outline, path) {
    if (!outline || path === 'root') return outline;
    const parts = path.split('_');
    let cur = outline;
    for (let i = 1; i < parts.length; i++) {
        const idx = parseInt(parts[i].replace('c', ''), 10);
        if (!cur.children || !cur.children[idx]) return null;
        cur = cur.children[idx];
    }
    return cur;
}

function applyOutlineEdit(path) {
    const title = document.getElementById('on-title').value.trim();
    const summary = document.getElementById('on-summary').value.trim();
    const node = findOutlineNode(outlineEditData.outline, path);
    if (!node) return;
    node.title = title;
    node.summary = summary;
    closeModal();
    const root = document.getElementById('outline-tree-root');
    root.innerHTML = '';
    renderOutlineNode(root, outlineEditData.outline, 'root');
    ui.showToast('已修改（未保存到数据库，请点击右上角保存）');
}

function applyOutlineDelete(path) {
    if (!path || path === 'root') return;
    closeModal();
    const parentPath = path.substring(0, path.lastIndexOf('_'));
    const idx = parseInt(path.split('_').pop().replace('c', ''), 10);
    const parent = findOutlineNode(outlineEditData.outline, parentPath);
    if (parent && parent.children) {
        parent.children.splice(idx, 1);
    }
    const root = document.getElementById('outline-tree-root');
    root.innerHTML = '';
    renderOutlineNode(root, outlineEditData.outline, 'root');
    ui.showToast('已删除（未保存到数据库，请点击右上角保存）');
}

function applyOutlineAddChild(path) {
    const type = document.getElementById('on-add-type').value;
    const title = document.getElementById('on-add-title').value.trim();
    if (!title) { ui.showToast('请输入标题'); return; }
    const node = findOutlineNode(outlineEditData.outline, path);
    if (!node) return;
    if (!node.children) node.children = [];
    node.children.push({
        id: `${type}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        type,
        title,
        summary: '',
        children: []
    });
    closeModal();
    const root = document.getElementById('outline-tree-root');
    root.innerHTML = '';
    renderOutlineNode(root, outlineEditData.outline, 'root');
    ui.showToast('已添加（未保存到数据库，请点击右上角保存）');
}

async function saveOutlineEdit() {
    if (!outlineEditData) return;
    try {
        // 1. 检测冲突
        const conflicts = await detectOutlineConflicts(outlineEditData.novelId, outlineEditData.originalOutline, outlineEditData.outline);
        if (conflicts.length > 0) {
            showConflictReport(outlineEditData.novelId, conflicts);
            return; // 等用户确认后再保存
        }
        // 无冲突，直接保存
        await novelManager.saveOutline(outlineEditData.novelId, outlineEditData.outline);
        ui.showToast('大纲已保存');
    } catch (e) {
        ui.showToast('保存失败: ' + e.message);
    }
}

// ===== Outline Conflict Detection =====

function flattenOutlineNodes(node, list = [], path = '') {
    if (!node) return list;
    const currentPath = path ? `${path} / ${node.title || node.id}` : (node.title || node.id);
    if (node.type !== 'root') {
        list.push({ path: currentPath, node: JSON.parse(JSON.stringify(node)) });
    }
    if (node.children) {
        for (const child of node.children) {
            flattenOutlineNodes(child, list, currentPath);
        }
    }
    return list;
}

function diffOutlines(oldTree, newTree) {
    const oldFlat = flattenOutlineNodes(oldTree);
    const newFlat = flattenOutlineNodes(newTree);
    const changes = [];
    // 用路径+type+id匹配
    const oldMap = new Map(oldFlat.map(o => [`${o.path}|${o.node.type}|${o.node.id}`, o.node]));
    const newMap = new Map(newFlat.map(n => [`${n.path}|${n.node.type}|${n.node.id}`, n.node]));

    // 检测修改和删除
    for (const [key, oldNode] of oldMap) {
        const newNode = newMap.get(key);
        if (!newNode) {
            changes.push({ type: 'deleted', path: key.split('|')[0], node: oldNode });
        } else if (JSON.stringify(oldNode) !== JSON.stringify(newNode)) {
            const diffs = [];
            if (oldNode.title !== newNode.title) diffs.push({ field: 'title', old: oldNode.title, new: newNode.title });
            if (oldNode.summary !== newNode.summary) diffs.push({ field: 'summary', old: oldNode.summary, new: newNode.summary });
            if (oldNode.type !== newNode.type) diffs.push({ field: 'type', old: oldNode.type, new: newNode.type });
            if (diffs.length > 0) {
                changes.push({ type: 'modified', path: key.split('|')[0], node: newNode, diffs });
            }
        }
    }
    // 检测新增
    for (const [key, newNode] of newMap) {
        if (!oldMap.has(key)) {
            changes.push({ type: 'added', path: key.split('|')[0], node: newNode });
        }
    }
    return changes;
}

async function detectOutlineConflicts(novelId, oldOutline, newOutline) {
    const changes = diffOutlines(oldOutline, newOutline);
    if (changes.length === 0) return [];

    const chapters = await novelManager.listChapters(novelId);
    if (chapters.length === 0) return []; // 没写过章节，无冲突

    const conflicts = [];

    for (const change of changes) {
        if (change.type === 'deleted') continue; // 删除暂不检测
        if (change.type === 'added') continue; // 新增无冲突
        if (change.type !== 'modified') continue;

        const relevantDiffs = change.diffs.filter(d => d.field === 'title' || d.field === 'summary');
        if (relevantDiffs.length === 0) continue;

        // 提取旧文本中的关键实体（角色名、地点、关键事件词）
        const oldText = change.diffs.map(d => d.old).join(' ');
        const keywords = extractKeywords(oldText);
        if (keywords.length === 0) continue;

        for (const ch of chapters) {
            const content = ch.content || '';
            const found = keywords.filter(kw => content.includes(kw));
            if (found.length > 0) {
                // 找出具体出现位置（前200字符上下文）
                const positions = [];
                for (const kw of found) {
                    let idx = content.indexOf(kw);
                    while (idx !== -1) {
                        const start = Math.max(0, idx - 60);
                        const end = Math.min(content.length, idx + kw.length + 60);
                        positions.push({ keyword: kw, index: idx, context: content.substring(start, end) });
                        idx = content.indexOf(kw, idx + 1);
                    }
                }
                conflicts.push({
                    change,
                    chapter: ch,
                    keywords: found,
                    positions: positions.slice(0, 5), // 最多5处
                    severity: found.length >= 3 ? 'high' : 'medium'
                });
                break; // 一个变更只需报告一次冲突
            }
        }
    }

    return conflicts;
}

function extractKeywords(text) {
    if (!text) return [];
    // 简单提取：中文2-6字词组、角色名（假设为大写首字母或特定称谓）
    const words = [];
    // 提取引号内内容（角色名、地点名）
    const quoted = text.match(/["""']([^"""']{2,8})["""']/g);
    if (quoted) words.push(...quoted.map(q => q.replace(/["""']/g, '')));
    // 提取常见称谓+名字
    const titles = text.match(/[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥东西南北中]+[君王帝主公爷侯伯子男]+/g);
    if (titles) words.push(...titles);
    // 提取2-4字中文词（可能是角色名或地名）
    const segments = text.match(/[\u4e00-\u9fa5]{2,4}/g);
    if (segments) {
        // 过滤常见虚词
        const stopWords = new Set(['但是', '因为', '所以', '如果', '然后', '之后', '之前', '此时', '这里', '那里', '这个', '那个', '什么', '怎么', '如何', '开始', '结束', '继续', '突然', '慢慢', '很快', '终于']);
        words.push(...segments.filter(s => !stopWords.has(s) && s.length >= 2));
    }
    // 去重
    return [...new Set(words)].filter(w => w.length >= 2 && w.length <= 8);
}

function showConflictReport(novelId, conflicts) {
    const totalChapters = new Set(conflicts.map(c => c.chapter.number)).size;
    const totalPositions = conflicts.reduce((sum, c) => sum + c.positions.length, 0);

    const html = `
        <div style="max-height:60vh;overflow-y:auto;">
            <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:12px;margin-bottom:16px;">
                <div style="font-weight:600;color:#ef4444;margin-bottom:4px;">⚠️ 检测到 ${conflicts.length} 处潜在冲突</div>
                <div style="font-size:13px;color:var(--text-secondary);">
                    涉及 ${totalChapters} 个已写章节，共 ${totalPositions} 处引用。
                    建议先查看冲突，再决定是否同步修改。
                </div>
            </div>
            ${conflicts.map((c, i) => `
                <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px;">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                        <span style="font-size:12px;padding:2px 8px;border-radius:6px;background:${c.severity==='high'?'rgba(239,68,68,0.1);color:#ef4444':'rgba(245,158,11,0.1);color:#f59e0b'}">${c.severity==='high'?'高风险':'中风险'}</span>
                        <span style="font-weight:500;">${escapeHtml(c.change.path)}</span>
                    </div>
                    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">
                        ${c.change.diffs.map(d => `
                            <div style="margin-bottom:4px;">
                                <span style="color:#ef4444;text-decoration:line-through;">${escapeHtml(String(d.old || ''))}</span>
                                <span style="margin:0 4px;">→</span>
                                <span style="color:#10b981;">${escapeHtml(String(d.new || ''))}</span>
                            </div>
                        `).join('')}
                    </div>
                    <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">
                        第${c.chapter.number}章《${c.chapter.title}》中发现引用：${c.keywords.join('、')}
                    </div>
                    ${c.positions.map(p => `
                        <div style="background:var(--bg);border-radius:6px;padding:8px;margin-bottom:4px;font-size:13px;font-family:monospace;white-space:pre-wrap;">
                            <span style="color:var(--text-tertiary);">…</span>${escapeHtml(p.context.substring(0, p.context.indexOf(p.keyword)))}<span style="background:rgba(239,68,68,0.15);color:#ef4444;border-radius:2px;padding:0 2px;">${escapeHtml(p.keyword)}</span>${escapeHtml(p.context.substring(p.context.indexOf(p.keyword) + p.keyword.length))}<span style="color:var(--text-tertiary);">…</span>
                        </div>
                    `).join('')}
                </div>
            `).join('')}
            <div style="display:flex;gap:8px;margin-top:16px;">
                <button class="btn btn-primary btn-block" onclick="applyConflictSync('${novelId}')">🔄 一键同步修改</button>
                <button class="btn btn-outline btn-block" onclick="forceSaveOutline('${novelId}')">⚠️ 忽略冲突，仅保存大纲</button>
            </div>
        </div>
    `;
    const modal = createModal('大纲冲突检测报告', html);
    modal.show();
}

async function applyConflictSync(novelId) {
    if (!confirm('同步修改将批量替换已写章节中的旧引用为新引用，此操作不可撤销，确定继续吗？')) return;
    closeModal();
    const { originalOutline, outline } = outlineEditData || {};
    if (!originalOutline || !outline) { ui.showToast('数据异常'); return; }

    const changes = diffOutlines(originalOutline, outline);
    const modifiedChanges = changes.filter(c => c.type === 'modified');
    if (modifiedChanges.length === 0) { ui.showToast('无需要同步的修改'); return; }

    ui.showToast('正在同步修改…');
    const chapters = await novelManager.listChapters(novelId);
    let replacedCount = 0;

    for (const ch of chapters) {
        let newContent = ch.content || '';
        let hasChange = false;
        for (const change of modifiedChanges) {
            for (const diff of change.diffs) {
                if (diff.field !== 'title' && diff.field !== 'summary') continue;
                const oldVal = String(diff.old || '');
                const newVal = String(diff.new || '');
                if (!oldVal || oldVal === newVal) continue;
                // 全词替换（避免部分匹配）
                const regex = new RegExp(oldVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                if (regex.test(newContent)) {
                    newContent = newContent.replace(regex, newVal);
                    hasChange = true;
                    replacedCount++;
                }
            }
        }
        if (hasChange) {
            await novelManager.saveChapter(novelId, ch.number, ch.title, newContent);
        }
    }

    // 保存大纲
    await novelManager.saveOutline(novelId, outline);
    ui.showToast(`同步完成：修改了 ${replacedCount} 处引用，已保存大纲`);
}

async function forceSaveOutline(novelId) {
    closeModal();
    try {
        await novelManager.saveOutline(outlineEditData.novelId, outlineEditData.outline);
        ui.showToast('大纲已保存（冲突未处理）');
    } catch (e) {
        ui.showToast('保存失败: ' + e.message);
    }
}

// ===== Plot Simulation Page (v2.4.0) =====
async function renderPlotSimulate(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    ui.setPageTitle('情节推演');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>`);

    const branches = await novelManager.getPlotBranches(novelId);

    container.innerHTML = `
        <div style="padding: 12px 16px;">
            <div style="font-size: 13px; color: var(--text-tertiary); margin-bottom: 12px;">
                🔮 输入一个"如果…会怎样"的假设，AI 推演后续 3 章的因果链。
            </div>
            <textarea class="textarea" id="plot-assume" rows="3" placeholder="例如：如果主角在第5章发现师父是反派，后续剧情会怎样发展？"></textarea>
            <button class="btn btn-primary btn-block" style="margin-top: 12px;" onclick="runPlotSimulate('${novelId}')">开始推演</button>
            <div id="plot-result" style="margin-top: 16px;"></div>
            <div id="plot-history" style="margin-top: 16px;"></div>
        </div>
    `;

    if (branches.length > 0) {
        const hist = document.getElementById('plot-history');
        hist.innerHTML = `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">历史推演</div>` +
            branches.slice(-5).reverse().map(b => `
                <div class="card" style="margin-bottom:8px;">
                    <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px;">${new Date(b.created).toLocaleString()}</div>
                    <div style="font-weight:500;margin-bottom:6px;">假设：${escapeHtml(b.assumption)}</div>
                    <div style="font-size:13px;color:var(--text-secondary);white-space:pre-wrap;">${escapeHtml(b.result)}</div>
                </div>
            `).join('');
    }
}

async function runPlotSimulate(novelId) {
    const assume = document.getElementById('plot-assume').value.trim();
    if (!assume) { ui.showToast('请输入假设条件'); return; }
    const novel = await novelManager.get(novelId);
    const chapters = await novelManager.listChapters(novelId);
    const outline = await novelManager.getOutline(novelId);
    const resultBox = document.getElementById('plot-result');
    resultBox.innerHTML = `<div class="loading"><div class="spinner"></div><div>AI 正在推演…</div></div>`;

    const context = chapters.slice(-2).map(ch => `第${ch.number}章 ${ch.title}：${ch.content.substring(0, 400)}`).join('\n');
    const outlineSummary = (outline?.children || []).slice(0, 5).map(o => o.title).join(' → ');

    try {
        const prompt = `你是小说情节推演专家。请基于以下信息推演后续剧情：

作品：${novel.title}
简介：${novel.description || ''}
最近章节概要：
${context}
当前大纲：${outlineSummary}

假设条件：${assume}

要求：
1. 给出后续 3 章的情节推演（每章包含标题+核心事件+对整体故事的影响）
2. 分析该假设对角色关系、世界观、主线节奏的影响
3. 标注潜在风险（伏笔断裂、节奏失衡、角色OOC）

请用中文输出。`;
        const result = await ai.chat([
            { role: 'system', content: '你是专业的小说情节推演师，擅长因果链分析与多章节节奏规划。' },
            { role: 'user', content: prompt }
        ], null, 4000);

        const branch = { assumption: assume, result, created: Date.now() };
        const branches = await novelManager.getPlotBranches(novelId);
        branches.push(branch);
        await novelManager.savePlotBranches(novelId, branches);

        resultBox.innerHTML = `
            <div class="card" style="margin-bottom:12px;">
                <div style="font-weight:600;margin-bottom:8px;">🔮 推演结果</div>
                <div style="font-size:14px;line-height:1.8;white-space:pre-wrap;color:var(--text);">${escapeHtml(result).replace(/\n/g, '<br>')}</div>
            </div>`;
    } catch (e) {
        resultBox.innerHTML = `<div style="color:var(--error);">推演失败: ${escapeHtml(e.message)}</div>`;
    }
}

// ===== Beat Control Page (v2.4.0) =====
let beatEditData = null;

async function renderBeatControl(container, novelId, chapterNum) {
    const novel = await novelManager.get(novelId);
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    ui.setPageTitle(`第${chapterNum}章 节拍控制`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="saveBeatControl()">保存</button>
    `);

    let beats = await novelManager.getBeats(novelId, chapterNum);
    if (!beats || beats.length === 0) {
        beats = [
            { type: 'setup', label: '铺陈', desc: '', pct: 25 },
            { type: 'conflict', label: '冲突', desc: '', pct: 25 },
            { type: 'climax', label: '高潮', desc: '', pct: 25 },
            { type: 'hook', label: '钩子', desc: '', pct: 25 }
        ];
    }
    beatEditData = { novelId, chapterNum, beats };

    const renderBeats = () => `
        ${beats.map((b, i) => `
            <div class="beat-item" data-idx="${i}">
                <div class="beat-num">${i + 1}</div>
                <div style="flex:1;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <select class="input" id="beat-type-${i}" style="width:90px;flex-shrink:0;padding:6px 8px;font-size:13px;">
                            <option value="setup" ${b.type==='setup'?'selected':''}>铺陈</option>
                            <option value="conflict" ${b.type==='conflict'?'selected':''}>冲突</option>
                            <option value="climax" ${b.type==='climax'?'selected':''}>高潮</option>
                            <option value="hook" ${b.type==='hook'?'selected':''}>钩子</option>
                            <option value="transition" ${b.type==='transition'?'selected':''}>过渡</option>
                        </select>
                        <input type="number" class="input" id="beat-pct-${i}" value="${b.pct}" min="1" max="100" style="width:70px;flex-shrink:0;padding:6px 8px;font-size:13px;text-align:center;">%
                        <button class="btn btn-outline" style="padding:4px 8px;font-size:12px;" onclick="removeBeat(${i})">✕</button>
                    </div>
                    <input type="text" class="input" id="beat-desc-${i}" value="${escapeHtml(b.desc || '')}" placeholder="描述该节拍的核心内容…" style="font-size:13px;padding:8px;">
                </div>
            </div>
        `).join('')}
        <button class="btn btn-secondary btn-block" style="margin-top:8px;" onclick="addBeat()">+ 添加节拍</button>
    `;

    container.innerHTML = `
        <div style="padding: 12px 16px;">
            <div style="font-size: 13px; color: var(--text-tertiary); margin-bottom: 12px;">
                🎬 定义本章的叙事节奏。AI 写作时将按节拍分配篇幅与情绪强度。
            </div>
            <div id="beat-list">${renderBeats()}</div>
            <button class="btn btn-primary btn-block" style="margin-top: 12px;" onclick="aiCheckBeats('${novelId}', ${chapterNum})">🤖 AI 校验节拍</button>
            <div id="beat-check-result" style="margin-top: 12px;"></div>
        </div>
    `;
}

function addBeat() {
    if (!beatEditData) return;
    beatEditData.beats.push({ type: 'transition', label: '过渡', desc: '', pct: 20 });
    const container = document.getElementById('beat-list');
    if (container) {
        const novelId = beatEditData.novelId;
        const chapterNum = beatEditData.chapterNum;
        const beats = beatEditData.beats;
        container.innerHTML = beats.map((b, i) => `
            <div class="beat-item" data-idx="${i}">
                <div class="beat-num">${i + 1}</div>
                <div style="flex:1;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <select class="input" id="beat-type-${i}" style="width:90px;flex-shrink:0;padding:6px 8px;font-size:13px;">
                            <option value="setup" ${b.type==='setup'?'selected':''}>铺陈</option>
                            <option value="conflict" ${b.type==='conflict'?'selected':''}>冲突</option>
                            <option value="climax" ${b.type==='climax'?'selected':''}>高潮</option>
                            <option value="hook" ${b.type==='hook'?'selected':''}>钩子</option>
                            <option value="transition" ${b.type==='transition'?'selected':''}>过渡</option>
                        </select>
                        <input type="number" class="input" id="beat-pct-${i}" value="${b.pct}" min="1" max="100" style="width:70px;flex-shrink:0;padding:6px 8px;font-size:13px;text-align:center;">%
                        <button class="btn btn-outline" style="padding:4px 8px;font-size:12px;" onclick="removeBeat(${i})">✕</button>
                    </div>
                    <input type="text" class="input" id="beat-desc-${i}" value="${escapeHtml(b.desc || '')}" placeholder="描述该节拍的核心内容…" style="font-size:13px;padding:8px;">
                </div>
            </div>
        `).join('') + `<button class="btn btn-secondary btn-block" style="margin-top:8px;" onclick="addBeat()">+ 添加节拍</button>`;
    }
}

function removeBeat(idx) {
    if (!beatEditData) return;
    beatEditData.beats.splice(idx, 1);
    addBeat(); // re-render
}

async function saveBeatControl() {
    if (!beatEditData) return;
    const { novelId, chapterNum } = beatEditData;
    const beats = [];
    const container = document.getElementById('beat-list');
    if (!container) return;
    const items = container.querySelectorAll('.beat-item');
    items.forEach((el, i) => {
        const type = document.getElementById(`beat-type-${i}`)?.value || 'transition';
        const pct = parseInt(document.getElementById(`beat-pct-${i}`)?.value || '20', 10);
        const desc = document.getElementById(`beat-desc-${i}`)?.value || '';
        beats.push({ type, label: type==='setup'?'铺陈':type==='conflict'?'冲突':type==='climax'?'高潮':type==='hook'?'钩子':'过渡', desc, pct });
    });
    await novelManager.saveBeats(novelId, chapterNum, beats);
    ui.showToast('节拍已保存');
}

async function aiCheckBeats(novelId, chapterNum) {
    const novel = await novelManager.get(novelId);
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    const beats = beatEditData?.beats || await novelManager.getBeats(novelId, chapterNum);
    const resultBox = document.getElementById('beat-check-result');
    resultBox.innerHTML = `<div class="loading"><div class="spinner"></div><div>AI 正在分析…</div></div>`;

    try {
        const beatText = beats.map((b, i) => `${i + 1}. ${b.label}（${b.pct}%）：${b.desc}`).join('\n');
        const content = chapter ? chapter.content.substring(0, 1500) : '（本章尚未写作）';
        const prompt = `你是小说节奏分析专家。请分析以下章节节拍规划是否合理：

作品：${novel.title}
章节：第${chapterNum}章 ${chapter?.title || ''}

规划节拍：
${beatText}

${chapter ? '本章内容节选：\n' + content : ''}

要求：
1. 评估节拍比例是否合理（铺陈不宜过长、高潮应有足够张力、钩子是否足够吸引）
2. 如果已有内容，对比实际写作是否符合节拍规划
3. 给出优化建议（哪里该加/减、哪里情绪该收/放）

请用中文输出。`;

        const result = await ai.chat([
            { role: 'system', content: '你是资深小说编辑，擅长叙事节奏分析与节拍控制。' },
            { role: 'user', content: prompt }
        ], null, 4000);

        resultBox.innerHTML = `
            <div class="card" style="margin-bottom:12px;">
                <div style="font-weight:600;margin-bottom:8px;">🎬 AI 节拍分析</div>
                <div style="font-size:14px;line-height:1.8;white-space:pre-wrap;color:var(--text);">${escapeHtml(result).replace(/\n/g, '<br>')}</div>
            </div>`;
    } catch (e) {
        resultBox.innerHTML = `<div style="color:var(--error);">分析失败: ${escapeHtml(e.message)}</div>`;
    }
}

// ===== Character Card System (v2.4.0) =====
async function renderCharacterCards(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    ui.setPageTitle(`👥 ${novel.title} · 角色卡`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="navigateTo('characterEdit', { novelId: '${novelId}' })">+ 新建</button>
    `);

    const chars = await novelManager.listCharacters(novelId);
    if (chars.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">👤</div>
                <div class="empty-title">暂无角色</div>
                <div class="empty-desc">点击右上角 + 新建创建第一个角色卡</div>
            </div>`;
        return;
    }
    container.innerHTML = `
        <div style="padding: 12px 16px;">
            <div style="display:flex;gap:8px;margin-bottom:12px;overflow-x:auto;">
                <button class="btn btn-outline" style="white-space:nowrap;" onclick="viewCharacterGraph('${novelId}')">🔍 关系图谱</button>
                <button class="btn btn-outline" style="white-space:nowrap;" onclick="autoLinkAllChars('${novelId}')">🔗 自动关联章节</button>
            </div>
            <div class="character-grid">
                ${chars.map(char => `
                    <div class="character-card" onclick="navigateTo('characterEdit', { novelId: '${novelId}', characterId: '${char.id}' })">
                        <div class="character-avatar">${(char.name || '?').charAt(0)}</div>
                        <div class="character-info">
                            <div class="character-name">${escapeHtml(char.name || '未命名')}</div>
                            <div class="character-tags">${(char.tags || []).map(t => `<span class="char-tag">${escapeHtml(t)}</span>`).join('')}</div>
                            <div class="character-meta">${escapeHtml(char.personality || '')}</div>
                        </div>
                        <span class="settings-arrow">›</span>
                    </div>
                `).join('')}
            </div>
        </div>`;
}

async function renderCharacterEdit(container, novelId, characterId) {
    const novel = await novelManager.get(novelId);
    const char = characterId ? await novelManager.getCharacter(characterId) : null;
    const isNew = !char;
    ui.setPageTitle(isNew ? '新建角色' : `编辑 · ${char.name}`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('characterCards', { novelId: '${novelId}' })">返回</button>
        ${!isNew ? `<button class="header-btn" onclick="deleteCharacterCard('${characterId}', '${novelId}')">删除</button>` : ''}
        <button class="header-btn" onclick="saveCharacter('${novelId}', '${characterId || ''}')">保存</button>
    `);
    container.innerHTML = `
        <div style="padding: 12px 16px; display:flex; flex-direction:column; gap: 12px;">
            <div><label class="form-label">姓名 *</label>
            <input type="text" class="form-input" id="char-name" value="${escapeHtml(char?.name || '')}" placeholder="角色姓名"></div>
            <div style="display:flex; gap: 12px;">
                <div style="flex:1;"><label class="form-label">年龄</label>
                <input type="text" class="form-input" id="char-age" value="${escapeHtml(char?.age || '')}" placeholder="如：24岁"></div>
                <div style="flex:1;"><label class="form-label">标签</label>
                <input type="text" class="form-input" id="char-tags" value="${escapeHtml((char?.tags || []).join('、'))}" placeholder="主角, 剑客, 孤儿"></div>
            </div>
            <div><label class="form-label">外貌</label>
            <textarea class="form-textarea" id="char-appearance" rows="2" placeholder="外貌特征描述…">${escapeHtml(char?.appearance || '')}</textarea></div>
            <div><label class="form-label">性格</label>
            <textarea class="form-textarea" id="char-personality" rows="2" placeholder="性格特点…">${escapeHtml(char?.personality || '')}</textarea></div>
            <div><label class="form-label">前史 / 背景</label>
            <textarea class="form-textarea" id="char-backstory" rows="3" placeholder="角色的过去、成长经历…">${escapeHtml(char?.backstory || '')}</textarea></div>
            <div><label class="form-label">口头禅</label>
            <input type="text" class="form-input" id="char-catchphrase" value="${escapeHtml(char?.catchphrase || '')}" placeholder="如：我命由我不由天！"></div>
            <div><label class="form-label">当前状态</label>
            <input type="text" class="form-input" id="char-status" value="${escapeHtml(char?.currentStatus || '')}" placeholder="如：重伤隐居、修为金丹期"></div>
            <div><label class="form-label">人物弧光</label>
            <textarea class="form-textarea" id="char-arc" rows="2" placeholder="角色在故事中的成长/变化…">${escapeHtml(char?.arc || '')}</textarea></div>
            <div><label class="form-label">关系网（每行一个：关系人,关系类型）</label>
            <textarea class="form-textarea" id="char-relations" rows="3" placeholder="师父,师徒&#10;师妹,青梅竹马">${escapeHtml((char?.relationships || []).map(r => `${r.target},${r.type}`).join('\n'))}</textarea></div>
        </div>`;
}

async function saveCharacter(novelId, characterId) {
    const name = document.getElementById('char-name').value.trim();
    if (!name) { ui.showToast('请输入角色姓名'); return; }
    const tags = document.getElementById('char-tags').value.split(/[,，、]/).map(t => t.trim()).filter(t => t);
    const relationsRaw = document.getElementById('char-relations').value.split('\n').map(l => l.trim()).filter(l => l);
    const relationships = relationsRaw.map(line => {
        const parts = line.split(/[,，]/);
        return { target: parts[0]?.trim() || '', type: parts[1]?.trim() || '关联' };
    }).filter(r => r.target);
    const data = {
        name, age: document.getElementById('char-age').value.trim(), tags,
        appearance: document.getElementById('char-appearance').value.trim(),
        personality: document.getElementById('char-personality').value.trim(),
        backstory: document.getElementById('char-backstory').value.trim(),
        catchphrase: document.getElementById('char-catchphrase').value.trim(),
        currentStatus: document.getElementById('char-status').value.trim(),
        arc: document.getElementById('char-arc').value.trim(), relationships
    };
    try {
        if (characterId) {
            await novelManager.updateCharacter(characterId, data);
            ui.showToast('角色已更新');
        } else {
            await novelManager.createCharacter(novelId, data);
            ui.showToast('角色已创建');
        }
        navigateTo('characterCards', { novelId });
    } catch (e) {
        ui.showToast('保存失败: ' + e.message);
    }
}

async function deleteCharacterCard(characterId, novelId) {
    if (!confirm('确定要删除这个角色卡吗？')) return;
    try {
        await novelManager.deleteCharacter(characterId);
        ui.showToast('已删除');
        navigateTo('characterCards', { novelId });
    } catch (e) {
        ui.showToast('删除失败: ' + e.message);
    }
}

// ===== Character Graph =====
async function viewCharacterGraph(novelId) {
    const chars = await novelManager.listCharacters(novelId);
    if (chars.length === 0) { ui.showToast('没有角色可展示'); return; }
    const nodes = chars.map((c, i) => ({ id: c.id, name: c.name, index: i, color: ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#14b8a6'][i % 8] }));
    const edges = [];
    chars.forEach((c, i) => {
        (c.relationships || []).forEach(r => {
            const targetIdx = chars.findIndex(cc => cc.name === r.target || cc.id === r.target);
            if (targetIdx >= 0 && targetIdx !== i) edges.push({ source: i, target: targetIdx, label: r.type });
        });
    });
    const width = Math.min(window.innerWidth - 32, 600);
    const height = Math.max(300, Math.min(500, window.innerHeight * 0.5));
    const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * 0.35;
    const pos = nodes.map((n, i) => {
        const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
        return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    });
    const svgEdges = edges.map(e => {
        const s = pos[e.source], t = pos[e.target];
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        return `<line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="#ccc" stroke-width="1.5" /><text x="${mx}" y="${my}" font-size="11" fill="#999" text-anchor="middle" dy="-3">${escapeHtml(e.label)}</text>`;
    }).join('');
    const svgNodes = nodes.map((n, i) => {
        const p = pos[i];
        return `<g transform="translate(${p.x},${p.y})"><circle r="28" fill="${n.color}" opacity="0.15" /><circle r="24" fill="${n.color}" /><text y="5" font-size="14" fill="#fff" text-anchor="middle" font-weight="600">${escapeHtml(n.name.charAt(0))}</text><text y="38" font-size="12" fill="var(--text)" text-anchor="middle">${escapeHtml(n.name)}</text></g>`;
    }).join('');
    const modal = createModal('角色关系图谱', `
        <div style="overflow-x:auto;"><svg width="${width}" height="${height}" style="background:var(--bg);border-radius:12px;">${svgEdges}${svgNodes}</svg></div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:8px;text-align:center;">共 ${chars.length} 个角色 · ${edges.length} 组关系</div>`);
    modal.show();
}

async function autoLinkAllChars(novelId) {
    const chapters = await novelManager.listChapters(novelId);
    if (chapters.length === 0) { ui.showToast('暂无章节'); return; }
    ui.showToast('正在自动关联角色…');
    let total = 0;
    for (const ch of chapters) {
        const linked = await novelManager.autoLinkCharacters(novelId, ch.number);
        total += linked.length;
    }
    ui.showToast(`完成：共关联 ${total} 次角色引用`);
}

// ===== AI Character Context Builder =====
async function buildCharacterContext(novelId, chapterNum) {
    const chars = await novelManager.listCharacters(novelId);
    if (chars.length === 0) return '';
    const linkedIds = await novelManager.getChapterCharacters(novelId, chapterNum);
    let relevantChars = chars;
    if (linkedIds && linkedIds.length > 0) {
        relevantChars = chars.filter(c => linkedIds.includes(c.id));
    }
    if (relevantChars.length === 0) relevantChars = chars.slice(0, 5);
    return relevantChars.map(c => {
        const parts = [`【${c.name}】`];
        if (c.appearance) parts.push(`外貌：${c.appearance}`);
        if (c.personality) parts.push(`性格：${c.personality}`);
        if (c.backstory) parts.push(`背景：${c.backstory}`);
        if (c.catchphrase) parts.push(`口头禅：${c.catchphrase}`);
        if (c.currentStatus) parts.push(`当前状态：${c.currentStatus}`);
        if (c.arc) parts.push(`人物弧光：${c.arc}`);
        return parts.join('\n');
    }).join('\n\n');
}

// ===== World View Page (v2.5.0) =====
const WB_CATEGORIES = [
    { key: 'map', icon: '🗺️', label: '地图与地理' },
    { key: 'faction', icon: '⚔️', label: '势力与组织' },
    { key: 'timeline', icon: '⏳', label: '时间线与历史' },
    { key: 'rule', icon: '📜', label: '规则与法则' },
    { key: 'research', icon: '🔎', label: '参考资料' },
    { key: 'other', icon: '📦', label: '其他设定' }
];

async function renderWorldView(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    ui.setPageTitle(`🌍 ${novel.title} · 世界观`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="navigateTo('worldviewEdit', { novelId: '${novelId}' })">+ 新建</button>
    `);

    const items = await novelManager.listWorldbuilding(novelId);
    const cats = WB_CATEGORIES;

    container.innerHTML = `
        <div style="padding: 12px 16px;">
            <div class="wb-cat-tabs" style="display:flex;gap:8px;margin-bottom:16px;overflow-x:auto;">
                <button class="wb-cat-tab active" onclick="filterWorldview('all', '${novelId}')">全部</button>
                ${cats.map(c => `<button class="wb-cat-tab" onclick="filterWorldview('${c.key}', '${novelId}')">${c.icon} ${c.label}</button>`).join('')}
            </div>
            <div id="wb-list"></div>
        </div>
    `;
    renderWorldviewList(items, novelId);
}

function renderWorldviewList(items, novelId) {
    const list = document.getElementById('wb-list');
    if (!list) return;
    if (items.length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">🌍</div><div class="empty-title">暂无世界观设定</div><div class="empty-desc">点击右上角 + 新建添加地图、势力、规则等设定</div></div>`;
        return;
    }
    list.innerHTML = items.map(item => {
        const cat = WB_CATEGORIES.find(c => c.key === item.category) || WB_CATEGORIES[4];
        return `
            <div class="wb-item" onclick="navigateTo('worldviewEdit', { novelId: '${novelId}', worldviewId: '${item.id}' })">
                <div class="wb-item-icon">${cat.icon}</div>
                <div class="wb-item-body">
                    <div class="wb-item-title">${escapeHtml(item.title)}</div>
                    <div class="wb-item-cat">${cat.label}</div>
                    <div class="wb-item-content">${escapeHtml(item.content.substring(0, 120))}${item.content.length > 120 ? '…' : ''}</div>
                </div>
                <span class="settings-arrow">›</span>
            </div>`;
    }).join('');
}

let currentWbFilter = 'all';
async function filterWorldview(category, novelId) {
    currentWbFilter = category;
    document.querySelectorAll('.wb-cat-tab').forEach(tab => tab.classList.toggle('active', tab.textContent.includes(category === 'all' ? '全部' : '') || tab.getAttribute('onclick')?.includes(`'${category}'`)));
    const items = category === 'all' ? await novelManager.listWorldbuilding(novelId) : await novelManager.listWorldbuilding(novelId, category);
    renderWorldviewList(items, novelId);
}

async function renderWorldviewEdit(container, novelId, worldviewId) {
    const item = worldviewId ? await novelManager.getWorldbuilding(worldviewId) : null;
    const isNew = !item;
    ui.setPageTitle(isNew ? '新建设定' : `编辑 · ${item.title}`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('worldview', { novelId: '${novelId}' })">返回</button>
        ${!isNew ? `<button class="header-btn" onclick="deleteWorldview('${worldviewId}', '${novelId}')">删除</button>` : ''}
        <button class="header-btn" onclick="saveWorldview('${novelId}', '${worldviewId || ''}')">保存</button>
    `);

    container.innerHTML = `
        <div style="padding: 12px 16px; display:flex; flex-direction:column; gap: 12px;">
            <div><label class="form-label">分类</label>
            <select class="form-select" id="wb-cat">
                ${WB_CATEGORIES.map(c => `<option value="${c.key}" ${item?.category===c.key?'selected':''}>${c.icon} ${c.label}</option>`).join('')}
            </select></div>
            <div><label class="form-label">标题 *</label>
            <input type="text" class="form-input" id="wb-title" value="${escapeHtml(item?.title || '')}" placeholder="如：青云大陆地图"></div>
            <div><label class="form-label">内容</label>
            <textarea class="form-textarea" id="wb-content" rows="6" placeholder="详细描述该设定…">${escapeHtml(item?.content || '')}</textarea></div>
            <div><label class="form-label">约束规则（AI 写作时必须遵守）</label>
            <textarea class="form-textarea" id="wb-rules" rows="4" placeholder="如：灵气浓度随海拔升高而降低；凡人不可直视仙人真容，否则爆体而亡…">${escapeHtml(item?.rules || '')}</textarea></div>
        </div>`;
}

async function saveWorldview(novelId, id) {
    const cat = document.getElementById('wb-cat').value;
    const title = document.getElementById('wb-title').value.trim();
    if (!title) { ui.showToast('请输入标题'); return; }
    const data = {
        category: cat,
        title,
        content: document.getElementById('wb-content').value.trim(),
        rules: document.getElementById('wb-rules').value.trim()
    };
    try {
        if (id) {
            await novelManager.updateWorldbuilding(id, data);
            ui.showToast('设定已更新');
        } else {
            await novelManager.createWorldbuilding(novelId, data);
            ui.showToast('设定已创建');
        }
        navigateTo('worldview', { novelId });
    } catch (e) {
        ui.showToast('保存失败: ' + e.message);
    }
}

async function deleteWorldview(id, novelId) {
    if (!confirm('确定删除此设定吗？')) return;
    try {
        await novelManager.deleteWorldbuilding(id);
        ui.showToast('已删除');
        navigateTo('worldview', { novelId });
    } catch (e) {
        ui.showToast('删除失败: ' + e.message);
    }
}

// ===== AI Worldbuilding Context Injection =====
async function buildWorldbuildingContext(novelId) {
    const items = await novelManager.listWorldbuilding(novelId);
    if (items.length === 0) return '';
    const parts = ['【世界观设定】'];
    WB_CATEGORIES.forEach(cat => {
        const catItems = items.filter(i => i.category === cat.key);
        if (catItems.length > 0) {
            parts.push(`\n${cat.icon} ${cat.label}：`);
            catItems.forEach(item => {
                parts.push(`  · ${item.title}：${item.content.substring(0, 200)}${item.content.length > 200 ? '…' : ''}`);
                if (item.rules) parts.push(`    [规则] ${item.rules}`);
            });
        }
    });
    return parts.join('\n');
}

// ===== AI Worldbuilding Conflict Check =====
async function checkWorldbuildingConflict(novelId, text) {
    const items = await novelManager.listWorldbuilding(novelId);
    if (items.length === 0) return [];
    const conflicts = [];
    for (const item of items) {
        if (!item.rules) continue;
        const keywords = extractKeywords(item.rules);
        const found = keywords.filter(kw => text.includes(kw));
        if (found.length > 0) {
            try {
                const prompt = `请判断以下文本是否违反了设定规则。

设定：${item.title}
规则：${item.rules}

文本片段：
${text.substring(0, 800)}

只需回答：是（违反）/ 否（未违反）。如果是，简要说明违反了哪条规则。`;
                const result = await ai.chat([
                    { role: 'system', content: '你是严格的设定审查官，只回答"是"或"否"。' },
                    { role: 'user', content: prompt }
                ], null, 500);
                if (result.includes('是') || result.includes('违反')) {
                    conflicts.push({ item, reason: result.replace(/^是[：:]?\s*/, '').substring(0, 100) || '可能违反设定规则' });
                }
            } catch (e) {
                if (found.length >= 2) {
                    conflicts.push({ item, reason: `包含规则关键词：${found.join('、')}` });
                }
            }
        }
    }
    return conflicts;
}

// ===== Foreshadowing DAG (v2.6.0) =====
async function renderForeshadowing(novelId, container) {
    const novel = await novelManager.getNovel(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    const view = container || document.getElementById('page-foreshadowing') || document.getElementById('main-content');
    const items = await novelManager.listForeshadowing(novelId);
    // 旧代码误用 novel.chapters（不存在），导致进度与逾期判断始终按 1 章计算
    const chapters = await novelManager.listChapters(novelId);
    const totalChapters = Math.max(1, novel.chapterCount || chapters.length || 1);
    ui.setPageTitle(`🔍 伏笔追踪 · ${escapeHtml(novel.title)}`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="aiDetectForeshadowing('${novelId}')">AI识别</button>
        <button class="header-btn" onclick="navigateTo('foreshadowingEdit', { novelId: '${novelId}' })">+ 新建</button>
    `);
    let currentFilter = 'all';
    const filterTabs = (filter) => {
        currentFilter = filter;
        const filtered = filter === 'all' ? items : items.filter(i => i.status === filter);
        renderForeshadowingList(filtered, totalChapters, novelId);
    };
    const renderForeshadowingList = (list, total, nid) => {
        const container = document.getElementById('foreshadowing-list');
        if (!container) return;
        if (list.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">暂无伏笔</div><div class="empty-desc">点击右上角"+ 新建"或"AI识别"开始追踪</div></div>`;
            return;
        }
        container.innerHTML = list.map(fs => {
            const progress = total > 0 ? Math.min(100, Math.round(((fs.plantChapter || 1) / total) * 100)) : 0;
            const isHarvested = fs.status === 'harvested';
            const isOverdue = !isHarvested && (fs.targetChapter || 1) < total;
            const impactClass = fs.impact === 'high' ? 'fs-impact-high' : fs.impact === 'low' ? 'fs-impact-low' : 'fs-impact-medium';
            const impactLabel = fs.impact === 'high' ? '高' : fs.impact === 'low' ? '低' : '中';
            return `
            <div class="fs-card ${isHarvested ? 'fs-harvested' : ''}" onclick="navigateTo('foreshadowingEdit', { novelId: '${nid}', foreshadowingId: '${fs.id}' })">
                <div class="fs-header">
                    <div class="fs-status-tag ${isHarvested ? 'fs-tag-harvested' : 'fs-tag-planted'}">${isHarvested ? '✅ 已回收' : '🌱 已埋设'}</div>
                    <div class="fs-impact ${impactClass}">${impactLabel}</div>
                    ${isOverdue ? '<div class="fs-overdue">⚠️ 已到期</div>' : ''}
                </div>
                <div class="fs-desc">${escapeHtml(fs.description)}</div>
                <div class="fs-chapters">
                    <span>第${fs.plantChapter || 1}章 埋设</span>
                    <span class="fs-arrow">→</span>
                    <span>第${fs.targetChapter || 1}章 回收</span>
                </div>
                <div class="fs-progress-bar">
                    <div class="fs-progress-track">
                        <div class="fs-progress-fill" style="width: ${isHarvested ? 100 : progress}%"></div>
                    </div>
                    <div class="fs-progress-text">${isHarvested ? '已回收' : `进度 ${progress}%`}</div>
                </div>
                ${fs.notes ? `<div class="fs-notes">📝 ${escapeHtml(fs.notes)}</div>` : ''}
                <div class="fs-actions">
                    <button class="fs-btn" onclick="event.stopPropagation(); viewForeshadowingDAG('${fs.id}', '${nid}')">查看路径</button>
                    ${!isHarvested ? `<button class="fs-btn fs-btn-primary" onclick="event.stopPropagation(); harvestForeshadowing('${fs.id}', '${nid}')">标记回收</button>` : ''}
                </div>
            </div>`;
        }).join('');
    };
    const content = view;
    content.innerHTML = `
        <div style="padding: 12px 16px;">
            <div class="fs-filter-row">
                <button class="fs-filter-btn active" data-filter="all">全部</button>
                <button class="fs-filter-btn" data-filter="planted">已埋设</button>
                <button class="fs-filter-btn" data-filter="harvested">已回收</button>
            </div>
            <div id="foreshadowing-list"></div>
        </div>`;
    content.querySelector('.fs-filter-row').addEventListener('click', (e) => {
        if (e.target.classList.contains('fs-filter-btn')) {
            content.querySelectorAll('.fs-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            const f = e.target.dataset.filter;
            filterTabs(f);
        }
    });
    renderForeshadowingList(items, totalChapters, novelId);
}

async function renderForeshadowingEdit(novelId, foreshadowingId, viewContainer) {
    const novel = await novelManager.getNovel(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    const fs = foreshadowingId ? await novelManager.getForeshadowing(foreshadowingId) : null;
    const isNew = !fs;
    const chapters = await novelManager.listChapters(novelId);
    const maxChapter = Math.max(1, novel.chapterCount || chapters.length || 1);
    const viewRoot = viewContainer || document.getElementById('page-foreshadowingEdit') || document.getElementById('main-content');
    ui.setPageTitle(isNew ? '新建伏笔' : '编辑伏笔');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('foreshadowing', { novelId: '${novelId}' })">返回</button>
        ${!isNew ? `<button class="header-btn" onclick="deleteForeshadowing('${foreshadowingId}', '${novelId}')">删除</button>` : ''}
        <button class="header-btn" onclick="saveForeshadowing('${novelId}', '${foreshadowingId || ''}')">保存</button>
    `);
    const container = viewRoot;
    container.innerHTML = `
        <div style="padding: 12px 16px; display:flex; flex-direction:column; gap: 14px;">
            <div>
                <label class="form-label">伏笔描述 *</label>
                <textarea class="form-textarea" id="fs-description" rows="3" placeholder="如：主角在旧货市场买到一枚刻有奇怪符号的铜币">${escapeHtml(fs?.description || '')}</textarea>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div>
                    <label class="form-label">埋设章节</label>
                    <input type="number" class="form-input" id="fs-plant" value="${fs?.plantChapter || 1}" min="1" max="${maxChapter}">
                </div>
                <div>
                    <label class="form-label">目标回收章节</label>
                    <input type="number" class="form-input" id="fs-target" value="${fs?.targetChapter || maxChapter}" min="1" max="${maxChapter + 50}">
                </div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div>
                    <label class="form-label">影响等级</label>
                    <select class="form-select" id="fs-impact">
                        <option value="low" ${fs?.impact === 'low' ? 'selected' : ''}>🟢 低 - 细节铺垫</option>
                        <option value="medium" ${fs?.impact === 'medium' || !fs?.impact ? 'selected' : ''}>🟡 中 - 情节转折</option>
                        <option value="high" ${fs?.impact === 'high' ? 'selected' : ''}>🔴 高 - 核心剧透</option>
                    </select>
                </div>
                <div>
                    <label class="form-label">当前状态</label>
                    <select class="form-select" id="fs-status">
                        <option value="planted" ${fs?.status === 'planted' || !fs?.status ? 'selected' : ''}>🌱 已埋设</option>
                        <option value="harvested" ${fs?.status === 'harvested' ? 'selected' : ''}>✅ 已回收</option>
                    </select>
                </div>
            </div>
            <div>
                <label class="form-label">备注 / 回收方式</label>
                <textarea class="form-textarea" id="fs-notes" rows="3" placeholder="如：回收方式——铜币在第十章被反派认出是开启遗迹的钥匙，引发争夺战">${escapeHtml(fs?.notes || '')}</textarea>
            </div>
            ${!isNew ? `
            <div class="fs-meta">
                创建于 ${formatDate(fs.created)} · 更新于 ${formatDate(fs.updated)}
            </div>` : ''}
        </div>`;
}

async function saveForeshadowing(novelId, id) {
    const description = document.getElementById('fs-description').value.trim();
    if (!description) { ui.showToast('请输入伏笔描述'); return; }
    const plantChapter = parseInt(document.getElementById('fs-plant').value) || 1;
    const targetChapter = parseInt(document.getElementById('fs-target').value) || 1;
    const data = {
        description,
        plantChapter: Math.max(1, plantChapter),
        targetChapter: Math.max(1, targetChapter),
        impact: document.getElementById('fs-impact').value,
        status: document.getElementById('fs-status').value,
        notes: document.getElementById('fs-notes').value.trim()
    };
    try {
        if (id) {
            await novelManager.updateForeshadowing(id, data);
            ui.showToast('伏笔已更新');
        } else {
            await novelManager.createForeshadowing(novelId, data);
            ui.showToast('伏笔已创建');
        }
        navigateTo('foreshadowing', { novelId });
    } catch (e) {
        ui.showToast('保存失败: ' + e.message);
    }
}

async function deleteForeshadowing(id, novelId) {
    if (!confirm('确定删除此伏笔吗？相关追踪记录将一并移除。')) return;
    try {
        await novelManager.deleteForeshadowing(id);
        ui.showToast('已删除');
        navigateTo('foreshadowing', { novelId });
    } catch (e) {
        ui.showToast('删除失败: ' + e.message);
    }
}

async function harvestForeshadowing(id, novelId) {
    try {
        await novelManager.updateForeshadowing(id, { status: 'harvested' });
        ui.showToast('已标记为回收');
        renderForeshadowing(novelId);
    } catch (e) {
        ui.showToast('操作失败: ' + e.message);
    }
}

async function viewForeshadowingDAG(foreshadowingId, novelId) {
    const fs = await novelManager.getForeshadowing(foreshadowingId);
    if (!fs) { ui.showToast('伏笔不存在'); return; }
    const novel = await novelManager.getNovel(novelId);
    const totalChapters = Math.max(1, novel?.chapters || 1);
    const allFs = await novelManager.listForeshadowing(novelId);
    const related = allFs.filter(f => f.id !== fs.id && Math.abs((f.plantChapter || 1) - (fs.targetChapter || 1)) <= 2);
    const plantPct = Math.round(((fs.plantChapter || 1) / totalChapters) * 100);
    const targetPct = Math.round(((fs.targetChapter || 1) / totalChapters) * 100);
    const progress = fs.status === 'harvested' ? 100 : Math.max(0, Math.min(100, Math.round(((Math.min(totalChapters, novel?.currentChapter || 1) - (fs.plantChapter || 1)) / Math.max(1, (fs.targetChapter || 1) - (fs.plantChapter || 1))) * 100)));
    const isOverdue = fs.status !== 'harvested' && (fs.targetChapter || 1) < (novel?.currentChapter || 1);
    const dagHtml = `
        <div class="fs-dag-container">
            <div class="fs-dag-title">${escapeHtml(fs.description)}</div>
            <div class="fs-dag-path">
                <div class="fs-dag-node">
                    <div class="fs-dag-node-label">埋设</div>
                    <div class="fs-dag-node-chapter">第${fs.plantChapter || 1}章</div>
                    <div class="fs-dag-node-pct">${plantPct}%</div>
                </div>
                <div class="fs-dag-edge">
                    <div class="fs-dag-arrow">→</div>
                    <div class="fs-dag-progress">${progress}%</div>
                </div>
                <div class="fs-dag-node ${fs.status === 'harvested' ? 'fs-dag-done' : isOverdue ? 'fs-dag-overdue' : ''}">
                    <div class="fs-dag-node-label">${fs.status === 'harvested' ? '✅ 已回收' : isOverdue ? '⚠️ 待回收' : '待回收'}</div>
                    <div class="fs-dag-node-chapter">第${fs.targetChapter || 1}章</div>
                    <div class="fs-dag-node-pct">${targetPct}%</div>
                </div>
            </div>
            ${isOverdue ? `<div class="fs-dag-alert">⚠️ 当前已写到第${novel?.currentChapter || 1}章，此伏笔已逾期 ${(novel?.currentChapter || 1) - (fs.targetChapter || 1)} 章未回收</div>` : ''}
            <div class="fs-dag-progress-track">
                <div class="fs-dag-progress-fill" style="width: ${progress}%"></div>
            </div>
            ${related.length > 0 ? `
            <div class="fs-dag-related">
                <div class="fs-dag-related-title">关联伏笔</div>
                ${related.map(r => `
                <div class="fs-dag-related-item" onclick="document.querySelector('.modal-overlay').remove(); viewForeshadowingDAG('${r.id}', '${novelId}')">
                    <span class="fs-dag-related-status ${r.status === 'harvested' ? 'done' : 'pending'}">${r.status === 'harvested' ? '✅' : '🌱'}</span>
                    <span class="fs-dag-related-desc">${escapeHtml(r.description)}</span>
                    <span class="fs-dag-related-ch">${r.plantChapter || 1}→${r.targetChapter || 1}</span>
                </div>`).join('')}
            </div>` : ''}
        </div>`;
    createModal('伏笔路径图', dagHtml);
}

async function aiDetectForeshadowing(novelId) {
    const novel = await novelManager.getNovel(novelId);
    if (!novel) { ui.showToast('作品不存在'); return; }
    const chapters = await novelManager.listChapters(novelId);
    if (chapters.length === 0) { ui.showToast('请先创建章节'); return; }
    const recentChapters = chapters.slice(-5);
    const combinedText = recentChapters.map(c => c.title + '\n' + (c.content || '')).join('\n\n').substring(0, 3000);
    ui.showLoading(document.getElementById('view-container'));
    try {
        const prompt = `分析以下小说章节内容，识别其中可能埋设的伏笔（即后文需要回收的暗示、线索或铺垫）。\n\n要求：\n1. 只返回 JSON 数组格式，不要其他文字\n2. 每个伏笔包含：description（描述）, plantChapter（埋设章节号）, targetChapter（预计回收章节号，估算值）, impact（影响等级：low/medium/high）, notes（回收方式建议）\n3. 最多返回 5 个最可能的伏笔\n4. 如果内容中没有明显伏笔，返回空数组 []\n\n章节内容：\n${combinedText.substring(0, 2500)}`;
        const result = await ai.chat([
            { role: 'system', content: '你是专业的小说结构分析师，擅长识别伏笔和铺垫。只输出纯JSON数组，不要markdown代码块。' },
            { role: 'user', content: prompt }
        ], null, 1200);
        let detected = [];
        try {
            const cleaned = result.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
            detected = JSON.parse(cleaned);
            if (!Array.isArray(detected)) detected = [];
        } catch (e) {
            const match = result.match(/\[[\s\S]*\]/);
            if (match) {
                try { detected = JSON.parse(match[0]); } catch (_) {}
            }
        }
        if (detected.length === 0) {
            ui.showToast('未检测到明显伏笔，请手动添加');
            renderForeshadowing(novelId);
            return;
        }
        const modalContent = `
            <div class="fs-detect-container">
                <div class="fs-detect-title">AI识别到 ${detected.length} 个潜在伏笔</div>
                ${detected.map((item, idx) => `
                <div class="fs-detect-item" id="fs-detect-${idx}">
                    <div class="fs-detect-desc">${escapeHtml(item.description || '')}</div>
                    <div class="fs-detect-meta">
                        <span>埋设：第${item.plantChapter || 1}章</span>
                        <span>回收：第${item.targetChapter || 1}章</span>
                        <span class="fs-detect-impact ${item.impact === 'high' ? 'high' : item.impact === 'low' ? 'low' : 'medium'}">${item.impact === 'high' ? '高' : item.impact === 'low' ? '低' : '中'}</span>
                    </div>
                    ${item.notes ? `<div class="fs-detect-notes">${escapeHtml(item.notes)}</div>` : ''}
                    <button class="fs-detect-add-btn" onclick="addDetectedForeshadowing('${novelId}', ${idx})">➕ 添加此伏笔</button>
                </div>
                `).join('')}
                <button class="fs-detect-add-all" onclick="addAllDetectedForeshadowing('${novelId}')">一键添加全部</button>
            </div>`;
        window._detectedForeshadowing = detected;
        window._detectedNovelId = novelId;
        createModal('AI 伏笔识别', modalContent);
    } catch (e) {
        ui.showToast('AI识别失败: ' + e.message);
        renderForeshadowing(novelId);
    }
}

async function addDetectedForeshadowing(novelId, idx) {
    const detected = window._detectedForeshadowing;
    if (!detected || !detected[idx]) return;
    const item = detected[idx];
    try {
        await novelManager.createForeshadowing(novelId, {
            description: item.description || '',
            plantChapter: parseInt(item.plantChapter) || 1,
            targetChapter: parseInt(item.targetChapter) || 1,
            impact: ['low', 'medium', 'high'].includes(item.impact) ? item.impact : 'medium',
            notes: item.notes || ''
        });
        ui.showToast('伏笔已添加');
        document.getElementById(`fs-detect-${idx}`)?.classList.add('fs-detect-added');
    } catch (e) {
        ui.showToast('添加失败: ' + e.message);
    }
}

async function addAllDetectedForeshadowing(novelId) {
    const detected = window._detectedForeshadowing;
    if (!detected || detected.length === 0) return;
    let added = 0;
    for (const item of detected) {
        try {
            await novelManager.createForeshadowing(novelId, {
                description: item.description || '',
                plantChapter: parseInt(item.plantChapter) || 1,
                targetChapter: parseInt(item.targetChapter) || 1,
                impact: ['low', 'medium', 'high'].includes(item.impact) ? item.impact : 'medium',
                notes: item.notes || ''
            });
            added++;
        } catch (_) {}
    }
    ui.showToast(`已添加 ${added} 个伏笔`);
    closeModal();
    renderForeshadowing(novelId);
}

// ===== Paragraph Edit (v2.7.0) =====

const PARA_TYPES = {
    scene:    { label: '场景', icon: '🎬', desc: '环境、时间、地点描写' },
    dialogue: { label: '对话', icon: '💬', desc: '角色对话、独白' },
    describe: { label: '描写', icon: '🎨', desc: '外貌、景物、氛围描写' },
    action:   { label: '动作', icon: '⚔️', desc: '动作、战斗、行为描写' },
    inner:    { label: '内心', icon: '🧠', desc: '心理活动、内心独白' },
    trans:    { label: '过渡', icon: '↔️', desc: '转场、时间跳跃、过渡段' }
};

function parseContentToParagraphs(content) {
    if (!content) return [];
    const raw = content.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
    const paragraphs = [];
    for (let i = 0; i < raw.length; i++) {
        const text = raw[i];
        let type = 'scene';
        if (text.startsWith('"') || text.startsWith('“') || text.startsWith('「') || text.includes('：') || text.includes(':') || /^[""''「」].*[""''」]/s.test(text)) type = 'dialogue';
        else if (text.includes('想') || text.includes('觉得') || text.includes('感觉') || text.includes('心理')) type = 'inner';
        else if (text.includes('打') || text.includes('挥') || text.includes('跑') || text.includes('走') || text.includes('跳') || text.includes('杀') || text.includes('战')) type = 'action';
        else if (text.includes('天') || text.includes('地') || text.includes('风') || text.includes('雨') || text.includes('山') || text.includes('水') || text.includes('色') || text.includes('光')) type = 'describe';
        else if (text.length < 60 && (text.includes('后来') || text.includes('之后') || text.includes('过了') || text.includes(' meanwhile') || text.includes('转')) && i > 0 && i < raw.length - 1) type = 'trans';
        paragraphs.push({ id: `para_${i}_${Date.now().toString(36)}`, type, content: text, meta: {}, modified: false });
    }
    return paragraphs;
}

function paragraphsToContent(paragraphs) {
    return paragraphs.map(p => p.content).join('\n\n');
}

async function renderParagraphEdit(novelId, chapterNum) {
    const view = document.getElementById('page-paragraphEdit');
    if (!view) return;
    const novel = await novelManager.get(novelId);
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    ui.setPageTitle(`${novel?.title || ''} · 第${chapterNum}章 分段编辑`);
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('chapterEdit', { novelId: '${novelId}', chapterNum: ${chapterNum} })">返回</button><button class="header-btn" onclick="saveParagraphEdit('${novelId}', ${chapterNum})">保存</button>`);

    let paragraphs = chapter?.paragraphs;
    if (!paragraphs || !Array.isArray(paragraphs) || paragraphs.length === 0) {
        paragraphs = parseContentToParagraphs(chapter?.content || '');
    }
    window._paragraphEditData = { novelId, chapterNum, paragraphs };

    view.innerHTML = `
        <div class="para-edit-container">
            <div class="para-edit-toolbar">
                <button class="btn btn-sm btn-outline" onclick="aiAutoSegment('${novelId}', ${chapterNum})">🤖 AI智能分段</button>
                <button class="btn btn-sm btn-outline" onclick="addNewParagraph()">➕ 添加段落</button>
            </div>
            <div class="para-edit-list" id="para-edit-list">
                ${paragraphs.map((p, idx) => renderParagraphCard(p, idx)).join('')}
            </div>
        </div>`;
}

function renderParagraphCard(para, idx) {
    const typeInfo = PARA_TYPES[para.type] || PARA_TYPES.scene;
    return `
        <div class="para-card ${para.modified ? 'para-modified' : ''}" id="para-card-${idx}">
            <div class="para-card-header">
                <span class="para-type-badge" style="background: var(--primary-light); color: #fff;" onclick="changeParagraphType(${idx})">${typeInfo.icon} ${typeInfo.label}</span>
                <span class="para-idx">#${idx + 1}</span>
                <div class="para-actions">
                    <button class="para-btn" onclick="moveParagraph(${idx}, -1)" title="上移">↑</button>
                    <button class="para-btn" onclick="moveParagraph(${idx}, 1)" title="下移">↓</button>
                    <button class="para-btn" onclick="deleteParagraph(${idx})" title="删除">🗑</button>
                    <button class="para-btn para-btn-ai" onclick="openAiParaAction(${idx})" title="AI操作">✨</button>
                </div>
            </div>
            <textarea class="para-textarea" id="para-text-${idx}" rows="4" onchange="markParagraphModified(${idx})">${escapeHtml(para.content)}</textarea>
            ${para.meta?.aiNote ? `<div class="para-meta">AI备注: ${escapeHtml(para.meta.aiNote)}</div>` : ''}
        </div>`;
}

function markParagraphModified(idx) {
    const data = window._paragraphEditData;
    if (!data) return;
    data.paragraphs[idx].content = document.getElementById(`para-text-${idx}`).value;
    data.paragraphs[idx].modified = true;
    const card = document.getElementById(`para-card-${idx}`);
    if (card) card.classList.add('para-modified');
}

function changeParagraphType(idx) {
    const data = window._paragraphEditData;
    if (!data) return;
    const current = data.paragraphs[idx].type;
    const keys = Object.keys(PARA_TYPES);
    const next = keys[(keys.indexOf(current) + 1) % keys.length];
    data.paragraphs[idx].type = next;
    data.paragraphs[idx].modified = true;
    renderParagraphEdit(data.novelId, data.chapterNum);
}

function moveParagraph(idx, dir) {
    const data = window._paragraphEditData;
    if (!data) return;
    const target = idx + dir;
    if (target < 0 || target >= data.paragraphs.length) return;
    const tmp = data.paragraphs[idx];
    data.paragraphs[idx] = data.paragraphs[target];
    data.paragraphs[target] = tmp;
    renderParagraphEdit(data.novelId, data.chapterNum);
}

function deleteParagraph(idx) {
    const data = window._paragraphEditData;
    if (!data) return;
    if (!confirm('确定删除此段落吗？')) return;
    data.paragraphs.splice(idx, 1);
    renderParagraphEdit(data.novelId, data.chapterNum);
}

function addNewParagraph() {
    const data = window._paragraphEditData;
    if (!data) return;
    data.paragraphs.push({ id: `para_${data.paragraphs.length}_${Date.now().toString(36)}`, type: 'scene', content: '', meta: {}, modified: true });
    renderParagraphEdit(data.novelId, data.chapterNum);
}

async function saveParagraphEdit(novelId, chapterNum) {
    const data = window._paragraphEditData;
    if (!data) return;
    const paragraphs = data.paragraphs;
    const content = paragraphsToContent(paragraphs);
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    const title = chapter?.title || `第${chapterNum}章`;
    await novelManager.saveChapter(novelId, chapterNum, title, content, paragraphs);
    ui.showToast('分段编辑已保存');
    navigateTo('chapterEdit', { novelId, chapterNum });
}

// AI单段操作弹窗
function openAiParaAction(idx) {
    const data = window._paragraphEditData;
    if (!data) return;
    const para = data.paragraphs[idx];
    const actions = [
        { key: 'rewrite', label: '✍️ 重写' },
        { key: 'expand', label: '📈 扩写' },
        { key: 'condense', label: '📉 缩略' },
        { key: 'viewpoint', label: '🔄 切换视角' }
    ];
    const html = `
        <div class="para-ai-modal">
            <div class="para-ai-title">AI段落操作 — ${PARA_TYPES[para.type]?.label || '段落'} #${idx + 1}</div>
            <div class="para-ai-actions">
                ${actions.map(a => `<button class="btn btn-outline btn-block" style="margin-bottom: 8px;" onclick="runAiParaAction(${idx}, '${a.key}')">${a.label}</button>`).join('')}
            </div>
            <div style="margin-top: 12px;">
                <input type="text" class="input" id="para-custom-cmd" placeholder="自定义指令，如：增加悬念感...">
                <button class="btn btn-primary btn-block" style="margin-top: 8px;" onclick="runAiParaAction(${idx}, 'custom')">🚀 执行自定义</button>
            </div>
            <div style="margin-top: 12px; font-size: 12px; color: var(--text-tertiary);">修改后将自动触发涟漪更新（后续3段）</div>
        </div>`;
    createModal('AI 段落操作', html);
}

async function runAiParaAction(idx, action) {
    const data = window._paragraphEditData;
    if (!data) return;
    const novel = await novelManager.get(data.novelId);
    const para = data.paragraphs[idx];
    let instruction = '';
    if (action === 'rewrite') instruction = '请重写以下段落，保持核心情节不变，但优化文笔、节奏和表达。';
    else if (action === 'expand') instruction = '请扩写以下段落，增加细节描写、环境渲染或心理活动，使内容更丰富饱满。';
    else if (action === 'condense') instruction = '请缩略以下段落，保留核心信息和关键细节，去除冗余描述。';
    else if (action === 'viewpoint') instruction = '请切换以下段落的叙事视角（如第一人称改第三人称，或更换聚焦角色）。';
    else if (action === 'custom') {
        const cmd = document.getElementById('para-custom-cmd')?.value.trim();
        if (!cmd) { ui.showToast('请输入自定义指令'); return; }
        instruction = `请按以下要求修改段落：${cmd}`;
    }

    const prompt = `${instruction}\n\n段落类型：${PARA_TYPES[para.type]?.label || '段落'}\n\n原文：\n${para.content}\n\n只返回修改后的段落内容，不要解释。`;
    closeModal();
    ui.showToast('AI处理中...');
    try {
        const result = await ai.chat([
            { role: 'system', content: '你是专业小说编辑，擅长段落级别的精修。只输出修改后的段落正文，不输出额外解释。' },
            { role: 'user', content: prompt }
        ], null, 1200);
        const newContent = result.trim();
        showDiffAndConfirm(para.content, newContent, async () => {
            para.content = newContent;
            para.modified = true;
            if (action !== 'condense') {
                ui.showToast('已应用，正在涟漪更新后续段落...');
                await rippleUpdate(idx);
            } else {
                ui.showToast('已应用');
            }
            renderParagraphEdit(data.novelId, data.chapterNum);
        });
    } catch (e) {
        ui.showToast('AI处理失败: ' + e.message);
    }
}

function showDiffAndConfirm(oldText, newText, onConfirm) {
    const html = `
        <div class="diff-container">
            <div class="diff-section">
                <div class="diff-label">原文</div>
                <div class="diff-old">${escapeHtml(oldText)}</div>
            </div>
            <div class="diff-section">
                <div class="diff-label">修改后</div>
                <div class="diff-new">${escapeHtml(newText)}</div>
            </div>
            <div class="diff-actions">
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="closeModal(); (window._diffConfirmCallback)();">确认应用</button>
            </div>
        </div>`;
    window._diffConfirmCallback = onConfirm;
    createModal('Diff对比确认', html);
}

async function rippleUpdate(changedIdx) {
    const data = window._paragraphEditData;
    if (!data) return;
    const paragraphs = data.paragraphs;
    const start = changedIdx + 1;
    const end = Math.min(paragraphs.length, start + 3);
    if (start >= end) return;
    const novel = await novelManager.get(data.novelId);
    const prevContext = paragraphs.slice(Math.max(0, changedIdx - 1), changedIdx + 1).map(p => p.content).join('\n\n');
    const targetParagraphs = paragraphs.slice(start, end);
    const prompt = `以下是一个小说章节中的连续段落。第${changedIdx + 1}段已被修改，请根据修改后的上下文，调整后续${targetParagraphs.length}个段落，使其保持连贯一致。\n\n前文（含修改段）：\n${prevContext}\n\n需要调整的段落：\n${targetParagraphs.map((p, i) => `[段落${start + i + 1}] (${PARA_TYPES[p.type]?.label || '段落'})\n${p.content}`).join('\n\n')}\n\n请返回调整后的段落，格式如下，每段用 --- 分隔：\n段落1内容\n---\n段落2内容\n---\n段落3内容`;
    try {
        const result = await ai.chat([
            { role: 'system', content: '你是专业小说编辑，擅长保持段落间的连贯性。只输出调整后的段落内容，用 --- 分隔。' },
            { role: 'user', content: prompt }
        ], null, 2000);
        const parts = result.split(/\n?---+\n?/).map(s => s.trim()).filter(s => s.length > 0);
        for (let i = 0; i < parts.length && (start + i) < end; i++) {
            paragraphs[start + i].content = parts[i];
            paragraphs[start + i].modified = true;
        }
    } catch (e) {
        console.error('Ripple update failed:', e);
    }
}

async function aiAutoSegment(novelId, chapterNum) {
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!chapter || !chapter.content) { ui.showToast('章节无内容'); return; }
    const content = chapter.content;
    if (content.length < 100) { ui.showToast('内容太短，无需分段'); return; }
    ui.showLoading(document.getElementById('view-container') || document.body);
    try {
        const prompt = `请将以下小说章节内容按叙事功能自动分段。每个段落标记其类型（scene=场景, dialogue=对话, describe=描写, action=动作, inner=内心, trans=过渡）。\n\n要求：\n1. 只返回 JSON 数组，每个元素包含 type 和 content\n2. content 是段落正文，不要截断关键内容\n3. 保持原文完整性，不要遗漏内容\n4. 如果内容较短，至少分成3段\n\n章节内容：\n${content.substring(0, 4000)}`;
        const result = await ai.chat([
            { role: 'system', content: '你是专业小说结构分析师。只输出纯JSON数组，不要markdown代码块。' },
            { role: 'user', content: prompt }
        ], null, 3000);
        let segments = [];
        try {
            const cleaned = result.replace(/\`\`\`json?\s*/g, '').replace(/\`\`\`\s*/g, '').trim();
            segments = JSON.parse(cleaned);
            if (!Array.isArray(segments)) segments = [];
        } catch (e) {
            const match = result.match(/\[[\s\S]*\]/);
            if (match) {
                try { segments = JSON.parse(match[0]); } catch (_) {}
            }
        }
        if (segments.length === 0) {
            ui.showToast('AI分段失败，请手动分段');
            return;
        }
        const paragraphs = segments.map((s, i) => ({
            id: `para_${i}_${Date.now().toString(36)}`,
            type: Object.keys(PARA_TYPES).includes(s.type) ? s.type : 'scene',
            content: s.content || s.text || '',
            meta: { aiSegmented: true },
            modified: false
        })).filter(p => p.content.length > 0);
        if (paragraphs.length === 0) { ui.showToast('AI分段结果为空'); return; }
        window._paragraphEditData.paragraphs = paragraphs;
        renderParagraphEdit(novelId, chapterNum);
        ui.showToast(`AI已智能分段为 ${paragraphs.length} 段`);
    } catch (e) {
        ui.showToast('AI分段失败: ' + e.message);
    }
}

// ===== AI Reader Simulation (v2.7.0) =====

async function aiReaderSimulate(novelId, chapterNum) {
    const novel = await novelManager.get(novelId);
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!chapter || !chapter.content) { ui.showToast('章节无内容'); return; }
    ui.showToast('AI读者正在分析章节...');
    try {
        const prompt = `请你以资深网文读者的身份，对以下小说章节进行深度阅读分析。\n\n小说：《${novel?.title || '未命名'}》\n章节：第${chapterNum}章 ${chapter.title || ''}\n\n内容：\n${chapter.content.substring(0, 3500)}\n\n请输出以下JSON格式（不要markdown代码块）：\n{\n  "overallScore": 0-100的整数评分,\n  "emotionCurve": [{"segment": "开头", "score": 1-10}, {"segment": "发展", "score": 1-10}, {"segment": "高潮", "score": 1-10}, {"segment": "结尾", "score": 1-10}],\n  "highlights": ["爽点描述1", "爽点描述2"],\n  "issues": [{"type": "拖沓/逻辑/描写/节奏/其他", "desc": "问题描述", "severity": "low/medium/high"}],\n  "summary": "200字以内的综合点评"\n}`;
        const result = await ai.chat([
            { role: 'system', content: '你是一位资深的网络小说读者，擅长从读者体验角度分析小说章节。严格按JSON格式输出，不要其他文字。' },
            { role: 'user', content: prompt }
        ], null, 2000);
        let report = null;
        let rawText = result;
        const parseJson = (text) => {
            let cleaned = text.replace(/\`\`\`json?\s*/g, '').replace(/\`\`\`\s*/g, '').trim();
            try { return JSON.parse(cleaned); } catch (_) {}
            const m = cleaned.match(/\{[\s\S]*\}/);
            if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
            return null;
        };
        report = parseJson(result);
        // Fallback: try to extract structured data from raw text
        if (!report) {
            report = fallbackParseReaderReport(rawText);
        }
        if (!report) {
            ui.showToast('AI分析结果解析失败');
            return;
        }
        showAiReaderReport(novelId, chapterNum, report, rawText);
    } catch (e) {
        ui.showToast('AI读者分析失败: ' + e.message);
    }
}

function fallbackParseReaderReport(text) {
    const score = text.match(/评分[:：]\s*(\d+)/)?.[1];
    const summary = text.match(/总结[:：]([\s\S]*?)(?:\n{2,}|$)/)?.[1]?.trim();
    const highlights = [];
    const issues = [];
    const hlMatches = text.matchAll(/[•\-]\s*(爽点|亮点)[:：]?\s*(.+)/g);
    for (const m of hlMatches) highlights.push(m[2].trim());
    const issueMatches = text.matchAll(/[•\-]\s*(问题|不足|拖沓|逻辑|描写|节奏)[:：]?\s*(.+)/g);
    for (const m of issueMatches) {
        issues.push({ type: m[1].trim(), desc: m[2].trim(), severity: 'medium' });
    }
    if (!score && highlights.length === 0 && issues.length === 0 && !summary) return null;
    return {
        overallScore: parseInt(score) || 70,
        emotionCurve: [{ segment: '开头', score: 6 }, { segment: '发展', score: 6 }, { segment: '高潮', score: 6 }, { segment: '结尾', score: 6 }],
        highlights: highlights.length > 0 ? highlights : ['未明确提取爽点'],
        issues: issues.length > 0 ? issues : [{ type: '其他', desc: '未明确提取问题', severity: 'low' }],
        summary: summary || 'AI分析结果结构化提取不完整，建议查看原始输出。'
    };
}

function showAiReaderReport(novelId, chapterNum, report, rawText) {
    const ec = report.emotionCurve || [];
    const maxScore = Math.max(...ec.map(e => e.score || 0), 1);
    const ecHtml = ec.map(e => {
        const pct = Math.round(((e.score || 0) / maxScore) * 100);
        const color = (e.score || 0) >= 8 ? 'var(--success)' : (e.score || 0) >= 5 ? 'var(--warning)' : 'var(--danger)';
        return `<div class="reader-ec-item"><div class="reader-ec-label">${escapeHtml(e.segment)}</div><div class="reader-ec-bar"><div class="reader-ec-fill" style="width:${pct}%; background:${color}"></div></div><div class="reader-ec-score">${e.score}</div></div>`;
    }).join('');
    const highlightsHtml = (report.highlights || []).map(h => `<div class="reader-card reader-highlight">⚡ ${escapeHtml(h)}</div>`).join('') || '<div class="reader-card reader-highlight">暂无明确爽点</div>';
    const issuesHtml = (report.issues || []).map(iss => {
        const color = iss.severity === 'high' ? 'var(--danger)' : iss.severity === 'low' ? 'var(--success)' : 'var(--warning)';
        return `<div class="reader-card reader-issue" style="border-left-color:${color}"><div class="reader-issue-type" style="color:${color}">${escapeHtml(iss.type)}</div><div class="reader-issue-desc">${escapeHtml(iss.desc)}</div></div>`;
    }).join('') || '<div class="reader-card reader-issue">暂无明确问题</div>';
    const html = `
        <div class="reader-report">
            <div class="reader-score-section">
                <div class="reader-score-circle">
                    <div class="reader-score-num">${report.overallScore || 0}</div>
                    <div class="reader-score-label">综合评分</div>
                </div>
            </div>
            <div class="reader-section">
                <div class="reader-section-title">📈 情绪曲线</div>
                <div class="reader-ec">${ecHtml}</div>
            </div>
            <div class="reader-section">
                <div class="reader-section-title">⚡ 爽点 / 亮点</div>
                <div class="reader-cards">${highlightsHtml}</div>
            </div>
            <div class="reader-section">
                <div class="reader-section-title">⚠️ 问题诊断</div>
                <div class="reader-cards">${issuesHtml}</div>
            </div>
            <div class="reader-section">
                <div class="reader-section-title">📝 综合点评</div>
                <div class="reader-summary">${escapeHtml(report.summary || '')}</div>
            </div>
            <div class="reader-actions">
                <button class="btn btn-primary btn-block" onclick="aiReaderRewrite('${novelId}', ${chapterNum})">✨ 一键采纳建议并重写</button>
                <button class="btn btn-outline btn-block" style="margin-top:8px;" onclick="showRawReaderOutput('${escapeHtml(rawText?.substring(0, 800) || '')}')">📄 查看原始输出</button>
            </div>
        </div>`;
    createModal('🎭 AI读者分析报告', html);
}

function showRawReaderOutput(text) {
    createModal('原始输出', `<pre style="white-space:pre-wrap; font-size:12px; max-height:50vh; overflow-y:auto; background:var(--bg); padding:12px; border-radius:8px;">${escapeHtml(text)}</pre>`);
}

async function aiReaderRewrite(novelId, chapterNum) {
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!chapter || !chapter.content) { ui.showToast('章节无内容'); return; }
    closeModal();
    ui.showToast('AI正在根据读者反馈重写章节...');
    try {
        const prompt = `请你作为专业小说编辑，根据AI读者的反馈建议，对以下章节进行重写优化。\n\n要求：\n1. 保留核心情节和角色设定\n2. 增强爽点、优化节奏\n3. 修正读者指出的问题（如拖沓、逻辑漏洞等）\n4. 保持原有风格和字数大致相当\n5. 直接输出重写后的完整章节内容\n\n原文：\n${chapter.content.substring(0, 4000)}`;
        const result = await ai.chat([
            { role: 'system', content: '你是资深小说编辑，擅长根据读者反馈优化小说章节。直接输出重写后的完整正文。' },
            { role: 'user', content: prompt }
        ], null, 4000);
        const newContent = result.trim();
        showDiffAndConfirm(chapter.content, newContent, async () => {
            await novelManager.saveChapter(novelId, chapterNum, chapter.title, newContent, chapter.paragraphs);
            ui.showToast('章节已重写并保存');
            navigateTo('chapterEdit', { novelId, chapterNum });
        });
    } catch (e) {
        ui.showToast('重写失败: ' + e.message);
    }
}

// ===== 多Agent协作框架 (v2.7.0) =====
const AGENT_DEFS = [
    {
        key: 'goethe',
        name: 'Goethe',
        role: '规划师',
        icon: '🗺️',
        color: '#8b5cf6',
        tagline: '设计大纲、情节推演、世界构建',
        systemPrompt: '你是 Goethe，资深小说规划师。你的职责是：1) 设计四层大纲（全书-卷-章-节）；2) 推演情节走向与冲突升级；3) 构建世界观与规则体系；4) 管理伏笔与回收计划。输出结构清晰、可直接执行，善用列表与编号。'
    },
    {
        key: 'dante',
        name: 'Dante',
        role: '写手',
        icon: '✍️',
        color: '#f59e0b',
        tagline: '章节写作、片段扩写、气氛渲染',
        systemPrompt: '你是 Dante，才华横溢的小说写手。你的职责是：1) 将大纲展开为具体章节正文；2) 保持人物性格、视角一致；3) 善用五感描写与节奏控制；4) 关注爽点密度与阅读体验。直接输出正文，不要解释写作过程。'
    },
    {
        key: 'virgil',
        name: 'Virgil',
        role: '审稿人',
        icon: '🔍',
        color: '#ef4444',
        tagline: '逻辑审查、文风诊断、修改建议',
        systemPrompt: '你是 Virgil，严苛的小说审稿人。你的职责是：1) 检查情节逻辑与设定一致性；2) 找出文风、节奏、描写问题；3) 诊断爽点与小高潮分布；4) 给出可操作的分条修改建议。先给总体评价，再列具体问题，最后给出修改方案。'
    }
];

const agentSession = {
    currentAgent: 'goethe',
    novelId: null,
    messages: [],           // 跨Agent传递的上下文栈 [{agent, role, content}]
    history: [],            // 页面执行历史 [{agent, input, output, time}]

    async load(novelId) {
        this.novelId = novelId;
        this.currentAgent = 'goethe';
        this.messages = [];
        this.history = [];
        try {
            const saved = await db.get('settings', `agent_${novelId}`);
            // 兼容两种写法：早期存的是 {key, v}，统一后是 {key, value}
            const data = saved ? (saved.value || saved.v) : null;
            if (data) {
                this.messages = data.messages || [];
                this.history = data.history || [];
            }
        } catch (_) {}
    },

    async save() {
        if (!this.novelId) return;
        try {
            const payload = { messages: this.messages.slice(-30), history: this.history.slice(-20) };
            // 统一到 settings 的 {key, value} 约定。之前这里只写 {key, v}，
            // 而 settings.get/set 及备份逻辑认的是 value，两边对不上——
            // 表现就是「Agent 会话在备份/恢复后消失」，但其实是根本读不到。
            // v 保留一份，老版本代码回退时还能读。
            await db.put('settings', { key: `agent_${this.novelId}`, value: payload, v: payload });
        } catch (_) {}
    },

    def() { return AGENT_DEFS.find(a => a.key === this.currentAgent) || AGENT_DEFS[0]; },

    // 上下文传递：把当前Agent的最后输出作为context注入下一个Agent
    getContextFor(agentKey) {
        const contextParts = [];
        for (const m of this.messages) {
            const def = AGENT_DEFS.find(a => a.key === m.agent);
            contextParts.push(`【${def ? def.name + '·' + def.role : m.agent} 的输出】\n${m.content}`);
        }
        return contextParts.length > 0 ? contextParts.join('\n\n') : '';
    },

    // 切换读者视角
    switchTo(agentKey) {
        this.currentAgent = agentKey;
    }
};

async function renderAgentStudio(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    await agentSession.load(novelId);
    store.currentNovel = novel;
    ui.setPageTitle('🎭 多Agent协作');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
    `);

    const tabsHtml = AGENT_DEFS.map((a, i) => `
        <div class="agent-tab${i === 0 ? ' active' : ''}" data-agent="${a.key}" onclick="agentSwitchTab('${a.key}')" style="border-top-color: ${a.color}">
            <div class="agent-tab-icon">${a.icon}</div>
            <div class="agent-tab-name">${a.name}</div>
            <div class="agent-tab-role">${a.role}</div>
        </div>`).join('');

    container.innerHTML = `
        <div class="agent-studio">
            <div class="agent-tabs">${tabsHtml}</div>

            <div class="agent-panel" id="agent-panel">
                <div class="agent-panel-head">
                    <div class="agent-panel-icon" id="agent-panel-icon">🗺️</div>
                    <div class="agent-panel-info">
                        <div class="agent-panel-title" id="agent-panel-title">Goethe 规划师</div>
                        <div class="agent-panel-tagline" id="agent-panel-tagline">设计大纲、情节推演、世界构建</div>
                    </div>
                </div>
                <div class="agent-panel-prompt" id="agent-panel-prompt"></div>
            </div>

            <div class="agent-workbox">
                <div class="agent-workbox-label">📥 输入（任务指令 / 待审文本，可用「传递上下文」带入上游输出）</div>
                <textarea id="agent-input" class="agent-input" placeholder="例如：为第3章设计一个强冲突的登场场景，埋下伏笔…">${escapeHtml(agentSession.getContextFor(agentSession.currentAgent))}</textarea>
                <div class="agent-workbox-actions">
                    <button class="btn btn-secondary btn-sm" onclick="agentLoadContext()">🔗 传递上游上下文</button>
                    <button class="btn btn-sm" onclick="agentInsertOutline()">📋 插入大纲</button>
                    <button class="btn btn-primary" onclick="agentRun()" style="margin-left:auto;">▶ 执行</button>
                </div>
            </div>

            <div class="agent-output" id="agent-output">
                <div class="agent-output-empty">选择角色并输入任务后点击「执行」，各 Agent 的产出会按顺序汇成协作流水线。</div>
            </div>

            <div class="agent-history" id="agent-history"></div>
        </div>`;

    agentRefreshTabs();
    agentRenderHistory();
}

function agentRefreshTabs() {
    document.querySelectorAll('.agent-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.agent === agentSession.currentAgent);
    });
    const def = agentSession.def();
    if (!def) return;
    document.getElementById('agent-panel-icon').textContent = def.icon;
    document.getElementById('agent-panel-title').textContent = `${def.name} · ${def.role}`;
    document.getElementById('agent-panel-tagline').textContent = def.tagline;
    document.getElementById('agent-panel-prompt').textContent = def.systemPrompt;
    const input = document.getElementById('agent-input');
    if (input && input.value.trim() === '') {
        input.value = agentSession.getContextFor(def.key);
        const ctxLen = agentSession.messages.length;
        input.placeholder = ctxLen > 0
            ? '已带入上游上下文，可继续输入任务指令…'
            : '例如：为第3章设计一个强冲突的登场场景，埋下伏笔…';
    }
}

function agentSwitchTab(agentKey) {
    agentSession.switchTo(agentKey);
    agentRefreshTabs();
}

// 把上游各Agent的输出组织为上下文注入当前输入
function agentLoadContext() {
    const context = agentSession.getContextFor(agentSession.currentAgent);
    const input = document.getElementById('agent-input');
    if (context) {
        input.value = context + '\n\n';
        input.focus();
        ui.showToast('已带入上游上下文');
    } else {
        ui.showToast('暂无上游上下文，先让上一个Agent产出');
    }
}

// 把当前小说的大纲摘要插入输入框
async function agentInsertOutline() {
    const novel = store.currentNovel;
    if (!novel) return;
    let outlineText = '';
    if (Array.isArray(novel.outline)) {
        outlineText = novel.outline.map((o, i) => `第${o.chapter}章 ${o.title}: ${o.summary || ''}`).join('\n');
    }
    if (!outlineText) {
        const chapters = await novelManager.listChapters(novel.id);
        outlineText = chapters.map(c => `第${c.number}章 ${c.title} (${c.wordCount || 0}字)`).join('\n');
    }
    const input = document.getElementById('agent-input');
    input.value = (input.value ? input.value + '\n\n' : '') + `【当前作品大纲】\n${outlineText}`;
    ui.showToast('已插入大纲');
}

// 执行当前Agent任务
async function agentRun() {
    const def = agentSession.def();
    const input = document.getElementById('agent-input');
    const userText = (input.value || '').trim();
    if (!userText) { ui.showToast('请输入任务内容'); return; }

    const outputBox = document.getElementById('agent-output');
    outputBox.innerHTML = `<div class="agent-output-loading"><div class="spinner"></div><div>${def.icon} ${escapeHtml(def.name)} 正在思考…</div></div>`;
    try {
        const messages = [{ role: 'system', content: def.systemPrompt }];
        const ctx = agentSession.getContextFor(def.key);
        if (ctx) messages.push({ role: 'user', content: `【协作上下文（上游Agent产出，供参考）】\n${ctx}` });
        messages.push({ role: 'user', content: userText });

        const result = await ai.chat(messages, null, 4000);
        const time = new Date();
        agentSession.messages.push({ agent: def.key, content: result, time: time.getTime() });
        agentSession.history.push({ agent: def.key, input: userText, output: result, time: time.toLocaleTimeString() });
        await agentSession.save();

        outputBox.innerHTML = `
            <div class="agent-output-head" style="border-left-color:${def.color}">
                <span>${def.icon} ${def.name} · ${def.role} 产出</span>
                <button class="btn btn-sm" onclick="agentCopyOutput(this)">复制</button>
            </div>
            <div class="agent-output-body">${escapeHtml(result)}</div>
            <div class="agent-output-actions">
                <button class="btn btn-secondary btn-sm" onclick="agentPassNext()">🔗 传递给 ${agentSessionNextName(def.key)}</button>
                <button class="btn btn-outline btn-sm" onclick="agentRetry()">🔄 重新执行</button>
            </div>`;
        agentRenderHistory();
    } catch (e) {
        outputBox.innerHTML = `<div class="agent-output-error">❌ ${escapeHtml(e.message)}</div>`;
    }
}

function agentSessionNextName(currentKey) {
    const idx = AGENT_DEFS.findIndex(a => a.key === currentKey);
    const next = AGENT_DEFS[(idx + 1) % AGENT_DEFS.length];
    return next ? `${next.icon} ${next.name}` : '';
}

function agentCopyOutput(btn) {
    const body = btn.closest('.agent-output')?.querySelector('.agent-output-body');
    if (!body) return;
    navigator.clipboard?.writeText(body.textContent || '').then(
        () => ui.showToast('已复制'),
        () => ui.showToast('复制失败，请长按选择复制')
    );
}

// 把当前输出作为下一个Agent的输入并切换角色
function agentPassNext() {
    const outputBox = document.getElementById('agent-output');
    const body = outputBox.querySelector('.agent-output-body');
    if (!body) { ui.showToast('还没有可传递的输出'); return; }
    const idx = AGENT_DEFS.findIndex(a => a.key === agentSession.currentAgent);
    const next = AGENT_DEFS[(idx + 1) % AGENT_DEFS.length];
    agentSession.switchTo(next.key);
    const input = document.getElementById('agent-input');
    input.value = `请基于上面的上下文，${agentTaskHint(next.key)}\n\n${body.textContent}`;
    agentRefreshTabs();
    ui.showToast(`已切换到 ${next.name}，上下文已带入`);
}

function agentTaskHint(key) {
    return {
        goethe: '为这段内容规划扩展方向并给出大纲建议',
        dante: '将上述内容扩写为生动的正文',
        virgil: '审查上述内容并给出修改意见'
    }[key] || '继续处理';
}

function agentRetry() {
    const input = document.getElementById('agent-input');
    if (!input) return;
    agentRun();
}

// 渲染协作流水线历史
function agentRenderHistory() {
    const box = document.getElementById('agent-history');
    if (!box) return;
    const h = agentSession.history;
    if (h.length === 0) { box.innerHTML = ''; return; }
    box.innerHTML = `
        <div class="agent-history-title">🗂 协作流水线（${h.length}步）</div>
        ${h.map((item, i) => {
            const def = AGENT_DEFS.find(a => a.key === item.agent) || AGENT_DEFS[0];
            return `<div class="agent-history-item" onclick="agentExpandHistory(${i})">
                <div class="agent-history-step">${i + 1}</div>
                <div class="agent-history-info">
                    <div class="agent-history-name">${def.icon} ${def.name} · ${def.role}</div>
                    <div class="agent-history-summary">${escapeHtml((item.input || '').substring(0, 60))}</div>
                </div>
                <div class="agent-history-time">${item.time || ''}</div>
            </div>`;
        }).join('')}`;
}

function agentExpandHistory(i) {
    const item = agentSession.history[i];
    if (!item) return;
    const def = AGENT_DEFS.find(a => a.key === item.agent) || AGENT_DEFS[0];
    createModal(`${def.icon} ${def.name} 第${i + 1}步产出`, `
        <div class="agent-history-modal">
            <div class="agent-history-modal-label">输入</div>
            <pre class="agent-history-modal-text">${escapeHtml(item.input)}</pre>
            <div class="agent-history-modal-label">产出</div>
            <pre class="agent-history-modal-text">${escapeHtml(item.output)}</pre>
            <div class="agent-history-modal-actions">
                <button class="btn btn-primary btn-block" onclick="agentCopyString(this, ${i})">复制产出</button>
            </div>
        </div>`);
}

function agentCopyString(btn, i) {
    const item = agentSession.history[i];
    navigator.clipboard?.writeText(item ? item.output : '').then(
        () => ui.showToast('已复制'),
        () => ui.showToast('复制失败')
    );
}

// 重置当前作品的Agent会话
async function agentResetSession() {
    if (!agentSession.novelId) return;
    agentSession.messages = [];
    agentSession.history = [];
    await agentSession.save();
    const input = document.getElementById('agent-input');
    if (input) input.value = '';
    agentRenderHistory();
    ui.showToast('协作会话已重置');
}

// ===== 长程一致性检查 (v2.7.0) =====
const CONSISTENCY_STOPWORDS = new Set([
    '一个','我们','你们','他们','她们','那个','这个','自己','没有','可以','已经','知道','但是','因为','所以','如果','然后','还是','就是','什么','怎么','不要','起来','下来','出来','过去','时候','现在','刚才','大家','一下','一点','那些','这些','非常','十分','这样','那样','仿佛','似乎','好像','突然','终于','立刻','马上','慢慢','渐渐'
]);

function consistencyExtractEntities(text, knownNames) {
    const counts = {};
    const chapterCounts = {}; // name -> {count, chapters:Set}
    // 1) 已知角色名直接统计
    for (const name of (knownNames || [])) {
        if (!name || name.length < 2) continue;
        const re = new RegExp(escapeRegExp(name), 'g');
        const m = text.match(re);
        if (m) {
            counts[name] = (counts[name] || 0) + m.length;
            chapterCounts[name] = chapterCounts[name] || { count: 0, chapters: new Set() };
        }
    }
    // 2) 扫描 2-4 字中文词频（粗略实体发现：连续中文片段滑窗）
    const cnRun = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    const freq = {};
    for (const w of cnRun) {
        if (CONSISTENCY_STOPWORDS.has(w)) continue;
        freq[w] = (freq[w] || 0) + 1;
    }
    return { counts, chapterCounts, freq };
}

async function consistencyScanBook(novelId) {
    const novel = await novelManager.get(novelId);
    const chapters = await novelManager.listChapters(novelId);
    // 角色卡与世界观名作为已知实体
    const characters = await db.getAll('characters', 'novelId', novelId);
    const worlditems = await db.getAll('worldbuilding', 'novelId', novelId);
    const knownNames = [
        ...(characters || []).map(c => c.name).filter(Boolean),
        ...((novel && Array.isArray(novel.characters)) ? novel.characters.map(c => c.name || c.charName || '') : []),
        ...(worlditems || []).map(w => w.title).filter(Boolean)
    ];

    const index = {}; // name -> { total, perChapter: {chNum: count} }
    for (const ch of chapters) {
        const text = ch.content || '';
        const { counts } = consistencyExtractEntities(text, knownNames);
        for (const [name, count] of Object.entries(counts)) {
            if (!index[name]) index[name] = { total: 0, perChapter: {} };
            index[name].total += count;
            index[name].perChapter[ch.number] = (index[name].perChapter[ch.number] || 0) + count;
        }
        // 高频候选：出现 >= 3 次的 2-4 字词（去已知实体去重）
        const freq = (text.match(/[\u4e00-\u9fa5]{2,4}/g) || []).filter(w => !CONSISTENCY_STOPWORDS.has(w));
        const freqMap = {};
        for (const w of freq) freqMap[w] = (freqMap[w] || 0) + 1;
        for (const [name, count] of Object.entries(freqMap)) {
            if (count < 3 || index[name]) continue;
            if (/的|了|着|过|地|得|在|是|有|和|与|及|或|把|被|让|叫|说|道|问|看|听/.test(name)) continue;
            if (!index[name]) index[name] = { total: 0, perChapter: {} };
            index[name].total += count;
            index[name].perChapter[ch.number] = (index[name].perChapter[ch.number] || 0) + count;
        }
    }
    return { index, chapterCount: chapters.length };
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function renderConsistencyCheck(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    store.currentNovel = novel;
    ui.setPageTitle('🔍 长程一致性检查');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
    `);
    ui.showLoading(container);
    try {
        const { index, chapterCount } = await consistencyScanBook(novelId);
        const entities = Object.entries(index).sort((a, b) => b[1].total - a[1].total);
        const knownEntities = entities.filter(([name]) => {
            return name.length >= 2;
        });

        container.innerHTML = `
            <div class="consistency-wrap">
                <div class="consistency-stats">
                    <div class="consistency-stat"><div class="consistency-stat-num">${chapterCount}</div><div class="consistency-stat-label">章节</div></div>
                    <div class="consistency-stat"><div class="consistency-stat-num">${entities.length}</div><div class="consistency-stat-label">检测实体</div></div>
                    <div class="consistency-stat"><div class="consistency-stat-num">${entities.reduce((s, [, v]) => s + v.total, 0)}</div><div class="consistency-stat-label">总出现</div></div>
                </div>

                <div class="consistency-actions">
                    <button class="btn btn-primary btn-block" onclick="consistencyRunAI('${novelId}')">🤖 AI 矛盾检测</button>
                    <div class="consistency-hint">AI 将扫描全书，找出：角色名变体（同一人多种写法）、时间线矛盾、设定冲突</div>
                </div>

                <div id="consistency-ai-result"></div>

                <div class="consistency-section-title">📑 批量替换（角色改名 / 修正错字）</div>
                <div class="consistency-replace">
                    <input id="consistency-old" class="consistency-input" placeholder="原文本（如：李逍遥）">
                    <input id="consistency-new" class="consistency-input" placeholder="替换为（如：李寒霄）">
                    <button class="btn btn-primary" onclick="consistencyReplacePreview('${novelId}')">预览</button>
                </div>
                <div id="consistency-replace-result"></div>

                <div class="consistency-section-title">🗂 实体索引表（点击展开出现章节）</div>
                <div id="consistency-entity-list"></div>
            </div>`;

        const listBox = document.getElementById('consistency-entity-list');
        if (knownEntities.length === 0) {
            listBox.innerHTML = '<div class="consistency-empty">全书暂无可索引实体，先写几章正文再回来检查</div>';
        } else {
            listBox.innerHTML = knownEntities.slice(0, 80).map(([name, v]) => {
                const chapters = Object.entries(v.perChapter).sort((a, b) => a[0] - b[0]);
                return `
                    <div class="consistency-entity" onclick="consistencyToggleEntity(this)">
                        <div class="consistency-entity-name">${escapeHtml(name)}</div>
                        <div class="consistency-entity-count">${v.total}次 · ${chapters.length}章</div>
                        <div class="consistency-entity-chips">${chapters.slice(0, 12).map(([ch, c]) => `<span class="consistency-entity-chip">${ch}章×${c}</span>`).join('')}${chapters.length > 12 ? `<span class="consistency-entity-chip">…${chapters.length - 12}章</span>` : ''}</div>
                        <div class="consistency-entity-expand" style="display:none;">${_consistencyExpandChapters(v.perChapter)}</div>
                    </div>`;
            }).join('');
        }
    } catch (err) {
        ui.showEmptyState(container, { icon: '⚠️', title: '扫描失败', desc: err.message });
    }
}

function consistencyToggleEntity(el) {
    const expand = el.querySelector('.consistency-entity-expand');
    if (!expand) return;
    expand.style.display = expand.style.display === 'none' ? 'block' : 'none';
}

function _consistencyExpandChapters(perChapter) {
    return Object.entries(perChapter)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([ch, c]) => `第${ch}章出现 ${c} 次`)
        .join('<br>');
}

async function consistencyRunAI(novelId) {
    const chapters = await novelManager.listChapters(novelId);
    if (chapters.length === 0) { ui.showToast('暂无章节'); return; }
    const box = document.getElementById('consistency-ai-result');
    box.innerHTML = '<div class="consistency-loading"><div class="spinner"></div><div>AI 正在扫描全书矛盾…</div></div>';
    try {
        // 取样：每章前 1200 字，最多 20 章
        const sampled = chapters.slice(0, 20).map(ch =>
            `【第${ch.number}章 ${ch.title || ''}】\n${(ch.content || '').substring(0, 1200)}`
        ).join('\n\n');
        const result = await ai.chat([
            { role: 'system', content: '你是资深小说编辑与事实核查员。阅读全书节选，找出：1) 角色名变体（同一角色出现不同名字/昵称误用）；2) 时间线矛盾（事件先后、年龄、天数不符）；3) 设定冲突（力量体系、世界观规则、称呼关系矛盾）。严格输出JSON，不要markdown代码块，格式：{"variants":[{"canonical":"规范名","aliases":["别名1"],"evidence":"出现在第几章"}],"timeline":[{"desc":"矛盾描述","chapter":"第几章"}],"setting":[{"desc":"设定冲突","chapter":"第几章"}]}' },
            { role: 'user', content: `请分析以下小说节选：\n${sampled}` }
        ], null, 3000);
        // 解析 JSON
        let report = null;
        try {
            const cleaned = result.replace(/\`\`\`json?\s*/g, '').replace(/\`\`\`\s*/g, '').trim();
            report = JSON.parse(cleaned);
        } catch (_) {
            const m = result.match(/\{[\s\S]*\}/);
            if (m) { try { report = JSON.parse(m[0]); } catch (_) {} }
        }
        if (!report) { box.innerHTML = '<div class="consistency-error">⚠️ AI 返回无法解析，请重试</div>'; return; }
        const variants = report.variants || [];
        const timeline = report.timeline || [];
        const setting = report.setting || [];
        const totalIssues = variants.length + timeline.length + setting.length;
        box.innerHTML = `
            <div class="consistency-ai-head">AI 检测结果：发现 ${totalIssues} 处潜在问题</div>
            ${variants.length > 0 ? `
                <div class="consistency-ai-section">
                    <div class="consistency-ai-title">🔤 角色名变体（${variants.length}）</div>
                    ${variants.map(v => `
                        <div class="consistency-issue-card">
                            <div class="consistency-issue-main">规范名：<b>${escapeHtml(v.canonical || '?')}</b> · 别名：${(v.aliases || []).map(a => `<span class="consistency-alias">${escapeHtml(a)}</span>`).join(' ')}</div>
                            ${v.evidence ? `<div class="consistency-issue-evidence">${escapeHtml(v.evidence)}</div>` : ''}
                            <div class="consistency-issue-actions">
                                <button class="btn btn-sm btn-primary" onclick="consistencyQuickReplace('${novelId}', '${escapeHtml((v.aliases || [])[0] || '')}', '${escapeHtml(v.canonical || '')}')">统一为规范名</button>
                            </div>
                        </div>`).join('')}
                </div>` : ''}
            ${timeline.length > 0 ? `
                <div class="consistency-ai-section">
                    <div class="consistency-ai-title">⏱ 时间线矛盾（${timeline.length}）</div>
                    ${timeline.map(t => `<div class="consistency-issue-card"><div class="consistency-issue-main">${escapeHtml(t.desc || '')}</div>${t.chapter ? `<div class="consistency-issue-evidence">${escapeHtml(t.chapter)}</div>` : ''}</div>`).join('')}
                </div>` : ''}
            ${setting.length > 0 ? `
                <div class="consistency-ai-section">
                    <div class="consistency-ai-title">🌍 设定冲突（${setting.length}）</div>
                    ${setting.map(t => `<div class="consistency-issue-card"><div class="consistency-issue-main">${escapeHtml(t.desc || '')}</div>${t.chapter ? `<div class="consistency-issue-evidence">${escapeHtml(t.chapter)}</div>` : ''}</div>`).join('')}
                </div>` : ''}
            ${totalIssues === 0 ? '<div class="consistency-clean">✅ 未发现明显矛盾（基于节选）</div>' : ''}
        `;
    } catch (e) {
        box.innerHTML = `<div class="consistency-error">❌ ${escapeHtml(e.message)}</div>`;
    }
}

function consistencyQuickReplace(novelId, oldText, newText) {
    if (!oldText || !newText || oldText === newText) { ui.showToast('无效替换'); return; }
    // 填充并立即预览
    const oldInput = document.getElementById('consistency-old');
    const newInput = document.getElementById('consistency-new');
    if (oldInput) oldInput.value = oldText;
    if (newInput) newInput.value = newText;
    consistencyReplacePreview(novelId);
}

async function consistencyReplacePreview(novelId) {
    const oldText = document.getElementById('consistency-old')?.value.trim();
    const newText = document.getElementById('consistency-new')?.value.trim();
    const box = document.getElementById('consistency-replace-result');
    if (!oldText || !newText) { box.innerHTML = ''; ui.showToast('请输入替换内容'); return; }
    if (oldText === newText) { box.innerHTML = '<div class="consistency-error">原文本与替换内容相同</div>'; return; }
    try {
        const chapters = await novelManager.listChapters(novelId);
        let affected = 0, totalOccur = 0;
        const previews = [];
        for (const ch of chapters) {
            const content = ch.content || '';
            const re = new RegExp(escapeRegExp(oldText), 'g');
            const matches = content.match(re);
            if (matches && matches.length > 0) {
                affected++;
                totalOccur += matches.length;
                const idx = content.indexOf(oldText);
                const snippet = content.substring(Math.max(0, idx - 15), idx + oldText.length + 15);
                previews.push(`第${ch.number}章：…${escapeHtml(snippet)}…`);
            }
        }
        if (affected === 0) { box.innerHTML = '<div class="consistency-error">未找到匹配内容</div>'; return; }
        box.innerHTML = `
            <div class="consistency-replace-preview">
                <div class="consistency-replace-info">将替换 <b>${totalOccur}</b> 处，影响 <b>${affected}</b> 章</div>
                <div class="consistency-replace-snippets">${previews.slice(0, 8).join('<br>')}${previews.length > 8 ? `<br>…共${previews.length}处示例` : ''}</div>
                <button class="btn btn-danger" onclick="consistencyReplaceExecute('${novelId}', '${escapeHtml(oldText)}', '${escapeHtml(newText)}', ${affected})">⚠️ 确认替换全部 ${totalOccur} 处</button>
            </div>`;
    } catch (e) {
        box.innerHTML = `<div class="consistency-error">❌ ${escapeHtml(e.message)}</div>`;
    }
}

async function consistencyReplaceExecute(novelId, oldText, newText, affected) {
    if (!confirm(`确认将「${oldText}」替换为「${newText}」？将影响 ${affected} 个章节，此操作不可撤销。`)) return;
    try {
        const chapters = await novelManager.listChapters(novelId);
        let done = 0;
        for (const ch of chapters) {
            if ((ch.content || '').includes(oldText)) {
                const newContent = ch.content.split(oldText).join(newText);
                await novelManager.saveChapter(novelId, ch.number, ch.title, newContent, ch.paragraphs);
                done++;
            }
        }
        const box = document.getElementById('consistency-replace-result');
        box.innerHTML = `<div class="consistency-clean">✅ 替换完成：${done} 个章节已更新</div>`;
        ui.showToast(`已替换 ${done} 章`);
        document.getElementById('consistency-old').value = '';
        document.getElementById('consistency-new').value = '';
        // 刷新实体列表
        setTimeout(() => location.reload(), 1200);
    } catch (e) {
        ui.showToast('替换失败: ' + e.message);
    }
}
