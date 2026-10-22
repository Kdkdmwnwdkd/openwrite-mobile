/**
 * OpenWrite Mobile - Pure Frontend Architecture
 * All logic runs in the browser/webkit. No backend server required.
 * Data stored in IndexedDB. AI calls go directly to provider APIs.
 */

// ===== Configuration =====
const CONFIG = {
    VERSION: '2.26.0',   // 与 package.json 保持一致
    APP_NAME: 'OpenWrite',
    DB_NAME: 'OpenWriteDB',
    DB_VERSION: 8
};

// 供应商展示名。只影响界面文字，请求实际发往哪里完全由 baseUrl + model 决定，
// 不要拿它做路由——同一个模型名可以挂在任何 OpenAI 兼容网关下（OpenRouter 等）。
// 以前这段映射在设置页和保存逻辑里各写了一遍，改一处漏一处。
const PROVIDER_MAP = { glm: '智谱', deepseek: 'DeepSeek', gpt: 'OpenAI', claude: 'Anthropic' };
function detectProvider(model) {
    if (!model) return 'custom';
    const m = String(model).toLowerCase();
    for (const [prefix, name] of Object.entries(PROVIDER_MAP)) {
        if (m.startsWith(prefix)) return name;
    }
    return 'custom';
}

// novels 的写入串行化。
// saveChapter 和 recountNovelStats 都是「读整条 → 改 → 写回」，两章并发保存时
// 后写的那次会用旧快照覆盖前一次的字数增量；recount 与 saveChapter 交错时同理。
// 这里把所有 novels 写入排成队列，队列内重新读一次再改。
let __novelWriteChain = Promise.resolve();
function withNovelLock(fn) {
    const run = __novelWriteChain.then(fn, fn);
    __novelWriteChain = run.catch(() => {});
    return run;
}

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
            // 另一个标签页还占着旧版本的连接时，open 会一直 blocked：
            // 既不 resolve 也不 reject，_openPromise 永久 pending，全站 db 调用静默挂死。
            request.onblocked = () => {
                this._openPromise = null;
                reject(new Error('数据库正被其他页面占用，请关掉其它标签页后重试'));
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

    // 必须等 tx.oncomplete 才算写完。
    // req.onsuccess 只代表"请求被接受"，配额超限/事务中止发生在提交阶段，
    // 那时候已经 resolve 了，编辑器会显示"已自动保存"，重开却发现内容没了。
    async put(store, value) {
        if (!value || typeof value !== 'object') throw new Error('写入数据不合法');
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            let result;
            const req = os.put(value);
            req.onsuccess = () => { result = req.result; };
            req.onerror = () => reject(req.error);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('写入被中止'));
        });
    },

    async delete(store, key) {
        if (key === undefined || key === null || key === '') return;
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            os.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('删除被中止'));
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
    // 旧写法取的是 b.title || b.content || b，而节拍对象的字段叫 desc ——
    // 结果每一条都变成 "[object Object]" 喂给模型，等于这个功能一直没生效。
    try {
        const beats = await novelManager.getBeats(novelId, chapterNum);
        // 默认新建的 4 个空节拍没有内容，不注入，否则 prompt 里全是空行
        const usable = (beats || []).filter(b => b && (b.desc || b.content || b.title));
        if (usable.length) {
            parts.push('【本章节拍（按顺序推进，括号内是篇幅占比）】\n' + usable.map((b, i) => {
                const label = b.label || '';
                const text = b.desc || b.content || b.title || '';
                const pct = Number(b.pct) > 0 ? '（约' + b.pct + '%）' : '';
                return (i + 1) + '. ' + (label ? label + '：' : '') + text + pct;
            }).join('\n'));
            stats.beats = usable.length;
        }
    } catch (e) { /* 忽略 */ }

    // 3) 伏笔债务：优先提醒已逾期的
    try {
        const fsList = await novelManager.listForeshadowing(novelId);
        // 只列「已到期」的伏笔当债务。未到期的一律不在这里催 ——
        // 一边说"本章应回收"、一边在禁区里说"不得提前揭晓"，模型会两头为难，
        // 最后往往是"含糊提一句"这种最差解。
        // 只认明确处于「已埋设」状态的。旧数据里出现过别的状态值（如 revealed），
        // 按「非 harvested 即未回收」处理会把它当成欠账，天天催一件早就讲完的事。
        const pending = fsList.filter(f =>
            (f.status || 'planted') === 'planted' &&
            (Number(f.targetChapter) || 1) <= chapterNum
        );
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

// 取消/超时必须带上 name='AbortError'：调用方（AI 写作的「停止并保存已写部分」）
// 就是靠 err.name 判断该不该保留已生成的部分。只 new Error('已取消') 会被当成
// 普通失败，用户点了停止反而一个字都不保存。
function abortError(msg) {
    const e = new Error(msg);
    e.name = 'AbortError';
    return e;
}

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

        // 超时 + 重试。
        // 超时用「空闲超时」：每收到一段数据就重置计时，长章节慢慢吐字不会被误杀。
        // 重试只覆盖「还没开始读流」的阶段（网络抖动 / 5xx），此时重发不会重复输出；
        // 429 是限流/计费语义，重试只会更糟；流式一旦开始读就不能重试，否则正文会重复。
        const MAX_ATTEMPTS = 2;
        let ctrl = null;
        let watchdog = null;
        const armWatchdog = () => {
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, AI_IDLE_TIMEOUT);
        };
        const stopWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };

        let response = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            ctrl = new AbortController();
            if (signal) {
                if (signal.aborted) ctrl.abort();
                else signal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} }, { once: true });
            }
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
                stopWatchdog();
                // 外部取消优先报「已取消」，别把用户主动停止说成超时
                if (signal && signal.aborted) throw abortError('已取消');
                if (ctrl.signal.aborted) throw abortError(`请求超时（${AI_IDLE_TIMEOUT / 1000} 秒无响应），请检查网络或 Base URL`);
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise(r => setTimeout(r, 700));
                    continue;
                }
                throw new Error('网络请求失败：' + (e && e.message ? e.message : '未知错误'));
            }
            // 5xx 是服务端临时故障，重发一次通常就好；429 / 4xx 不重试
            if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
                stopWatchdog();
                try { if (response.body) await response.body.cancel(); } catch (_) {}
                await new Promise(r => setTimeout(r, 800));
                continue;
            }
            break;
        }
        // 非流式到这里响应已完整，不用再等
        if (!onStream) stopWatchdog();

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
                if (signal && signal.aborted) throw abortError('已取消');
                if (ctrl.signal.aborted) throw abortError(`生成超时（${AI_IDLE_TIMEOUT / 1000} 秒没有新数据），已中断`);
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

    // 本章禁区。只从「尚未回收、且计划更晚揭晓」的伏笔里取 —— 这是模型最容易写崩的地方：
    // 为了推进剧情，它会顺手把后面几章才该翻的底牌提前翻出来。
    // 没有这类数据时不硬编，宁可留空也不要写一堆"注意保持文风"的空话。
    async buildForbiddenZones(novelId, chapterNum) {
        const out = [];
        try {
            const fs = await novelManager.listForeshadowing(novelId);
            for (const f of (fs || [])) {
                if (!f || (f.status || 'planted') !== 'planted') continue;
                const target = Number(f.targetChapter) || 0;
                if (target > chapterNum && f.description) {
                    out.push(`伏笔「${String(f.description).slice(0, 40)}」计划第 ${target} 章才揭晓，本章不得点破、不得给出答案`);
                }
                if (out.length >= 5) break;
            }
        } catch (_) { /* 读不到就不加禁区，不影响写作 */ }
        return out;
    },

    async continueChapter(novelInfo, previousChapters, chapterNum, prompt, onStream = null, signal = null) {
        // v2.8.0：改用分层上下文（上一章全文 + 旧章摘要 + 按命中注入的设定 + 伏笔债务）
        // 旧实现把每一章都截取前 500 字拼进去，长篇时既丢失衔接又浪费 token。
        const layered = await buildLayeredContext(novelInfo.id, chapterNum, prompt || '');
        const forbidden = await this.buildForbiddenZones(novelInfo.id, chapterNum);

        const userPrompt = `请为小说《${novelInfo.title}》生成第${chapterNum}章。

类型：${novelInfo.genre || '未指定'}
简介：${novelInfo.description || '暂无'}

${layered.text ? '===== 故事上下文（必须遵守，不得出现与之一致性冲突的内容）=====\n' + layered.text + '\n===== 上下文结束 =====\n' : ''}
${forbidden.length ? '===== 本章禁止（违反即视为不合格）=====\n' + forbidden.map(z => '- ' + z).join('\n') + '\n\n' : ''}写作要求：
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

    // 审稿：返回结构化问题清单，而不是「打个分 + 一段点评」。
    // 打分最容易变成空话（"文笔流畅，建议加强细节"），改成一个可执行的约定：
    // 每条问题必须带原文引用（quote），能定位到具体段落，否则模型写不出东西来。
    async reviewChapter(chapterContent, novelInfo, chapterNum) {
        const charContext = chapterNum ? await buildCharacterContext(novelInfo.id, chapterNum) : '';
        const wbContext = chapterNum ? await buildWorldbuildingContext(novelInfo.id) : '';
        const prompt = `请审这部小说的第${chapterNum || 1}章。

小说：${novelInfo.title}
${charContext ? '\n角色设定（用于判断是否 OOC）：\n' + charContext + '\n' : ''}
${wbContext ? '\n世界观设定（用于判断是否违反规则）：\n' + wbContext + '\n' : ''}
【正文】
${chapterContent}
【正文结束】

【你的任务】
找出问题，不是验证正确性。没发现问题时才输出空数组，不要为了凑数硬编。

【必查清单】逐项过一遍，有问题才报
1. 梗概感：把「决定—行动—成功」挤在一段里，没有现场动作和阻碍。正常应是 触发→尝试→阻碍→再尝试→代价。
2. 情绪标签：直接写「他感到愤怒」「她心里一阵悲凉」。应换成身体动作或环境反应。
3. 对白汇报腔：人物说出双方都知道的信息、每句都完整礼貌、像在接受采访。真实对话会有打断、回避、答非所问。
4. 冲突无代价：主角一次就成功、失败不改变任何东西、赢了也没带来新麻烦。
5. 章末钩子：只写「真正的危机才刚开始」这类空泛预告。有效钩子是给新信息、反常物件、更坏的选择、称呼变化。
6. 话疗：在战斗或决战场景里，靠讲道理说服/感化敌人解决问题，且没有对应的武力代价。

【硬性要求】
1. 每条必须给 quote：从正文里**原样复制** 10-50 字，能定位到出问题的那一句。复制不出来说明你没读到具体问题，不要写这条。
2. 一致性问题（category 为 consistency / factual / causal）的 fix 只写"事实应该怎么统一"，不要夹带文学创作建议。
3. 禁止输出这类话：文笔流畅、建议加强细节描写、人物形象鲜明、整体不错。

【分级】命中即定级，不要整体打分
- S1：读者会当场出戏／设定硬冲突／逻辑断裂（例如死者复生、时间线倒错）
- S2：明显影响阅读（节奏拖沓、人物行为没有动机、对话像说明书）
- S3：局部可优化（用词重复、场景描写单薄、过渡生硬）
- S4：可选建议

【输出格式】只输出 JSON 数组，前后不要任何解释文字、不要 markdown 代码块：
[{"severity":"S2","category":"character","quote":"原文片段","issue":"问题是什么","fix":"具体怎么改"}]

category 只能取：structure | character | prose | pacing | dialogue | hook | consistency | factual | causal
最多 8 条，按 S1→S4 排序。没问题输出 []。`;

        const raw = await this.chat([
            { role: 'system', content: '你是严格的审稿编辑。你的产出是可执行的修改清单，不是评价。' },
            { role: 'user', content: prompt }
        ], null, 2500);
        return { raw, findings: parseReviewFindings(raw) };
    },

    // 从一章正文里抽取「可结构化的设定」，供写回角色卡 / 世界观 / 伏笔。
    // 关键约束：只提取正文明确写到的，允许输出空数组。模型最擅长的就是"合理补全"，
    // 而设定库里多一条编造的内容，比少一条危害大得多 —— 后面每一章都会带着它写。
    async extractChapterFacts(novel, chapter, chapterNum) {
        const [chars, wbs] = await Promise.all([
            novelManager.listCharacters(novel.id).catch(() => []),
            novelManager.listWorldbuilding(novel.id).catch(() => [])
        ]);
        const charNames = (chars || []).map(c => c.name).filter(Boolean).slice(0, 30).join('、') || '（暂无）';
        const wbTitles = (wbs || []).map(w => w.title).filter(Boolean).slice(0, 30).join('、') || '（暂无）';

        const prompt = `从下面这一章正文里提取「可以写回作者资料库」的结构化设定。

小说：${novel.title}
【现有角色】${charNames}
【现有世界观】${wbTitles}

【第${chapterNum}章 正文】
${chapter.content}
【正文结束】

【输出格式】只输出 JSON，不要解释文字、不要 markdown 代码块：
{
  "summary": "本章 80-120 字摘要，供后续章节当上下文用",
  "characters": [{"name": "角色名", "status": "本章结束时的处境或状态变化，一句话", "confidence": 0.9}],
  "world": [{"title": "设定名", "category": "map|faction|timeline|rule|research|other", "content": "一句话说明", "confidence": 0.8}],
  "foreshadow": [{"description": "本章埋下的伏笔，一句话", "targetChapter": 8, "confidence": 0.8}],
  "harvested": ["本章回收或揭晓了哪个已埋伏笔（写描述里的关键词）"],
  "conflicts": [{"with": "与哪条已有设定冲突", "evidence": "正文里的原句", "confidence": 0.8}]
}

【硬性规则】
1. 只提取正文里明确写到的。没写的不许推测、不许补全，宁可少。
2. 角色只记「状态变化」：受伤、得到物品、位置变化、关系变化、身份暴露。
   性格、外貌、背景这些如果正文没新增信息，不要重复抄一遍。
3. world 只记新出现且值得长期记住的：地名、组织、规则、历史事件。
   同一个概念已在【现有世界观】里就别再提。
4. foreshadow 只记「作者有意埋下、后面要回收」的线索。普通的悬念不算。
5. confidence 按证据强度给：正文明确写出 0.9；需要跨段推断 0.6；拿不准 0.3。
6. 没有内容的字段输出空数组 []，不要为了凑数编造。`;

        const raw = await this.chat([
            { role: 'system', content: '你是资料整理员。你只提取正文里已经写明的信息，拒绝推测和补全。' },
            { role: 'user', content: prompt }
        ], null, 3000);
        return { raw, data: parseExtraction(raw) };
    }
};

// 宽松 JSON 解析。模型常在 JSON 前后加一句"以下是结果"，或包在 ```json 里；
// 而贪婪匹配 [\s\S]* 会吞到最后一个括号 —— 遇到"说明{...}示例{...}"就解析失败，
// 白花一次调用却只显示"提取失败"。这里改成逐步降级 + 平衡扫描。
function parseJsonLoose(text, opener = '{', closer = '}', validate = null) {
    const body = String(text || '').trim();
    if (!body) return null;
    const tryParse = (x) => { try { return JSON.parse(x); } catch (_) { return undefined; } };
    const ok = (v) => (typeof validate === 'function' ? validate(v) : true);

    let r = tryParse(body);
    if (r !== undefined && ok(r)) return r;

    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        r = tryParse(fenced[1].trim());
        if (r !== undefined && ok(r)) return r;
    }

    // 逐个候选扫描：模型常先给一个"示例格式 {...}"再给真正的结果，
    // 只取第一个括号块会咬到示例。这里让调用方传 validate，不合格就继续往后找。
    let pos = 0;
    while (true) {
        const start = body.indexOf(opener, pos);
        if (start === -1) return null;
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let i = start; i < body.length; i++) {
            const ch = body[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === opener) depth++;
            else if (ch === closer) {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }
        if (end === -1) return null;
        const out = tryParse(body.slice(start, end + 1));
        if (out !== undefined && ok(out)) return out;
        pos = end + 1;
    }
}

// 解析审稿输出；解析失败返回 null，由调用方回退成纯文本展示。
function parseReviewFindings(text) {
    const arr = parseJsonLoose(text, '[', ']', (v) => Array.isArray(v));
    if (!Array.isArray(arr)) return null;
    return arr.filter(x => x && (x.issue || x.quote)).map(x => ({
        severity: /^S[1-4]$/.test(String(x.severity)) ? String(x.severity) : 'S3',
        category: String(x.category || 'prose').toLowerCase(),
        quote: String(x.quote || '').slice(0, 200),
        issue: String(x.issue || ''),
        fix: String(x.fix || '')
    })).sort((a, b) => a.severity.localeCompare(b.severity));
}

// 把 quote 对回正文的段落号，方便用户回编辑器里找。
// 模型偶尔会改一两个字，所以按前 20 字做包含匹配，容错但不至于错太远。
function locateQuoteParagraph(content, quote) {
    if (!content || !quote) return 0;
    const paras = String(content).split(/\n+/).filter(x => x.trim());
    const key = String(quote).replace(/\s+/g, '').slice(0, 20);
    if (!key) return 0;
    for (let i = 0; i < paras.length; i++) {
        if (paras[i].replace(/\s+/g, '').includes(key)) return i + 1;
    }
    return 0;
}

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

    // 定位一章：正常情况下主键就是 `${novelId}_ch${number}`，直接取。
    // 但极早期的数据可能用别的 id 规则 —— 那种章节按主键取不到，如果直接新建，
    // 会得到一个「同号影子章节」（列表里出现两条第 5 章），删除也删不掉原来的。
    // 所以这里连真实 id 一起返回，写和删都用它。
    async findChapterKey(novelId, chapterNum) {
        const directId = `${novelId}_ch${chapterNum}`;
        const direct = await db.get('chapters', directId);
        if (direct) return { id: directId, record: direct };
        const chapters = await this.listChapters(novelId);
        const legacy = chapters.find(ch => Number(ch.number) === Number(chapterNum));
        return legacy ? { id: legacy.id, record: legacy } : { id: directId, record: null };
    },

    async getChapter(novelId, chapterNum) {
        if (!novelId) return null;
        const found = await this.findChapterKey(novelId, chapterNum);
        return found.record;
    },

    async saveChapter(novelId, chapterNum, title, content, paragraphs = null, opts = {}) {
        // 用真实记录 id：老数据可能是别的规则，按 `${novelId}_ch${n}` 新建会出影子章节
        const found = await this.findChapterKey(novelId, chapterNum);
        const id = found.id;
        const existing = found.record;
        // 覆盖前自动存档旧版本，AI 写崩或误改后可回滚。
        // 自动保存传 archive:false —— 否则每敲几下就多一份全文快照，很快把配额吃光。
        if (existing && existing.content && existing.content !== content && opts.archive !== false) {
            await this.archiveChapterVersion(existing);
        }
        // 保留原记录的所有字段。旧实现是"挑几个字段重建对象"，结果 volumeId（分卷）、
        // scene（场景卡）、characters 全被丢掉 —— 在编辑器改一个字触发自动保存，
        // 章节就从分卷里掉出去、场景卡也空了。
        const chapter = Object.assign({}, existing || {}, {
            id,
            novelId,
            number: chapterNum,
            title: title || `第${chapterNum}章`,
            content,
            wordCount: content.length,
            // 保留首次创建时间（旧代码每次保存都重写 created）
            created: existing && existing.created ? existing.created : Date.now(),
            updated: Date.now()
        });
        // paragraphs 只在显式传入时覆盖；传 null 表示"保持原样"
        if (paragraphs !== null) {
            chapter.paragraphs = paragraphs;
        }
        await db.put('chapters', chapter);

        // 今日新增字数：自动保存会频繁调用，但每次只累加"比上次多了多少"，
        // 结果就是真实净增量；删字不计入（负数忽略）。
        const prevWords = existing ? (existing.wordCount || 0) : 0;
        const delta = content.length - prevWords;
        if (delta > 0) addTodayWords(delta).catch(() => {});

        // 更新作品统计：这里必须走增量，不能每次重算。
        // 自动保存是 1 秒防抖的高频路径，旧实现每次都 listChapters 全量读 + 整条 novel 重写，
        // 千章长篇上每敲一下就是上千条记录读一次，手机端会明显掉帧。
        // 代价是统计值可能因异常退出而漂移，所以删章/重排/导入这类批量操作后会调
        // recountNovelStats 全量校准一次（见 deleteChapter）。
        await withNovelLock(async () => {
            const fresh = await this.get(novelId);   // 队列内重读，避免用旧快照覆盖
            if (!fresh) return;
            const deltaWords = content.length - prevWords;
            fresh.wordCount = Math.max(0, (fresh.wordCount || 0) + deltaWords);
            if (!existing) fresh.chapterCount = (fresh.chapterCount || 0) + 1;
            fresh.updated = Date.now();
            await db.put('novels', fresh);
        });

        return chapter;
    },

    // 作品统计的真相来源：整本重算。只在批量操作后调用，日常保存走增量。
    async recountNovelStats(novelId) {
        const chapters = await this.listChapters(novelId);
        return await withNovelLock(async () => {
            const novel = await this.get(novelId);
            if (!novel) return null;
            novel.chapterCount = chapters.length;
            novel.wordCount = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);
            novel.updated = Date.now();
            await db.put('novels', novel);
            return novel;
        });
    },

    async deleteChapter(novelId, chapterNum) {
        const found = await this.findChapterKey(novelId, chapterNum);
        if (!found.record) return;          // 本来就不存在，不要凭空删个空 id
        await db.delete('chapters', found.id);
        const versions = await db.getAll('versions', 'chapterId', found.id);
        for (const v of versions) await db.delete('versions', v.id);

        // 同步作品统计。删章以前只删记录，chapterCount / wordCount 还留着旧值，
        // 书架上的「共 N 章 · X 万字」会一直虚高，导入的旧稿删掉几章后尤其明显。
        // 这里走全量校准（批量操作后的一次性修复），不用增量以免误差累积。
        await this.recountNovelStats(novelId);
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
        // 版本挂在章节的真实 id 上（archiveChapterVersion 用的是 chapter.id），
        // 所以这里也要先定位到真实 id，不能直接拼 `${novelId}_ch${n}`
        const found = await this.findChapterKey(novelId, chapterNum);
        const all = await db.getAll('versions', 'chapterId', found.id);
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

// 是否运行在 Capacitor 原生壳里。原生壳的返回键由 backButton 事件接管，
// 浏览器/PWA 没有这套东西，只能靠 history + popstate。
function isNativeApp() {
    const C = window.Capacitor;
    return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
}

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
        // 让浏览器历史跟着一起长：否则 Web 端的系统返回键/手势会直接退出应用，
        // 而页面栈里其实还有上一页。pushState 的条目数与 pageHistory 严格一一对应。
        // 原生壳里不做：那边的返回键由 Capacitor backButton 接管，两套历史同时存在会双退。
        if (!isNativeApp()) { try { history.pushState({ owNav: page }, ''); } catch (_) {} }
    } else if (isRootTab) {
        pageHistory = [];
        // 切底部 tab 视为回到根：替换当前条目而不是新增，避免历史越积越深
        if (!isNativeApp()) { try { history.replaceState({ owRoot: page }, ''); } catch (_) {} }
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
        pacingOverview: (view) => renderPacingOverview(view, params.novelId),
        // 角色卡
        characterCards: (view) => renderCharacterCards(view, params.novelId),
        characterEdit: (view) => renderCharacterEdit(view, params.novelId, params.characterId),
        // 世界观
        worldview: (view) => renderWorldView(view, params.novelId),
        worldviewEdit: (view) => renderWorldviewEdit(view, params.novelId, params.worldviewId),
        // 分段编辑（自身按 page id 取容器）
        paragraphEdit: (view) => renderParagraphEdit(params.novelId, params.chapterNum, view),
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
        <div class="chat-scroll">
            <!-- 状态行：模型 + 关联作品压成一行。
                 原来模型名单独一行、关联条又占一行，加上中间的 Logo 区，
                 进页面 250px 内一个能点的东西都没有。 -->
            <div class="chat-status-row">
                <span class="chat-model-chip">${escapeHtml(store.modelName)}</span>
                <div class="chat-novel-ctx" id="chat-novel-ctx" onclick="showChatNovelPicker()"></div>
            </div>

            <!-- 快捷工具胶囊行 -->
            <div class="chat-tool-row">
                <button class="chat-tool-pill" onclick="showMemo()"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>备忘录</button>
                <button class="chat-tool-pill" onclick="showNameGenerator()"><span class="tool-pill-icon" style="font-size:13px;font-weight:600;">T</span>起名</button>
                <button class="chat-tool-pill primary" onclick="navigateTo('distill')"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 3l9 16H3L12 3z"/><path d="M12 12v4"/></svg></span>蒸馏</button>
                <button class="chat-tool-pill" onclick="showDeconstruct()"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>拆解</button>
            </div>

            <!-- 入口：一个主操作 + 两个次操作。
                 原来三张卡片等权，读完不知道先点哪个。 -->
            <div class="chat-action-list">
                <div class="chat-primary-action" onclick="createNovelWithAI()">
                    <div class="cpa-body">
                        <div class="cpa-title">新书启航</div>
                        <div class="cpa-desc">聊两句就建出书，说个类型和书名就行</div>
                    </div>
                    <span class="cpa-arrow">›</span>
                </div>
                <div class="chat-mini-row">
                    <div class="chat-mini-card" onclick="continueWriting()">
                        <div class="cm-title">继续写作</div>
                        <div class="cm-desc">接上次对话</div>
                    </div>
                    <div class="chat-mini-card" onclick="showTutorial()">
                        <div class="cm-title">使用教程</div>
                        <div class="cm-desc">查看手册</div>
                    </div>
                </div>
            </div>

            <!-- 消息区域（默认隐藏，发送消息后显示） -->
            <div id="chat-messages" style="display:none; flex-direction: column; gap: 12px; margin-top: auto; padding-bottom: 16px;"></div>
        </div>

        <!-- 整合式底部输入区 -->
        <div class="chat-composer">
            <!-- 建书引导的表单卡片插在这一格；卡片出现时下面的输入框整体收起 -->
            <div id="guide-card-slot"></div>
            <div class="composer-main">
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
        </div>
    `;
    renderChatNovelCtx();
    syncComposerPadding();
    // 把上一次的对话填回来。旧实现只渲染欢迎页，历史只有在抽屉里点会话时才加载，
    // 所以切到别的页面再回来（或重开 App），刚聊的内容看起来就"没了"——
    // 其实一条都没丢，全在 IndexedDB 的 messages 表里。
    restoreChatSession(container);
}

// 会话 id 持久化：store 是内存对象，重开 App 会回到默认的 'main'，
// 而用户实际在用的可能是 chat_1758... 那个会话，于是重启后看见的是空的 main。
const CHAT_SESSION_KEY = 'ow_chat_session';
function rememberChatSession(sid) {
    store.currentSessionId = sid;
    try { localStorage.setItem(CHAT_SESSION_KEY, sid); } catch (_) {}
}
function restoreChatSessionId() {
    try {
        const saved = localStorage.getItem(CHAT_SESSION_KEY);
        if (saved) store.currentSessionId = saved;
    } catch (_) {}
}

// 把消息画进聊天区（隐藏欢迎页与快捷卡片）
function paintChatMessages(container, msgs) {
    if (!container) return;
    const hero = container.querySelector('.chat-hero');
    const actionList = container.querySelector('.chat-action-list');
    const messagesBox = container.querySelector('#chat-messages');
    if (hero) hero.style.display = 'none';
    if (actionList) actionList.style.display = 'none';
    if (!messagesBox) return;
    messagesBox.style.display = 'flex';
    messagesBox.innerHTML = msgs.map(m => `
        <div class="msg-row ${m.role}">
            <div class="msg-bubble ${m.role}">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
        </div>
    `).join('');
    messagesBox.scrollTop = messagesBox.scrollHeight;
}

// 每次恢复/切换都自增，回来的结果如果序号过期就丢弃 ——
// 否则慢请求后返回时，会把上一个会话的消息画到新会话上。
let __chatRestoreSeq = 0;

async function restoreChatSession(container) {
    const sid = store.currentSessionId || 'main';
    const seq = ++__chatRestoreSeq;
    let msgs = [];
    try {
        msgs = await db.getAll('messages', 'sessionId', sid);
    } catch (e) {
        return;
    }
    if (seq !== __chatRestoreSeq) return;          // 已有更新的恢复请求
    if (store.currentSessionId !== sid) return;    // 期间切了会话
    if (store.currentPage !== 'chat') return;      // 期间离开了聊天页
    if (!msgs || !msgs.length) return;
    paintChatMessages(container, msgs.sort((a, b) => (a.created || 0) - (b.created || 0)));
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
    // 真正滚动的是 .chat-scroll，不是 #page-chat。
    // composer 又是 fixed 停在导航栏之上，所以底部要留出「输入区高度」，
    // 否则最后一条消息永远被压在输入框下面。
    const scroller = page.querySelector('.chat-scroll');
    if (!scroller) return;
    // 光留 padding 不够：composer 是 fixed，会直接盖在滚动区上。
    // 内容不满一屏时 padding 不生效，最后几条就压在输入框下面。
    // 直接把滚动区高度减掉输入区，两者不再重叠。
    scroller.style.paddingBottom = '16px';
    scroller.style.height = 'calc(100dvh - var(--header-height) - var(--nav-height) - '
        + composer.offsetHeight + 'px)';
}

// 渲染「当前关联作品」条：未关联 = 自由聊天；关联后 = 设定注入 + 可沉淀
async function renderChatNovelCtx() {
    const el = document.getElementById('chat-novel-ctx');
    if (!el) return;
    const novelId = store.chatNovelId;
    if (!novelId) {
        el.innerHTML = `<span class="cnc-dot"></span><span class="cnc-text">未关联 · 点此选作品</span><span class="cnc-arrow">›</span>`;
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
    el.innerHTML = `<span class="cnc-dot on"></span><span class="cnc-text">《${escapeHtml(novel.title)}》 · 角色 ${chars.length} · 设定 ${wbs.length}</span><span class="cnc-arrow">›</span>`;
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
    // 联网失败时留个痕。以前只弹一个 4.5 秒的 toast，手机上经常没看见，
    // 用户以为联网生效了，其实这一条是按普通对话答的。改成在消息流里可见。
    let webSearchError = '';
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
            webSearchError = (e && e.message) || String(e);
            ui.showToast('联网检索失败，本条按普通对话回答：' + webSearchError, 4500);
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
        } else if (webSearchError) {
            aiLoading.insertAdjacentHTML('afterend',
                `<div class="web-src web-src-warn">本条未联网：${escapeHtml(String(webSearchError).slice(0, 140))}</div>`);
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
                    <button class="btn btn-outline btn-sm" onclick="copyName('${escapeJs(n.name)}')">复制</button>
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
        // 走到这里说明：网页版 + 模型没有内置联网 + 没配搜索 Key。
        // App 里不会出现这个分支（可以直接抓搜索结果页，零配置）。
        let mc = null;
        try { mc = await settings.getModelConfig(); } catch (e) { /* 忽略 */ }
        const d = describeBuiltinSearch(mc || {});
        ui.showToast(`网页版受浏览器跨域限制，抓不了搜索结果。${d.reason}：${d.fix}`, 6500);
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

    enableWebSearch(false, picked.mode === 'direct');
}

function enableWebSearch(isPaid, isDirect = false) {
    store.webSearchOn = true;
    store.searchCount = 0;
    try { localStorage.setItem('ow_web_search', '1'); } catch (e) { /* 忽略 */ }
    renderWebSearchBtn();
    let msg = '已联网：发消息前会先检索资料';
    if (isPaid) msg = '已联网：DeepSeek 搜索约 ¥0.005/次（11/1 起计费）';
    else if (isDirect) msg = '已联网：直接抓取搜索结果，不需要配置';
    ui.showToast(msg, 4000);
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
            // 空书架不该先摆一排「0 0 0」的统计卡 —— 那是给有数据的人看的。
            container.innerHTML = `
                <div class="shelf-empty">
                    <div class="shelf-empty-title">还没有作品</div>
                    <div class="shelf-empty-desc">新建一本，或者把在别处写的旧稿导进来</div>
                    <div class="shelf-empty-actions">
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
                    const chTitle = (last.title || '').replace(CHAPTER_PREFIX_RE, '').trim() || '未命名';
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
            <div class="shelf-meta">${stats.totalNovels} 本 · ${stats.totalChapters} 章 · ${fmtWords(stats.totalWords)}</div>
            <div class="novel-list">
                ${novels.map(novel => {
                    const tone = coverTone(novel.title);
                    const sub = [
                        novel.genre ? escapeHtml(novel.genre) : '',
                        `${novel.chapterCount || 0} 章`,
                        fmtWords(novel.wordCount)
                    ].filter(Boolean).join(' · ');
                    return `
                    <div class="novel-item" onclick="navigateTo('novelDetail', { novelId: '${novel.id}' })">
                        <div class="novel-cover" style="--cv-bg:${tone[0]};--cv-fg:${tone[1]}">${escapeHtml((novel.title || "?").charAt(0))}</div>
                        <div class="novel-info">
                            <div class="novel-title">${escapeHtml(novel.title)}</div>
                            <div class="novel-sub">${sub}</div>
                            <div class="novel-time">${formatDate(novel.updated)}</div>
                        </div>
                        <span class="novel-arrow">›</span>
                    </div>`;
                }).join('')}
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
        // 角色以前内嵌在 novel 记录里，后来统一到 characters 表。
        // 先读表，表里没有才回退到旧字段 —— 否则老作品进详情页资料区是空的。
        const tableChars = await novelManager.listCharacters(novelId).catch(() => []);
        const characters = tableChars.length ? tableChars : (novel.characters || []);
        const volumes = await novelManager.listVolumes(novelId);
        
        container.innerHTML = `
            <div class="novel-header-card">
                <div class="novel-header-cover" style="--cv-bg:${coverTone(novel.title)[0]};--cv-fg:${coverTone(novel.title)[1]}">${escapeHtml((novel.title || "?").charAt(0))}</div>
                <div class="novel-header-info">
                    <div class="novel-header-title">${escapeHtml(novel.title)}</div>
                    <div class="novel-header-meta">${novel.chapterCount || 0}章 · ${(novel.wordCount || 0).toLocaleString()}字</div>
                    <div class="novel-header-desc">${escapeHtml(novel.description || '暂无简介')}</div>
                </div>
            </div>

            ${(novel.highlights || []).length ? `
            <div class="nd-highlights">
                <div class="nd-hl-head">设定总览</div>
                ${novel.highlights.slice(0, 8).map(h => `<div class="gs-row">
                    <span class="gs-k">${escapeHtml(h.label || '')}</span>
                    <span class="gs-v">${escapeHtml(h.value || '')}</span>
                </div>`).join('')}
                <button class="guide-act" style="margin-top:10px;" onclick="exportSettingDoc('${escapeJs(novelId)}')">导出设定文档</button>
            </div>` : ''}

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
                <button class="btn btn-outline" onclick="navigateTo('pacingOverview', { novelId: '${novelId}' })">📊 节奏</button>
                <button class="btn btn-outline" onclick="navigateTo('agentStudio', { novelId: '${novelId}' })">🎭 多Agent</button>
                <button class="btn btn-outline" onclick="navigateTo('consistencyCheck', { novelId: '${novelId}' })">🔍 一致性</button>
                <button class="btn btn-outline" onclick="navigateTo('novelExport', { novelId: '${novelId}' })">📤 导出</button>
            </div>

            <!-- 目录树形结构 -->
            <div class="novel-tree">
                <!-- 大纲：空的时候只占一行，点击直接进编辑器 —— 折叠一个空区没有任何意义 -->
                ${outlineItems.length === 0 ? `
                <div class="tree-folder is-empty" onclick="navigateTo('outlineEditor', { novelId: '${novelId}' })">
                    <div class="tree-folder-header">
                        <span class="tree-label">大纲</span>
                        <span class="tree-count">暂无，点击添加</span>
                    </div>
                </div>` : `
                <div class="tree-folder">
                    <div class="tree-folder-header" onclick="toggleTreeFolder(this.parentElement)">
                        <span class="tree-toggle">▼</span>
                        <span class="tree-icon">📋</span>
                        <span class="tree-label">大纲</span>
                        <span class="tree-count">${outlineItems.length}项</span>
                    </div>
                    <div class="tree-folder-content">
                        ${outlineItems.map((item, idx) => `
                                <div class="tree-file" onclick="event.stopPropagation(); viewOutlineItem('${novelId}', ${idx})">
                                    <span class="tree-file-icon">📄</span>
                                    <span class="tree-file-name">第${item.chapter}章 ${escapeHtml(item.title || '')}</span>
                                    <span class="tree-file-meta">${escapeHtml((item.summary || '').substring(0, 20))}...</span>
                                </div>
                            `).join('')}
                    </div>
                </div>`}

                <!-- 资料：空时同样只占一行 -->
                ${characters.length === 0 ? `
                <div class="tree-folder is-empty" onclick="navigateTo('characterCards', { novelId: '${novelId}' })">
                    <div class="tree-folder-header">
                        <span class="tree-label">资料</span>
                        <span class="tree-count">暂无角色，点击添加</span>
                    </div>
                </div>` : `
                <div class="tree-folder">
                    <div class="tree-folder-header" onclick="toggleTreeFolder(this.parentElement)">
                        <span class="tree-toggle">▼</span>
                        <span class="tree-icon">📁</span>
                        <span class="tree-label">资料</span>
                        <span class="tree-count">${characters.length}项</span>
                    </div>
                    <div class="tree-folder-content">
                        ${characters.map((char, idx) => `
                                <div class="tree-file" onclick="event.stopPropagation(); viewCharacter('${novelId}', ${idx})">
                                    <span class="tree-file-icon">👤</span>
                                    <span class="tree-file-name">${escapeHtml(char.name || '')}</span>
                                    <span class="tree-file-meta">${escapeHtml(char.role || '角色')}</span>
                                </div>
                            `).join('')}
                    </div>
                </div>`}

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
        // 用「最大章号 + 1」而不是「章节条数」：删过中间章之后条数会小于最大章号，
        // 按条数续号会直接覆盖现存的章节。
        let num = existing.reduce((m, c) => Math.max(m, Number(c.number) || 0), 0);
        // 直接批量落库 + 最后一次性校准统计，不逐章调 saveChapter：
        // saveChapter 每章都要读一次 novel 再写回（导入 500 章就是 500 次额外读写），
        // 而且它会调 addTodayWords——把几十万字的历史旧稿记成"今日新增"，
        // 今日进度条会当场撑爆。导入不是写作，本来就不该计入今日字数。
        const now = Date.now();
        for (const ch of chapters) {
            num += 1;
            const content = ch.content || '';
            await db.put('chapters', {
                id: `${novelId}_ch${num}`,
                novelId,
                number: num,
                title: ch.title || `第${num}章`,
                content,
                wordCount: content.length,
                created: now,
                updated: now
            });
        }
        await novelManager.recountNovelStats(novelId);
        window.__importChapters = null;
        closeModal();
        ui.showToast(`已导入 ${chapters.length} 章，共 ${chapters.reduce((sum,c)=>sum+(c.content||'').length,0).toLocaleString()} 字`, 4000);
        navigateTo('novelDetail', { novelId });
    } catch (e) {
        ui.showToast('导入失败：' + e.message, 4500);
    }
}

// ===== 分卷 / 章节排序（v2.10.1）=====
// 章号前缀：阿拉伯数字和中文数字都要剥。
// 原来只匹配「第12章」，标题写成「第一章 石阶」时会渲染成「第1章 第一章 石阶」。
const CHAPTER_PREFIX_RE = /^第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回]\s*[·、.．:：\-—]?\s*/;

function chapterRowHtml(ch, novelId) {
    const raw = (ch.title || '').trim();
    const stripped = raw.replace(CHAPTER_PREFIX_RE, '').trim();
    const shown = stripped || raw.replace(CHAPTER_PREFIX_RE, '') || '';
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
        <!-- 底部工具：一个主操作 + 一行常用工具 + 「更多」抽屉。
             原来是 3 行 12 个同等权重的按钮，占掉近三分之一屏，正文被挤到上面。 -->
        <div class="editor-actions">
            <button class="btn btn-primary editor-primary" onclick="aiContinueChapter('${novelId}', ${chapterNum})">AI 续写本章</button>
            <div class="editor-chips">
                <button class="editor-chip" onclick="checkChapterLocal('${novelId}', ${chapterNum})">体检</button>
                <button class="editor-chip" onclick="reviewThisChapter('${novelId}', ${chapterNum})">审稿</button>
                <button class="editor-chip" onclick="extractChapterSettings('${novelId}', ${chapterNum})">提取设定</button>
                <button class="editor-chip" onclick="showEditorTools('${novelId}', ${chapterNum})">更多工具</button>
            </div>
        </div>
    `;

    bindEditorAutosave(novelId, chapterNum);
}

// 编辑器「更多工具」抽屉。低频操作收进来，底部只留常用四件，
// 免得标题、正文之外还堆着两行按钮跟正文抢注意力。
function showEditorTools(novelId, chapterNum) {
    const tools = [
        { icon: '🎬', name: '节拍控制', desc: '按节拍推进本章', act: `navigateTo('beatControl', { novelId: '${novelId}', chapterNum: ${chapterNum} })` },
        { icon: '📄', name: '分段编辑', desc: '逐段改写与调序', act: `navigateTo('paragraphEdit', { novelId: '${novelId}', chapterNum: ${chapterNum} })` },
        { icon: '🎭', name: 'AI 读者', desc: '模拟读者反馈', act: `aiReaderSimulate('${novelId}', ${chapterNum})` },
        { icon: '📝', name: '生成摘要', desc: '给后续章节当上下文', act: `generateChapterSummary('${novelId}', ${chapterNum})` },
        { icon: '🕘', name: '历史版本', desc: '回滚到旧稿', act: `showChapterHistory('${novelId}', ${chapterNum})` },
        { icon: '🔎', name: '查资料', desc: '联网检索并沉淀', act: `showResearchSheet('${novelId}')` },
        { icon: '🎧', name: '听稿校对', desc: 'TTS 逐句朗读', act: `navigateTo('listen', { novelId: '${novelId}', chapterNum: ${chapterNum} })` },
        { icon: '🪝', name: '章末钩子', desc: '检查结尾留人能力', act: `checkChapterHook('${novelId}', ${chapterNum})` },
        { icon: '👤', name: '人名检查', desc: '找出还没进角色库的名字', act: `checkChapterNames('${novelId}', ${chapterNum})` }
    ];
    const body = `<div class="tool-grid">
        ${tools.map(t => `
            <button class="tool-cell" onclick="closeModal(); ${t.act}">
                <span class="tool-name">${t.name}</span>
                <span class="tool-desc">${t.desc}</span>
            </button>`).join('')}
    </div>`;
    createModal('更多工具', body).show();
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
            <div class="settings-group-title">模型与技能</div>
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
        </div>

        <div class="settings-group">
            <div class="settings-group-title">写作辅助</div>
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
        </div>

        <div class="settings-group">
            <div class="settings-group-title">数据</div>
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

// ===== 对话式小说创建引导 =====

// ===== 对话式建书引导 v2.22：表单卡片 =====
// 旧版是五步聊天问答，每步都要手打。改成底部表单：chip 点选 + 可自定义，
// 一屏一问带进度，能回退。顺序参考 Sudowrite 的 Braindump 优先：
// 先让人把想法倒出来（可跳过），再用题材收敛——而不是上来就让人分类。

const GUIDE_TOTAL = 4;
const GUIDE_KEYS = ['idea', 'genre', 'style', 'title'];
const GUIDE_SKIPPABLE = { idea: true };

const GUIDE_GENRES = ['玄幻仙侠', '都市异能', '科幻末世', '悬疑灵异', '历史架空', '言情', '游戏竞技', '规则怪谈'];
const GUIDE_STYLES = ['热血爽文', '轻松诙谐', '厚重正剧', '暗黑压抑'];

let novelGuideState = null;

function startNovelCreationGuide() {
    novelGuideState = {
        step: 0,
        answers: { idea: '', genre: '', style: '', title: '' },
        titles: [],
        busy: false
    };
    const actionList = document.querySelector('.chat-action-list');
    if (actionList) actionList.style.display = 'none';
    const box = document.getElementById('chat-messages');
    if (box) box.style.display = 'flex';
    // 一句开场白：上面空着 500px 会让人以为没加载出来，顺便说清有几步
    guidePushHtml('<div class="guide-intro">四个问题，大概半分钟。'
        + '答完我直接给你一套能开写的骨架——<br>设定、大纲、第一章怎么起笔，一次到位。</div>');
    guideRenderStep();
}

// 卡片显示时收起输入框；隐藏时还原
function guideSetComposerVisible(visible) {
    const main = document.querySelector('.composer-main');
    if (main) main.style.display = visible ? '' : 'none';
    syncComposerPadding();
}

function guideRenderStep() {
    const st = novelGuideState;
    const slot = document.getElementById('guide-card-slot');
    if (!st || !slot) return;
    guideSetComposerVisible(false);

    const n = st.step + 1;
    const key = GUIDE_KEYS[st.step];
    const val = st.answers[key] || '';
    let head = '', question = '', body = '';

    if (key === 'idea') {
        head = '想写个什么';
        question = '一句话就行。想不出也没关系，直接跳过。';
        body = `
            <textarea class="guide-textarea" id="guide-idea" rows="3"
                placeholder="比如：出租车司机在雨夜接到一单，客人是个没有影子的人"
                oninput="guideIdeaInput(this)">${escapeHtml(val)}</textarea>`;
    } else if (key === 'genre') {
        head = '题材';
        question = '打算写哪个方向？';
        body = `<div class="guide-chips">
            ${GUIDE_GENRES.map(g => `<button class="guide-chip${val === g ? ' on' : ''}"
                data-guide-chip="genre" data-value="${escapeAttr(g)}"
                onclick="guidePick('genre', '${escapeJs(g)}')">${escapeHtml(g)}</button>`).join('')}
        </div>
        <input class="guide-custom" id="guide-custom" placeholder="或者自己写一个…"
            oninput="guideCustomInput('genre')">`;
    } else if (key === 'style') {
        head = '风格';
        question = '同样是都市异能，写法可以完全不同。';
        body = `<div class="guide-chips">
            ${GUIDE_STYLES.map(g => `<button class="guide-chip${val === g ? ' on' : ''}"
                data-guide-chip="style" data-value="${escapeAttr(g)}"
                onclick="guidePick('style', '${escapeJs(g)}')">${escapeHtml(g)}</button>`).join('')}
        </div>
        <input class="guide-custom" id="guide-custom" placeholder="或者自己描述，比如「冷幽默、句子短」"
            oninput="guideCustomInput('style')">`;
    } else if (key === 'title') {
        head = '书名';
        question = '先挑一个，后面随时能改。';
        body = `<div id="guide-title-area">${st.titles.length
            ? st.titles.map(t => `<button class="guide-chip${val === t ? ' on' : ''}"
                data-guide-chip="title" data-value="${escapeAttr(t)}"
                onclick="guidePick('title', '${escapeJs(t)}')">${escapeHtml(t)}</button>`).join('')
            : '<div class="guide-loading">正在按题材和风格想几个…</div>'}
        </div>
        <input class="guide-custom" id="guide-custom" placeholder="或者自己起一个"
            value="${escapeAttr(val)}" oninput="guideCustomInput('title')">`;
    }

    slot.innerHTML = `
        <div class="guide-card">
            <div class="guide-card-head">
                <span class="guide-step">${n}/${GUIDE_TOTAL}</span>
                <span class="guide-head">${head}</span>
            </div>
            <div class="guide-q">${question}</div>
            ${body}
            <div class="guide-foot">
                <button class="guide-back" ${n === 1 ? 'disabled' : ''} onclick="guideBack()">上一题</button>
                <button class="guide-next" onclick="guideNext()">${n === GUIDE_TOTAL ? '开始写' : '下一题'}</button>
            </div>
        </div>`;
    syncComposerPadding();

    // 第四步进来自动去要书名候选
    if (key === 'title' && !st.titles.length && !st.busy) guideLoadTitles();
}

function guideIdeaInput(el) {
    if (novelGuideState) novelGuideState.answers.idea = el.value;
}

// 选 chip：清空自定义框，避免两个值打架
function guidePick(key, value) {
    const st = novelGuideState;
    if (!st) return;
    st.answers[key] = value;
    document.querySelectorAll('[data-guide-chip="' + key + '"]').forEach(el => {
        el.classList.toggle('on', el.dataset.value === value);
    });
    const ci = document.getElementById('guide-custom');
    if (ci) ci.value = '';
}

// 手写：取消所有 chip 高亮
function guideCustomInput(key) {
    const st = novelGuideState;
    const ci = document.getElementById('guide-custom');
    if (!st || !ci) return;
    const v = ci.value.trim();
    st.answers[key] = v;
    document.querySelectorAll('[data-guide-chip="' + key + '"]').forEach(el => el.classList.remove('on'));
}

async function guideNext() {
    const st = novelGuideState;
    if (!st || st.busy) return;
    const key = GUIDE_KEYS[st.step];
    const v = (st.answers[key] || '').trim();

    if (!v && !GUIDE_SKIPPABLE[key]) {
        // 手写框里可能刚输入还没触发 oninput（部分输入法）
        ui.showToast(key === 'title' ? '选一个书名，或者自己起一个' : '选一个，或者在下面自己写');
        return;
    }
    if (v) addChatMessage('user', v);

    st.step++;
    if (st.step >= GUIDE_TOTAL) { await guideGenerate(); return; }
    guideRenderStep();
}

function guideBack() {
    const st = novelGuideState;
    if (!st || st.step === 0 || st.busy) return;
    st.step--;
    // 往回改时，下游的自动候选全部作废
    if (st.step < 3) st.titles = [];
    guideRenderStep();
}

// 按题材 + 风格 + 想法拟 3 个书名
async function guideLoadTitles() {
    const st = novelGuideState;
    if (!st) return;
    st.busy = true;
    const area = document.getElementById('guide-title-area');
    try {
        const ctx = [
            st.answers.genre ? '题材：' + st.answers.genre : '',
            st.answers.style ? '风格：' + st.answers.style : '',
            st.answers.idea ? '想法：' + st.answers.idea : ''
        ].filter(Boolean).join('；');
        const r = await ai.chat([
            { role: 'system', content: '你是网文编辑，只输出书名，不要解释。' },
            { role: 'user', content: ctx + '\n\n按这个方向起 3 个中文书名，要求：符合平台调性、2-8 字、不要书名号、不要编号。每行一个，只输出三行。' }
        ], null, 200);
        const list = String(r || '').split('\n')
            .map(x => x.replace(/^[\s\d.、．)）-]+/, '').replace(/[《》「」"']/g, '').trim())
            .filter(x => x && x.length <= 14)
            .slice(0, 3);
        st.titles = list;
        if (area) {
            area.innerHTML = list.length
                ? list.map(t => '<button class="guide-chip" data-guide-chip="title" data-value="'
                    + escapeAttr(t) + '" onclick="guidePick(\'title\', \'' + escapeJs(t) + '\')">'
                    + escapeHtml(t) + '</button>').join('')
                : '<div class="guide-loading">没想出来，直接自己起一个吧</div>';
        }
    } catch (e) {
        if (area) area.innerHTML = '<div class="guide-loading">书名没生成出来，自己起一个也行</div>';
    } finally {
        if (novelGuideState) novelGuideState.busy = false;
    }
}

// 一行状态：等待时只显示这一句，不刷工具链
function guideSetBusy(text) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    let el = document.getElementById('guide-busy');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('div');
        el.id = 'guide-busy';
        el.className = 'msg-row ai';
        box.appendChild(el);
    }
    el.innerHTML = '<div class="guide-busy-line"><i></i>' + escapeHtml(text) + '</div>';
    box.scrollTop = box.scrollHeight;
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

// 生成骨架 → 落库 → 总览 + 开篇建议。
// 不再让用户"确认一次再建"——四个问题都答完了，再确认一次只是多一次点击。
async function guideGenerate() {
    const st = novelGuideState;
    if (!st) return;
    const a = st.answers;

    const slot = document.getElementById('guide-card-slot');
    if (slot) slot.innerHTML = '';
    guideSetComposerVisible(true);
    guideSetBusy('正在搭大纲…');

    const given = [
        a.idea ? '作者的想法：' + a.idea : '',
        '题材：' + a.genre,
        '风格：' + a.style,
        '书名：《' + a.title + '》'
    ].filter(Boolean).join('\n');

    const prompt = '请为一部' + a.genre + '小说搭一套可以直接开写的骨架。\n\n' + given + '\n\n' +
`要求：
1. 大纲 12-15 章。每章写清「这一章发生了什么变化」，不要写"冲突升级""局势紧张"这种写不出来的话。
2. 角色 3-5 个。主角必须有具体身份、想要什么、被什么困住；配角写清与主角的关系。
3. 世界观只写会影响剧情的规则，2-3 条，不要堆设定。
4. highlights 6 条左右，行名按题材决定（都市写「金手指」「主角」，悬疑写「谜面」「关键线索」，玄幻写「力量体系」「主角」），value 一句话。
5. opening：第一章的开篇建议，120 字以内。写清从哪个场景起笔、发生什么、结尾留什么钩子。**只给建议，不要写正文**。

只输出 JSON，不要 markdown 代码块：
{
  "outline": [{"chapter": 1, "title": "章名", "summary": "本章的变化"}],
  "characters": [{"name": "名字", "role": "主角", "description": "身份+想要什么+困境"}],
  "worldbuilding": "世界观简述",
  "synopsis": "100 字梗概",
  "highlights": [{"label": "世界", "value": "一句话"}],
  "opening": "开篇建议"
}`;

    let plan = null;
    try {
        const raw = await ai.chat([
            { role: 'system', content: '你是网文策划编辑。产出会直接变成写作骨架，每一条都要具体到能写。' },
            { role: 'user', content: prompt }
        ], null, 4000);
        plan = parseJsonLoose(raw, '{', '}', (v) =>
            v && typeof v === 'object' && !Array.isArray(v) && 'outline' in v);
    } catch (e) {
        plan = null;
    }

    if (!plan || !Array.isArray(plan.outline) || !plan.outline.length) {
        guideSetBusy('');
        addChatMessage('ai', '大纲没生成出来（可能是网络问题，或模型返回的格式不对）。', []);
        const box = document.getElementById('chat-messages');
        if (box) {
            const d = document.createElement('div');
            d.className = 'msg-row ai';
            d.innerHTML = '<div class="guide-actions">'
                + '<button class="guide-act primary" onclick="guideRetry()">再来一次</button>'
                + '<button class="guide-act" onclick="guideManual()">手动建书</button>'
                + '</div>';
            box.appendChild(d);
            box.scrollTop = box.scrollHeight;
        }
        return;
    }

    guideSetBusy('正在建书…');
    let novel;
    try {
        novel = await guideSaveNovel(plan, a);
    } catch (e) {
        guideSetBusy('');
        addChatMessage('ai', '建书失败：' + e.message, []);
        return;
    }
    guideSetBusy('');

    // ① 设定总览
    guidePushHtml(renderSettingSummary(plan, a, novel.id));

    // ② 开篇建议 + 下一步
    const opening = String(plan.opening || '').trim();
    const box = document.getElementById('chat-messages');
    if (box) {
        const d = document.createElement('div');
        d.className = 'msg-row ai guide-stack';
        d.innerHTML = (opening
            ? '<div class="guide-result"><div class="gs-open-k">第一章可以这么起笔</div>'
              + '<div class="gs-open-v">' + escapeHtml(opening) + '</div></div>'
            : '')
            + '<div class="guide-actions">'
            + '<button class="guide-act primary" onclick="guideStartWriting(\'' + escapeJs(novel.id) + '\')">'
            + (opening ? '按这个写第一章' : '直接写第一章') + '</button>'
            + '<button class="guide-act" onclick="guideRedo()">换个方向</button>'
            + '<button class="guide-act" onclick="guideOpenDetail(\'' + escapeJs(novel.id) + '\')">我自己来</button>'
            + '</div>';
        box.appendChild(d);
        box.scrollTop = box.scrollHeight;
    }
    // 结果卡片比较高，重算滚动区高度后要滚到底，否则「按这个写第一章」被挡在下面
    syncComposerPadding();
    const sc = document.querySelector('.chat-scroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
}

// 落库：作品 + 大纲 + 角色表 + 世界观表 + 高亮项 + 开篇建议
async function guideSaveNovel(plan, a) {
    const novel = await novelManager.create(
        a.title || plan.title || '未命名',
        plan.synopsis || '',
        a.genre || ''
    );
    novel.style = a.style || '';
    novel.idea = a.idea || '';
    novel.highlights = Array.isArray(plan.highlights) ? plan.highlights.slice(0, 10) : [];
    novel.opening = String(plan.opening || '');
    if (Array.isArray(plan.outline)) novel.outline = plan.outline;
    await novelManager.update(novel);

    for (const c of (plan.characters || [])) {
        if (!c || !c.name) continue;
        try {
            await novelManager.createCharacter(novel.id, {
                name: c.name,
                role: c.role || '',
                description: c.description || '',
                personality: c.description || ''
            });
        } catch (_) { /* 单个角色失败不影响建书 */ }
    }

    if (plan.worldbuilding) {
        try {
            await novelManager.createWorldbuilding(novel.id, {
                title: '世界观',
                category: 'other',
                content: String(plan.worldbuilding)
            });
        } catch (_) { /* 同上 */ }
    }
    return novel;
}

// 设定总览：一屏看完 AI 编了个什么故事
function renderSettingSummary(plan, a, novelId) {
    const rows = (plan.highlights || []).filter(h => h && h.label).slice(0, 8);
    const fallback = [
        { label: '题材', value: a.genre || '' },
        { label: '风格', value: a.style || '' }
    ].filter(r => r.value);
    const list = rows.length ? rows : fallback;

    return '<div class="guide-result">'
        + '<div class="gs-head">《' + escapeHtml(a.title || '未命名') + '》已建好</div>'
        + (list.length ? '<div class="gs-rows">' + list.map(h =>
            '<div class="gs-row"><span class="gs-k">' + escapeHtml(h.label)
            + '</span><span class="gs-v">' + escapeHtml(h.value || '') + '</span></div>').join('') + '</div>'
            : '')
        + '<div class="gs-foot">'
        + '<button class="guide-act primary" onclick="guideAdjustOpen(\'' + escapeJs(novelId) + '\')">调整设定</button>'
        + '<button class="guide-act" onclick="exportSettingDoc(\'' + escapeJs(novelId) + '\')">导出文档</button>'
        + '<button class="guide-act" onclick="guideOpenDetail(\'' + escapeJs(novelId) + '\')">查看作品</button>'
        + '</div></div>';
}

function guidePushHtml(html) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'msg-row ai';
    d.innerHTML = html;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
}

// 按开篇建议写第一章：把建议写进本章场景卡，再进编辑器
async function guideStartWriting(novelId) {
    try {
        const novel = await novelManager.get(novelId);
        if (novel && novel.opening) {
            // 第 1 章这时还不存在（saveChapterScene 会抛「章节不存在」），先建出来
            let chapter = await novelManager.getChapter(novelId, 1);
            if (!chapter) {
                const outline = novel.outline || [];
                const first = outline.find(o => Number(o.chapter) === 1) || outline[0] || {};
                const title = first.title ? '第1章 ' + first.title : '第一章';
                await novelManager.saveChapter(novelId, 1, title, '', null, { archive: false });
                chapter = await novelManager.getChapter(novelId, 1);
            }
            if (chapter) {
                const scene = chapter.scene || {};
                if (!scene.goal) {
                    scene.goal = String(novel.opening).slice(0, 300);
                    await novelManager.saveChapterScene(novelId, 1, scene);
                    ui.showToast('开篇建议已放进第 1 章的场景卡', 3000);
                }
            }
        }
    } catch (_) { /* 写不进场景卡也不挡着进编辑器 */ }
    novelGuideState = null;
    navigateTo('chapterEdit', { novelId, chapterNum: 1 });
}

function guideOpenDetail(novelId) {
    novelGuideState = null;
    navigateTo('novelDetail', { novelId });
}

function guideRedo() {
    if (!novelGuideState) novelGuideState = { step: 1, answers: {}, titles: [], busy: false };
    novelGuideState.step = 1;          // 回到「题材」
    novelGuideState.titles = [];
    guideRenderStep();
}

function guideRetry() {
    if (novelGuideState) novelGuideState.step = GUIDE_TOTAL - 1;
    guideRenderStep();
}

function guideManual() {
    novelGuideState = null;
    guideSetComposerVisible(true);
    const slot = document.getElementById('guide-card-slot');
    if (slot) slot.innerHTML = '';
    showCreateNovelModal();
}

// ===== 改设定：判断范围 → 列失效项 → 按新方向重新规划 =====
// 参考产品的做法：用户改的如果是一句话就能说清的方向（"换成 2010 年代穿越"），
// 不是去改一个字段，而是当成"换了个故事"——书名、大纲、开篇建议全都跟着失效。
// 我们这里分三层：只改书名 / 局部替换 / 全盘重规划。

// 题材 → 关键决策点。这是整件事里最不该让模型临场发挥的部分：
// 问错问题等于白问，所以硬编码经过验证的分岔口，跑通后再谈自定义。
const TOPIC_KEYS = {
    '都市异能': [
        { key: 'power', title: '金手指来路', q: '这个能力从哪来？', options: ['未来科技', '神秘系统', '家族传承', '有代价的诅咒'] },
        { key: 'start', title: '故事从哪开始', q: '主角此刻在什么阶段？', options: ['高三', '大学刚毕业', '职场三年', '三十岁重来'] }
    ],
    '玄幻仙侠': [
        { key: 'system', title: '力量体系', q: '修为怎么涨？', options: ['境界晋级', '血脉觉醒', '悟道', '靠吞噬他人'] },
        { key: 'origin', title: '主角起点', q: '开局是什么身份？', options: ['废柴', '天才', '外来者', '被逐出师门'] }
    ],
    '悬疑灵异': [
        { key: 'case', title: '案件性质', q: '偏哪一路？', options: ['本格推理', '社会派', '灵异', '心理惊悚'] },
        { key: 'role', title: '主角位置', q: '他是谁？', options: ['查案者', '当事人', '嫌疑人', '旁观者'] }
    ],
    '历史架空': [
        { key: 'identity', title: '穿越身份', q: '落在什么身份上？', options: ['平民', '权贵子弟', '军中', '宫中'] },
        { key: 'era', title: '时代节点', q: '什么世道？', options: ['乱世将起', '盛世之下', '王朝末年', '改朝换代'] }
    ],
    '言情': [
        { key: 'relation', title: '关系起点', q: '两人怎么开始？', options: ['先婚后爱', '破镜重圆', '双向暗恋', '宿敌'] },
        { key: 'block', title: '外部阻碍', q: '什么在拦着他们？', options: ['家族', '阶层', '职业', '旧事'] }
    ],
    '科幻末世': [
        { key: 'disaster', title: '灾变类型', q: '世界怎么变成这样的？', options: ['病毒', '天灾', 'AI 接管', '维度入侵'] },
        { key: 'survive', title: '生存方式', q: '主角靠什么活？', options: ['囤积物资', '加入营地', '独行', '建立势力'] }
    ],
    '规则怪谈': [
        { key: 'rule', title: '规则来路', q: '规则是谁定的？', options: ['无主之地', '前任留下的', '活物', '代价交换'] },
        { key: 'trap', title: '主角处境', q: '他怎么进来的？', options: ['误入', '被选中', '自愿调查', '替人顶替'] }
    ],
    '游戏竞技': [
        { key: 'game', title: '竞技项目', q: '打什么？', options: ['电竞', '全息游戏', '现实副本', '老游戏复活'] },
        { key: 'team', title: '主角位置', q: '在队里是什么角色？', options: ['队长', '替补', '单人', '教练'] }
    ]
};

const REPLAN_PICKS = ['世界观', '金手指', '主角设定', '对手', '开篇'];

let guideAdjustState = null;

// 总览卡片上点「调整设定」：先问哪不满意，而不是让人去角色卡逐页改
function guideAdjustOpen(novelId) {
    guideAdjustState = { novelId, picks: new Set(), mode: 'pick' };
    // 从总览卡片点进来时对话里已有内容，但如果是直接调用，先把空态入口藏掉
    const actionList = document.querySelector('.chat-action-list');
    if (actionList) actionList.style.display = 'none';
    guideRenderAdjustCard();
}

function guideRenderAdjustCard() {
    const st = guideAdjustState;
    const slot = document.getElementById('guide-card-slot');
    if (!st || !slot) return;
    guideSetComposerVisible(false);

    slot.innerHTML = '<div class="guide-card">'
        + '<div class="guide-card-head"><span class="guide-step">调整</span>'
        + '<span class="guide-head">哪里不满意</span></div>'
        + '<div class="guide-q">可以多选。选完我会判断是改细节，还是换个故事重来。</div>'
        + '<div class="guide-chips">'
        + ['世界观', '金手指', '主角设定', '对手', '开篇', '书名'].map(x =>
            '<button class="guide-chip" data-adjust="' + x + '" onclick="guideAdjustToggle(this)">' + x + '</button>'
        ).join('')
        + '</div>'
        + '<input class="guide-custom" id="guide-adjust-custom"'
        + ' placeholder="或者直接说，比如「换成 2010 年代，带着 AI 穿越回去」">'
        + '<div class="guide-foot">'
        + '<button class="guide-back" onclick="guideAdjustCancel()">取消</button>'
        + '<button class="guide-next" onclick="guideAdjustSubmit()">提交</button>'
        + '</div></div>';
    syncComposerPadding();
}

function guideAdjustToggle(el) {
    if (!guideAdjustState) return;
    const k = el.dataset.adjust;
    if (guideAdjustState.picks.has(k)) { guideAdjustState.picks.delete(k); el.classList.remove('on'); }
    else { guideAdjustState.picks.add(k); el.classList.add('on'); }
}

// 只改书名：最简单的一档，不重规划
async function showRenameNovelModal(novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) return;
    createModal('改书名', `
        <div class="form-group">
            <label class="form-label">书名</label>
            <input class="input" id="novel-title-input" value="${escapeAttr(novel.title)}" maxlength="40">
        </div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="renameNovelConfirm('${escapeJs(novelId)}')">保存</button>
        </div>`).show();
}

async function renameNovelConfirm(novelId) {
    const input = document.getElementById('novel-title-input');
    const v = ((input && input.value) || '').trim();
    if (!v) { ui.showToast('书名不能为空'); return; }
    try {
        const n = await novelManager.get(novelId);
        if (!n) return;
        n.title = v;
        await novelManager.update(n);
        closeModal();
        ui.showToast('已改名');
        if (store.currentPage === 'novelDetail') navigateTo('novelDetail', { novelId }, true);
        else if (store.currentPage === 'bookshelf') navigateTo('bookshelf', {}, true);
    } catch (e) {
        ui.showToast('改名失败：' + e.message);
    }
}

function guideAdjustCancel() {
    guideAdjustState = null;
    const slot = document.getElementById('guide-card-slot');
    if (slot) slot.innerHTML = '';
    guideSetComposerVisible(true);
}

// 判断这是「改细节」还是「换故事」。
// 规则简单但够用：只点书名 = 改名；点到地基项或话里有"换/改成/不要" = 重来。
function guideDetectScope(picks, custom) {
    const t = String(custom || '');
    if (/换|改成|不要|不想|重来|另起|重新/.test(t)) return 'replan';
    if (picks.some(p => REPLAN_PICKS.includes(p))) return 'replan';
    if (picks.length === 1 && picks[0] === '书名') return 'rename';
    return 'local';
}

async function guideAdjustSubmit() {
    const st = guideAdjustState;
    if (!st) return;
    const picks = Array.from(st.picks);
    const customEl = document.getElementById('guide-adjust-custom');
    const custom = customEl ? customEl.value.trim() : '';
    if (!picks.length && !custom) { ui.showToast('选一项，或者直接说哪里不对'); return; }

    const novel = await novelManager.get(st.novelId);
    if (!novel) { ui.showToast('作品不见了'); return; }
    const scope = guideDetectScope(picks, custom);

    if (scope === 'rename') {
        guideAdjustCancel();
        showRenameNovelModal(st.novelId);
        return;
    }

    if (scope === 'local') {
        guideAdjustCancel();
        ui.showToast('这类改动建议用「一致性检查」里的批量替换，会同步改到每一章', 4000);
        navigateTo('consistencyCheck', { novelId: st.novelId });
        return;
    }

    // 换故事：已经写了正文就不能直接覆盖，否则几万字全悬空
    if ((novel.chapterCount || 0) > 0) {
        guideAdjustCancel();
        const ok = confirm('这本已经写了 ' + novel.chapterCount + ' 章正文。\n\n'
            + '换方向会让已有正文和新设定对不上。建议另存一本新书来试这个方向，原书保持不动。\n\n'
            + '点「确定」另存新书，点「取消」先导出备份。');
        if (ok) startReplanGuide(null, novel);
        else exportSettingDoc(st.novelId);
        return;
    }

    guideAdjustCancel();
    startReplanGuide(st.novelId, novel);
}

// 重规划：只问最少的几件事——新题材、风格、以及该题材的两个关键分岔口
let replanState = null;

function startReplanGuide(targetNovelId, novel) {
    const genre = (novel && novel.genre) || '';
    const keys = TOPIC_KEYS[genre] || [];
    replanState = {
        targetNovelId,          // null = 另存新书
        sourceNovel: novel || null,
        step: 0,
        picks: { genre, style: (novel && novel.style) || '' },
        topicKeys: keys,
        topicAnswers: {}
    };
    // 题材变了要重算关键点，所以进第一步就重新取
    guideRenderReplanStep();
}

function replanSteps() {
    const st = replanState;
    const keys = TOPIC_KEYS[st.picks.genre] || [];
    st.topicKeys = keys;
    return keys.length;   // 关键点题数（0-2）
}

function guideRenderReplanStep() {
    const st = replanState;
    const slot = document.getElementById('guide-card-slot');
    if (!st || !slot) return;
    guideSetComposerVisible(false);

    const extra = replanSteps();
    const total = 2 + extra;              // 题材 + 风格 + 关键点
    const n = st.step + 1;
    let head = '', question = '', body = '';

    if (st.step === 0) {
        head = '新方向';
        question = '换到哪一类？';
        body = '<div class="guide-chips">' + Object.keys(TOPIC_KEYS).map(g =>
            '<button class="guide-chip' + (st.picks.genre === g ? ' on' : '') + '"'
            + ' data-guide-chip="genre" data-value="' + escapeAttr(g) + '"'
            + ' onclick="guidePick(\'genre\', \'' + escapeJs(g) + '\')">' + escapeHtml(g) + '</button>'
        ).join('') + '</div>';
    } else if (st.step === 1) {
        head = '风格';
        question = '这次想写成什么味道？';
        body = '<div class="guide-chips">' + GUIDE_STYLES.map(g =>
            '<button class="guide-chip' + (st.picks.style === g ? ' on' : '') + '"'
            + ' data-guide-chip="style" data-value="' + escapeAttr(g) + '"'
            + ' onclick="guidePick(\'style\', \'' + escapeJs(g) + '\')">' + escapeHtml(g) + '</button>'
        ).join('') + '</div>';
    } else {
        const k = st.topicKeys[st.step - 2];
        if (!k) { guideReplanGenerate(); return; }
        head = k.title;
        question = k.q;
        body = '<div class="guide-chips">' + k.options.map(o =>
            '<button class="guide-chip' + (st.topicAnswers[k.key] === o ? ' on' : '') + '"'
            + ' data-guide-chip="' + escapeJs(k.key) + '" data-value="' + escapeAttr(o) + '"'
            + ' onclick="replanPick(\'' + escapeJs(k.key) + '\', \'' + escapeJs(o) + '\')">' + escapeHtml(o) + '</button>'
        ).join('') + '</div>';
    }

    slot.innerHTML = '<div class="guide-card">'
        + '<div class="guide-card-head"><span class="guide-step">' + n + '/' + total + '</span>'
        + '<span class="guide-head">' + head + '</span></div>'
        + '<div class="guide-q">' + question + '</div>'
        + body
        + '<div class="guide-foot">'
        + '<button class="guide-back"' + (n === 1 ? ' disabled' : '') + ' onclick="replanBack()">上一题</button>'
        + '<button class="guide-next" onclick="replanNext()">'
        + (n === total ? '重新搭' : '下一题') + '</button>'
        + '</div></div>';
    syncComposerPadding();
}

function replanPick(key, value) {
    const st = replanState;
    if (!st) return;
    st.topicAnswers[key] = value;
    // 关键点用 key 区分，和题材/风格这两步的 data-guide-chip 不冲突
    if (key === 'genre') st.picks.genre = value;
    if (key === 'style') st.picks.style = value;
    document.querySelectorAll('[data-guide-chip="' + key + '"]').forEach(el => {
        el.classList.toggle('on', el.dataset.value === value);
    });
}

function replanBack() {
    const st = replanState;
    if (!st || st.step === 0) return;
    st.step--;
    guideRenderReplanStep();
}

async function replanNext() {
    const st = replanState;
    if (!st) return;
    if (st.step === 0 && !st.picks.genre) { ui.showToast('选一个题材'); return; }
    if (st.step === 1 && !st.picks.style) { ui.showToast('选一个风格'); return; }
    if (st.step >= 2) {
        const k = st.topicKeys[st.step - 2];
        if (k && !st.topicAnswers[k.key]) { ui.showToast('选一个，或者先不选也行'); }
    }
    st.step++;
    const total = 2 + (TOPIC_KEYS[st.picks.genre] || []).length;
    if (st.step >= total) { await guideReplanGenerate(); return; }
    guideRenderReplanStep();
}

async function guideReplanGenerate() {
    const st = replanState;
    if (!st) return;
    const slot = document.getElementById('guide-card-slot');
    if (slot) slot.innerHTML = '';
    guideSetComposerVisible(true);
    guideSetBusy('按新方向重新搭…');

    const kp = st.topicKeys.map(k =>
        st.topicAnswers[k.key] ? k.title + '：' + st.topicAnswers[k.key] : ''
    ).filter(Boolean).join('\n');

    const prompt = '请为一部' + st.picks.genre + '小说重新搭一套骨架。\n\n'
        + '题材：' + st.picks.genre + '\n风格：' + st.picks.style + '\n'
        + (kp ? '作者已定的关键点：\n' + kp + '\n' : '')
        + (st.sourceNovel && st.sourceNovel.idea ? '原来的想法（可以沿用或改写）：' + st.sourceNovel.idea + '\n' : '')
        + `\n要求：
1. 大纲 12-15 章，每章写清「发生了什么变化」。
2. 角色 3-5 个，主角有具体身份、想要什么、被什么困住。
3. 世界观 2-3 条会影响剧情的规则。
4. highlights 6 条，行名按题材决定。
5. 书名给 1 个最合适的（这次换方向了，旧书名不再适用）。
6. opening：第一章开篇建议，120 字以内，不写正文。

只输出 JSON，不要 markdown 代码块：
{
  "title": "书名",
  "outline": [{"chapter": 1, "title": "章名", "summary": "本章变化"}],
  "characters": [{"name": "", "role": "主角", "description": ""}],
  "worldbuilding": "",
  "synopsis": "",
  "highlights": [{"label": "", "value": ""}],
  "opening": ""
}`;

    let plan = null;
    try {
        const raw = await ai.chat([
            { role: 'system', content: '你是网文策划编辑，产出要具体到能直接开写。' },
            { role: 'user', content: prompt }
        ], null, 4000);
        plan = parseJsonLoose(raw, '{', '}', (v) =>
            v && typeof v === 'object' && !Array.isArray(v) && 'outline' in v);
    } catch (_) { plan = null; }

    if (!plan || !Array.isArray(plan.outline) || !plan.outline.length) {
        guideSetBusy('');
        addChatMessage('ai', '这次没搭出来（网络或返回格式的问题）。原设定没动，可以再试一次。', []);
        return;
    }

    guideSetBusy('正在保存…');
    try {
        const saved = await guideApplyReplan(st, plan);
        guideSetBusy('');
        guidePushHtml(renderSettingSummary(plan, { title: saved.title, genre: st.picks.genre, style: st.picks.style }, saved.id));
        addChatMessage('ai', '已经按新方向重搭好了。旧的大纲、角色、世界观都换掉了，正文没动。', []);
        const box = document.getElementById('chat-messages');
        if (box) {
            const d = document.createElement('div');
            d.className = 'msg-row ai guide-stack';
            d.innerHTML = '<div class="guide-actions">'
                + '<button class="guide-act primary" onclick="guideStartWriting(\'' + escapeJs(saved.id) + '\')">'
                + (plan.opening ? '按这个写第一章' : '直接写第一章') + '</button>'
                + '<button class="guide-act" onclick="guideOpenDetail(\'' + escapeJs(saved.id) + '\')">查看作品</button>'
                + '</div>';
            box.appendChild(d);
        }
        syncComposerPadding();
        const sc = document.querySelector('.chat-scroll');
        if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (e) {
        guideSetBusy('');
        addChatMessage('ai', '保存失败：' + e.message, []);
    }
}

// 覆盖原书（无正文时），或另存一本新书（有正文时）
async function guideApplyReplan(st, plan) {
    let novel;
    if (st.targetNovelId) {
        novel = await novelManager.get(st.targetNovelId);
    } else {
        novel = await novelManager.create(plan.title || '未命名', plan.synopsis || '', st.picks.genre);
    }

    novel.title = plan.title || novel.title;
    novel.genre = st.picks.genre;
    novel.style = st.picks.style;
    novel.description = plan.synopsis || '';
    novel.highlights = Array.isArray(plan.highlights) ? plan.highlights.slice(0, 10) : [];
    novel.opening = String(plan.opening || '');
    novel.outline = Array.isArray(plan.outline) ? plan.outline : [];
    await novelManager.update(novel);

    // 角色和世界观整批换掉：旧的是按旧方向编的，留着只会打架
    const olds = await novelManager.listCharacters(novel.id).catch(() => []);
    for (const c of olds) await db.delete('characters', c.id).catch(() => {});
    const oldWb = await novelManager.listWorldbuilding(novel.id).catch(() => []);
    for (const w of oldWb) await db.delete('worldbuilding', w.id).catch(() => {});

    for (const c of (plan.characters || [])) {
        if (!c || !c.name) continue;
        try {
            await novelManager.createCharacter(novel.id, {
                name: c.name, role: c.role || '',
                description: c.description || '', personality: c.description || ''
            });
        } catch (_) {}
    }
    if (plan.worldbuilding) {
        try {
            await novelManager.createWorldbuilding(novel.id, {
                title: '世界观', category: 'other', content: String(plan.worldbuilding)
            });
        } catch (_) {}
    }
    return novel;
}

// 导出 Markdown：把总览、角色、世界观、大纲合成一份，等价于别人的「小说资料/」文件夹
async function exportSettingDoc(novelId) {
    try {
        const novel = await novelManager.get(novelId);
        if (!novel) return;
        const chars = await novelManager.listCharacters(novelId).catch(() => []);
        const wbs = await novelManager.listWorldbuilding(novelId).catch(() => []);
        const outline = (novel.outline || []);

        const L = [];
        L.push('# ' + (novel.title || '未命名'), '');
        if (novel.genre || novel.style) L.push('> ' + [novel.genre, novel.style].filter(Boolean).join(' · '), '');
        if (novel.description) L.push('## 一句话', '', novel.description, '');

        if ((novel.highlights || []).length) {
            L.push('## 设定总览', '');
            novel.highlights.forEach(h => L.push('- **' + (h.label || '') + '**：' + (h.value || '')));
            L.push('');
        }
        if (chars.length) {
            L.push('## 角色', '');
            chars.forEach(c => L.push('- **' + (c.name || '') + '**（' + (c.role || '角色') + '）：' + (c.description || c.personality || '')));
            L.push('');
        }
        if (wbs.length) {
            L.push('## 世界观', '');
            wbs.forEach(w => L.push('- **' + (w.title || '') + '**：' + (w.content || '')));
            L.push('');
        }
        if (outline.length) {
            L.push('## 大纲', '');
            outline.forEach(o => L.push((o.chapter || '') + '. **' + (o.title || '') + '**：' + (o.summary || '')));
            L.push('');
        }
        if (novel.opening) L.push('## 第一章开篇建议', '', novel.opening, '');

        const blob = new Blob([L.join('\n')], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (novel.title || '设定') + '-设定.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        ui.showToast('已导出设定文档');
    } catch (e) {
        ui.showToast('导出失败：' + e.message);
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

const SEVERITY_LABEL = { S1: '致命', S2: '严重', S3: '一般', S4: '建议' };
const REVIEW_CATEGORY_LABEL = {
    structure: '结构', character: '人物', prose: '文笔',
    pacing: '节奏', dialogue: '对话', hook: '钩子',
    consistency: '一致性', factual: '事实', causal: '因果'
};

// 渲染结构化审稿结果。每条都带原文引用与段落号 —— 不给"具体哪里"的建议，
// 用户没法改；能给到段，才谈得上可执行。
function renderReviewFindings(findings, content) {
    if (!findings.length) {
        return `<div class="review-empty">没发现明显问题。<br><span class="review-empty-sub">可以换个角度再跑一次，或直接往下写。</span></div>`;
    }
    return `<div class="review-list">` + findings.map(f => {
        const para = locateQuoteParagraph(content, f.quote);
        return `<div class="review-item sev-${f.severity.toLowerCase()}">
            <div class="review-head">
                <span class="review-badge">${f.severity} ${SEVERITY_LABEL[f.severity] || ''}</span>
                <span class="review-cat">${REVIEW_CATEGORY_LABEL[f.category] || escapeHtml(f.category)}</span>
                ${para ? `<span class="review-loc">第 ${para} 段</span>` : ''}
            </div>
            ${f.quote ? `<div class="review-quote">「${escapeHtml(f.quote)}」</div>` : ''}
            <div class="review-issue">${escapeHtml(f.issue)}</div>
            ${f.fix ? `<div class="review-fix">改法：${escapeHtml(f.fix)}</div>` : ''}
        </div>`;
    }).join('') + `</div>`;
}

// ===== 人名检查（纯本地，不调用模型）=====
// 正文里写到新角色，但角色库没有他 —— 后面 AI 续写会把他当陌生人写，
// 前后设定也就对不上了。这里用规则找出来，零成本。
// 没有 NLP 库，靠两条信号：姓氏开头 + 后面跟动作词（"X说""X道""X看着他"）。
// 宁可漏，不可误报：环境描写里那些"高兴""石头""林子"必须一个都不出来。

const NAME_SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛段雷侯龙史陶黎贺顾毛郝龚邵万钱严武戴莫孔向汤';
const NAME_DOUBLE = ['欧阳', '司马', '上官', '慕容', '令狐', '独孤', '南宫', '东方', '西门', '百里', '轩辕', '皇甫', '尉迟', '长孙', '宇文', '夏侯', '公孙'];
const NAME_ACTION = ['说', '道', '问', '答', '笑', '哭', '喊', '叫', '看着', '看见', '看了眼', '回头',
    '点头', '摇头', '转身', '抬手', '皱眉', '沉默', '开口', '回答', '低声', '忽然', '抬头', '低头',
    '叹了口气', '愣了', '站起', '坐下', '走过', '进来', '出去', '想了想', '沉声', '轻笑', '冷哼', '脸色'];
const NAME_STOP = new Set(('高兴 高手 高级 高度 高大 高音 高峰 白色 白天 白发 白菜 石头 石阶 石门 ' +
    '时辰 时候 方向 方式 方案 方法 江山 江湖 江水 江南 马上 马车 马路 叶子 程度 程序 ' +
    '黄金 黄色 木头 木门 林木 林中 林子 白云 白日 朱红 朱砂 胡同 胡说 何时 何必 何处 ' +
    '余光 余地 余下 汪洋 范围 于今 林中 于是'
).split(/\s+/).filter(Boolean));

function detectUnknownNames(text, knownNames) {
    const known = new Set(knownNames || []);
    const chars = Array.from(String(text || ''));
    const hits = new Map();

    const add = (name, pos) => {
        if (NAME_STOP.has(name)) return;
        const arr = hits.get(name) || [];
        arr.push(pos);
        hits.set(name, arr);
    };

    for (let i = 0; i < chars.length; i++) {
        let pre = '';
        for (const d of NAME_DOUBLE) {
            if (chars.slice(i, i + d.length).join('') === d) { pre = d; break; }
        }
        if (!pre && NAME_SURNAMES.includes(chars[i])) pre = chars[i];

        if (pre) {
            for (const extra of [1, 2]) {
                const len = pre.length + extra;
                if (i + len > chars.length) continue;
                add(chars.slice(i, i + len).join(''), i);
            }
        } else if ('老小阿'.includes(chars[i]) && i + 2 <= chars.length) {
            add(chars.slice(i, i + 2).join(''), i);   // 老周、小满、阿七
        }
    }

    const scored = [];
    for (const [name, positions] of hits) {
        if (known.has(name)) continue;
        const len = Array.from(name).length;
        let strong = 0;
        for (const pos of positions) {
            const after = chars.slice(pos + len, pos + len + 3).join('');
            if (NAME_ACTION.some(a => after.startsWith(a))) strong++;
        }
        scored.push({ name, total: positions.length, strong });
    }

    // 「李青」是「李青云」的前缀，后者信号不弱时把短的丢掉，避免切出半个名字
    const kept = scored.filter(a => !scored.some(b =>
        b.name !== a.name && b.name.startsWith(a.name) && b.strong >= a.strong && b.total >= a.total
    ));

    return kept
        .filter(x => x.strong >= 2 || (x.strong >= 1 && x.total >= 3))
        .sort((a, b) => b.strong - a.strong || b.total - a.total)
        .slice(0, 8);
}

async function checkChapterNames(novelId, chapterNum) {
    try {
        const chapter = await novelManager.getChapter(novelId, chapterNum);
        if (!chapter || !chapter.content) { ui.showToast('本章还没有正文'); return; }
        const chars = await novelManager.listCharacters(novelId);
        const known = (chars || []).map(c => c.name).filter(Boolean);
        const found = detectUnknownNames(chapter.content, known);

        if (!found.length) {
            ui.showToast('正文里的人名都在角色库里了', 3000);
            return;
        }

        window.__nameCandidates = found;
        const body = `
            <div class="name-check-note">正文里有 ${found.length} 个名字不在角色库。
            加进去之后，续写时 AI 才会把他们当"认识的人"写。</div>
            <div class="name-check-list">
                ${found.map((f, i) => `
                    <label class="name-check-item">
                        <input type="checkbox" class="name-check-box" data-idx="${i}" checked>
                        <span class="name-check-name">${escapeHtml(f.name)}</span>
                        <span class="name-check-count">出现 ${f.total} 次</span>
                    </label>`).join('')}
            </div>
            <div class="modal-actions">
                <button class="btn btn-outline" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="addNamesToCharacters('${escapeJs(novelId)}', ${chapterNum})">加入角色库</button>
            </div>`;
        createModal('人名检查 · 第' + chapterNum + '章', body).show();
    } catch (e) {
        ui.showToast('检查失败：' + e.message);
    }
}

async function addNamesToCharacters(novelId, chapterNum) {
    const list = window.__nameCandidates || [];
    const picked = [];
    document.querySelectorAll('.name-check-box').forEach(c => {
        if (c.checked) picked.push(Number(c.dataset.idx));
    });
    if (!picked.length) { ui.showToast('一个都没选'); return; }

    let added = 0;
    try {
        for (const i of picked) {
            const it = list[i];
            if (!it) continue;
            await novelManager.createCharacter(novelId, {
                name: it.name,
                role: '配角',
                description: `第 ${chapterNum} 章正文里出现过 ${it.total} 次，待补充设定`
            });
            added++;
        }
        closeModal();
        window.__nameCandidates = null;
        ui.showToast(`已加入 ${added} 个角色，可以到角色卡里补充设定`);
    } catch (e) {
        ui.showToast('加入失败：' + e.message);
    }
}

// ===== 章节体检（纯本地，不调用模型）=====
// 这里的阈值来自几个开源写作 skill 的实测值（MIT），只取数字与判定逻辑，文案重写。
// 为什么不做成 AI 检查：字数、对话占比、破折号、口水词这些是确定性的，
// 让模型去数数是浪费钱且不可靠 —— 本地算完秒出，还能每章都跑。
const CHECK_RULES = {
    chars: { min: 1500, idealMin: 1800, idealMax: 2600, max: 3000 },
    dialogue: { min: 15, max: 40, combatMax: 30 },
    dash: { max: 2 },
    halfQuote: { max: 0 },
    notXisY: { max: 2 },
    paragraph: { maxLen: 300, maxCount: 0 },
    meta: { max: 0 }
};

// 只统计中文字符，标点与空白不算 —— 平台的"字数"通常也按这个口径
function countCJK(text) {
    return (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
}

// 对话行判定：以引号开头就算。手机输入法常用「」和""，
// 这里都认，但要单独统计半角引号（平台排版一般要求全角）
function analyzeText(content) {
    const text = String(content || '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const total = lines.length || 1;

    const dialogueLines = lines.filter(l => /^[「『“"]/.test(l)).length;
    const dialogueRatio = Math.round(dialogueLines / total * 100);

    const dashes = (text.match(/—/g) || []).length;
    const halfQuotes = (text.match(/[""]/g) || []).length;
    const notXisY = (text.match(/不是[^。！？\n]{2,30}[，—]是/g) || []).length;
    const exclaims = (text.match(/[！!]/g) || []).length;
    const metaHits = (text.match(/(本章|前文|后文|卷一|这一章里)/g) || []).length;
    const longParas = lines.filter(l => l.length > CHECK_RULES.paragraph.maxLen);

    // AI 高频口水词：出现不等于错，但密度高就是味儿
    const AI_WORDS = ['缓缓', '不由得', '眼底闪过', '心中升起', '说不出的', '这意味着',
                      '深邃', '不可置信', '仿佛', '犹如', '一丝', '微微', '轻轻', '淡淡',
                      '然而', '因此', '似乎', '显然'];
    const aiHits = AI_WORDS
        .map(w => ({ word: w, count: text.split(w).length - 1 }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count);

    // 句长方差：相邻三句长度接近 = 节奏匀速。比"句号密度"更稳
    const sentences = text.split(/[。！？…]+/).map(x => x.trim()).filter(x => x.length > 1);
    let flatRuns = 0;
    for (let i = 2; i < sentences.length; i++) {
        const a = sentences[i - 2].length, b = sentences[i - 1].length, c = sentences[i].length;
        if (Math.abs(a - b) <= 3 && Math.abs(b - c) <= 3) flatRuns++;
    }

    return {
        chars: countCJK(text),
        dialogueRatio, dialogueLines, totalLines: total,
        dashes, halfQuotes, notXisY, exclaims,
        metaHits, longParas: longParas.length,
        aiHits, aiTotal: aiHits.reduce((s, x) => s + x.count, 0),
        flatRuns
    };
}

// 把指标翻译成"合格 / 注意 / 超标"，并给出人话建议
function buildCheckResults(m) {
    const rows = [];
    const push = (label, value, state, hint) => rows.push({ label, value, state, hint });
    const R = CHECK_RULES;

    const c = m.chars;
    if (c < R.chars.min) push('字数', c, 'bad', `低于 ${R.chars.min}，多数平台算短章，可能影响推荐`);
    else if (c < R.chars.idealMin) push('字数', c, 'warn', `偏短，建议 ${R.chars.idealMin}–${R.chars.idealMax}`);
    else if (c <= R.chars.idealMax) push('字数', c, 'ok', '在本章常规区间内');
    else if (c <= R.chars.max) push('字数', c, 'warn', `偏长，超过 ${R.chars.max} 建议拆章`);
    else push('字数', c, 'bad', `超长，读者容易跳读，建议拆成两章`);

    const d = m.dialogueRatio;
    if (d > R.dialogue.max) push('对话占比', d + '%', 'bad', `超过 ${R.dialogue.max}%，叙事被对话挤掉，容易变成"两个人聊天"`);
    else if (d >= 25) push('对话占比', d + '%', 'ok', '在健康区间');
    else if (d >= R.dialogue.min) push('对话占比', d + '%', 'warn', '偏少，画面偏旁白');
    else push('对话占比', d + '%', 'warn', '几乎没有对话，读起来会闷');

    if (m.dashes > R.dash.max) push('破折号', m.dashes, 'warn', `超过 ${R.dash.max} 个，AI 写作的典型痕迹之一`);
    else push('破折号', m.dashes, 'ok', '');

    if (m.halfQuotes > 0) push('半角引号', m.halfQuotes, 'warn', '对话统一用「」，平台排版更整齐');
    if (m.notXisY > R.notXisY.max) push('"不是X，是Y"句式', m.notXisY, 'warn', '排比式对仗，超过 2 处很像 AI 腔');
    if (m.metaHits > 0) push('元话语', m.metaHits, 'bad', '出现"本章/前文/卷一"，这是作者在说话，不是角色在经历');
    if (m.longParas > 0) push('超长段落', m.longParas, 'warn', `有 ${m.longParas} 段超过 ${R.paragraph.maxLen} 字，手机上一屏读不完`);
    if (m.flatRuns >= 3) push('句式节奏', m.flatRuns + ' 处匀速', 'warn', '连续三句长度接近，读起来像流水账，试着插一个短句');

    if (m.aiTotal > 0) {
        const top = m.aiHits.slice(0, 6).map(x => `${x.word}×${x.count}`).join('、');
        const state = m.aiTotal > 12 ? 'bad' : 'warn';
        push('AI 高频词', m.aiTotal, state, top + (m.aiHits.length > 6 ? ' 等' : ''));
    } else {
        push('AI 高频词', 0, 'ok', '');
    }
    return rows;
}

async function checkChapterLocal(novelId, chapterNum) {
    try {
        const chapter = await novelManager.getChapter(novelId, chapterNum);
        if (!chapter || !chapter.content) { ui.showToast('本章还没有正文'); return; }
        const m = analyzeText(chapter.content);
        const rows = buildCheckResults(m);
        const bad = rows.filter(r => r.state === 'bad').length;
        const warn = rows.filter(r => r.state === 'warn').length;

        const label = { ok: '合格', warn: '注意', bad: '超标' };
        const body = `
            <div class="check-summary ${bad ? 'has-bad' : warn ? 'has-warn' : 'all-ok'}">
                ${bad ? `${bad} 项超标` : warn ? `${warn} 项值得看一眼` : '全部指标正常'}
                <span class="check-sub">共 ${m.chars} 字 · ${m.totalLines} 段 · 对话占 ${m.dialogueRatio}%</span>
            </div>
            <div class="check-list">
                ${rows.map(r => `
                    <div class="check-row st-${r.state}">
                        <span class="check-name">${r.label}</span>
                        <span class="check-val">${escapeHtml(String(r.value))}</span>
                        <span class="check-tag">${label[r.state]}</span>
                        ${r.hint ? `<div class="check-hint">${escapeHtml(r.hint)}</div>` : ''}
                    </div>`).join('')}
            </div>
            <div class="check-foot">纯本地计算，不消耗模型额度。判定阈值参考公开写作规范，只作提示，不是平台官方标准。</div>`;

        createModal(`章节体检 · 第${chapterNum}章`, body).show();
    } catch (e) {
        ui.showToast('体检失败: ' + e.message);
    }
}

async function reviewThisChapter(novelId, chapterNum) {
    try {
        const novel = await novelManager.get(novelId);
        const chapter = await novelManager.getChapter(novelId, chapterNum);
        if (!chapter) { ui.showToast('章节不存在'); return; }

        ui.showToast('AI 正在审稿...');
        const review = await ai.reviewChapter(chapter.content, novel, chapterNum);

        // findings 为 null = 模型没按约定吐 JSON。这时原样展示，别把内容吞掉。
        const body = review.findings
            ? renderReviewFindings(review.findings, chapter.content)
            : `<div class="review-raw">${escapeHtml(review.raw || '')}</div>`;

        createModal(`AI 审稿 · 第${chapterNum}章`, body).show();
    } catch (err) {
        ui.showToast('审稿失败: ' + err.message);
    }
}

// ===== 章节设定抽取 → 人工确认 → 写回 =====
// 为什么一定要人工确认：设定库里混进一条编造的内容，后面每一章都会带着它写，
// 而且越滚越像真的。宁可多点一次，也不自动写。

const EXTRACT_WB_LABEL = {
    map: '地图与地理', faction: '势力与组织', timeline: '时间线与历史',
    rule: '规则与法则', research: '参考资料', other: '其他设定'
};

function parseExtraction(text) {
    // 校验必须看到抽取结果的标志字段，否则可能咬到正文里的示例 JSON
    const o = parseJsonLoose(text, '{', '}', (v) =>
        v && typeof v === 'object' && !Array.isArray(v) &&
        ('summary' in v || 'characters' in v || 'world' in v || 'foreshadow' in v || 'conflicts' in v));
    if (!o) return null;
    {
        const arr = (v) => Array.isArray(v) ? v : [];
        const conf = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
        };
        const CATS = ['map', 'faction', 'timeline', 'rule', 'research', 'other'];
        return {
            summary: String(o.summary || '').trim(),
            characters: arr(o.characters)
                .filter(x => x && x.name && x.status)
                .map(x => ({ name: String(x.name).trim(), status: String(x.status).trim(), confidence: conf(x.confidence) })),
            world: arr(o.world)
                .filter(x => x && x.title)
                .map(x => ({
                    title: String(x.title).trim(),
                    category: CATS.includes(String(x.category)) ? String(x.category) : 'other',
                    content: String(x.content || '').trim(),
                    confidence: conf(x.confidence)
                })),
            foreshadow: arr(o.foreshadow)
                .filter(x => x && x.description)
                .map(x => ({
                    description: String(x.description).trim(),
                    targetChapter: Math.max(1, Number(x.targetChapter) || 0),
                    confidence: conf(x.confidence)
                })),
            harvested: arr(o.harvested).map(x => String(x || '').trim()).filter(Boolean),
            conflicts: arr(o.conflicts)
                .filter(x => x && x.with)
                .map(x => ({ with: String(x.with).trim(), evidence: String(x.evidence || '').trim(), confidence: conf(x.confidence) }))
        };
    }
}

async function extractChapterSettings(novelId, chapterNum) {
    try {
        const novel = await novelManager.get(novelId);
        const chapter = await novelManager.getChapter(novelId, chapterNum);
        if (!chapter || !chapter.content) { ui.showToast('本章还没有正文'); return; }

        ui.showToast('AI 正在提取设定...', 3000);
        const r = await ai.extractChapterFacts(novel, chapter, chapterNum);
        if (!r.data) {
            createModal('提取失败', `<div class="review-raw">${escapeHtml(r.raw || '模型没有返回可解析的内容')}</div>`).show();
            return;
        }
        // 留一份，关掉弹窗还能再打开（重新提取要再花一次钱）
        try { await settings.set(`extract_${novelId}_${chapterNum}`, r.data); } catch (_) {}
        renderExtractModal(r.data, novelId, chapterNum);
    } catch (e) {
        ui.showToast('提取失败: ' + e.message, 4000);
    }
}

function renderExtractModal(data, novelId, chapterNum) {
    window.__extractData = data;
    const confTag = (c) => c >= 0.8 ? '' : `<span class="ex-conf low">置信 ${Math.round(c * 100)}%</span>`;

    const group = (key, label, items, render) => {
        if (!items.length) return '';
        return `<div class="ex-group"><div class="ex-group-title">${label}（${items.length}）</div>` +
            items.map((it, i) => `
                <label class="ex-item">
                    <input type="checkbox" class="ex-check" data-key="${key}" data-idx="${i}" checked>
                    <span class="ex-body">${render(it)}${confTag(it.confidence || 0.5)}</span>
                </label>`).join('') + `</div>`;
    };

    const total = data.characters.length + data.world.length + data.foreshadow.length;
    // 外层包一个 id：createModal 允许叠加，closeModal 只关最上面那个，
    // 直接 querySelectorAll('.ex-check') 会读到还没关掉的旧弹窗里的勾选。
    const html = `<div id="ex-root">
        ${data.summary ? `<div class="ex-group">
            <div class="ex-group-title">本章摘要（写进章节，供后续章节当上下文）</div>
            <label class="ex-item"><input type="checkbox" class="ex-check" data-key="summary" checked>
                <span class="ex-body">${escapeHtml(data.summary)}</span></label>
        </div>` : ''}
        ${group('characters', '角色状态', data.characters, c => `<b>${escapeHtml(c.name)}</b>　${escapeHtml(c.status)}`)}
        ${group('world', '世界观', data.world, w => `<b>${escapeHtml(w.title)}</b><span class="ex-cat">${EXTRACT_WB_LABEL[w.category] || w.category}</span><br>${escapeHtml(w.content)}`)}
        ${group('foreshadow', '伏笔', data.foreshadow, f => `${escapeHtml(f.description)}${f.targetChapter ? `<span class="ex-cat">计划第 ${f.targetChapter} 章回收</span>` : ''}`)}
        ${group('harvested', '本章回收的伏笔', data.harvested, h => escapeHtml(h))}
        ${data.conflicts.length ? `<div class="ex-group ex-conflict">
            <div class="ex-group-title">与已有设定冲突（仅提示，不会自动改）</div>
            ${data.conflicts.map(c => `<div class="ex-item ex-static"><span class="ex-body"><b>${escapeHtml(c.with)}</b><br>${escapeHtml(c.evidence)}</span></div>`).join('')}
        </div>` : ''}
        ${total === 0 && !data.summary ? '<div class="review-empty">这一章没有可提取的新设定。</div>' : ''}
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="applyExtraction('${escapeJs(novelId)}', ${chapterNum})">采纳选中项</button>
        </div>
    </div>`;
    createModal(`提取设定 · 第${chapterNum}章`, html).show();
}

async function applyExtraction(novelId, chapterNum) {
    const data = window.__extractData;
    if (!data) { ui.showToast('没有可写入的内容'); return; }

    const picked = { summary: false, characters: [], world: [], foreshadow: [], harvested: [] };
    // 取最后一个：弹窗按顺序挂到 DOM 上，叠加时最后一个才是用户正在看的那层
    const roots = document.querySelectorAll('#ex-root');
    const root = roots.length ? roots[roots.length - 1] : null;
    if (!root) { ui.showToast('弹窗已关闭'); return; }
    root.querySelectorAll('.ex-check').forEach(c => {
        if (!c.checked) return;
        const k = c.dataset.key;
        if (k === 'summary') { picked.summary = true; return; }
        if (picked[k]) picked[k].push(Number(c.dataset.idx));
    });

    let applied = 0, skipped = 0;
    try {
        // 摘要只在原本为空时写入，不覆盖用户手写的
        if (picked.summary && data.summary) {
            const ch = await novelManager.getChapter(novelId, chapterNum);
            if (ch && !ch.summary) { await novelManager.saveChapterSummary(novelId, chapterNum, data.summary); applied++; }
            else skipped++;
        }

        if (picked.characters.length) {
            const chars = await novelManager.listCharacters(novelId);
            for (const i of picked.characters) {
                const it = data.characters[i];
                const exist = chars.find(c => (c.name || '').trim() === it.name);
                if (exist) {
                    const cur = exist.currentStatus || '';
                    if (cur.includes(it.status)) { skipped++; continue; }
                    await novelManager.updateCharacter(exist.id, { currentStatus: cur ? `${cur}；${it.status}` : it.status });
                    applied++;
                } else {
                    await novelManager.createCharacter(novelId, { name: it.name, currentStatus: it.status });
                    applied++;
                }
            }
        }

        if (picked.world.length) {
            const wbs = await novelManager.listWorldbuilding(novelId);
            for (const i of picked.world) {
                const it = data.world[i];
                if (wbs.some(w => (w.title || '').trim() === it.title)) { skipped++; continue; }
                await novelManager.createWorldbuilding(novelId, { title: it.title, category: it.category, content: it.content });
                applied++;
            }
        }

        if (picked.foreshadow.length) {
            const fs = await novelManager.listForeshadowing(novelId);
            for (const i of picked.foreshadow) {
                const it = data.foreshadow[i];
                if (fs.some(f => (f.description || '').trim() === it.description)) { skipped++; continue; }
                await novelManager.createForeshadowing(novelId, {
                    description: it.description,
                    plantChapter: chapterNum,
                    targetChapter: it.targetChapter || chapterNum + 3,
                    status: 'planted'
                });
                applied++;
            }
        }

        // 回收：用关键词去匹配已埋伏笔，匹配不到就跳过（不做模糊创造）
        if (picked.harvested.length) {
            const fs = await novelManager.listForeshadowing(novelId);
            for (const i of picked.harvested) {
                const key = data.harvested[i];
                const hit = fs.find(f => (f.status || 'planted') === 'planted' && f.description && f.description.includes(key));
                if (hit) { await novelManager.updateForeshadowing(hit.id, { status: 'harvested' }); applied++; }
                else skipped++;
            }
        }

        closeModal();
        ui.showToast(`已写入 ${applied} 条${skipped ? `，跳过 ${skipped} 条（已存在或无匹配）` : ''}`, 4500);
        if (store.currentPage === 'chapterEdit') {
            const view = document.getElementById('page-chapterEdit');
            if (view) renderChapterEdit(view, novelId, chapterNum);
        }
    } catch (e) {
        ui.showToast('写入失败: ' + e.message, 4000);
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
        const friendlyProvider = detectProvider(model);
        const hasKey = apiKey ? ' ✅已配置' : ' ❌未配置';
        const displayText = `${friendlyProvider} · ${model || '未选'}${hasKey}`;
        
        await settings.setModelConfig({
            // provider 只用于设置页回显，判断走哪个接口一律看 baseUrl
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
// 书脊配色：按书名哈希固定取一组，同一本书每次都同色，不同书不同色。
// 原来的封面是统一灰底 + 首字，四本书摆在一起完全分不出谁是谁。
// 色相按 36° 均匀铺开。原来六个色里三个偏棕，四本书摆出来有两本看着一样。
const COVER_TONES = [
    ['#8A4E3C', '#F2E7E2'],   // 赭红
    ['#7A6335', '#F2EDDF'],   // 土黄
    ['#5A6638', '#EDF0E0'],   // 苔绿
    ['#3E6647', '#E4EFE6'],   // 松绿
    ['#35635A', '#E1EFEC'],   // 青碧
    ['#35566B', '#E3ECF1'],   // 靛青
    ['#3B4A72', '#E6E8F2'],   // 藏蓝
    ['#52407A', '#EBE7F3'],   // 紫檀
    ['#6E3F6B', '#F0E6EF'],   // 绛紫
    ['#7A3E54', '#F2E6EA']    // 梅红
];
function coverTone(title) {
    const str = String(title || '书');
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.codePointAt(i)) % 9973;
    return COVER_TONES[h % COVER_TONES.length];
}

// 字数：一万以内给具体数，以上换成"万字"，书架上一眼能比大小
function fmtWords(n) {
    const v = Number(n) || 0;
    if (v < 10000) return `${v.toLocaleString()} 字`;
    return `${(v / 10000).toFixed(v < 100000 ? 1 : 0)} 万字`;
}

function formatDate(timestamp) {
    if (!timestamp) return '未知';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 259200000) return `${Math.floor(diff / 86400000)}天前`;
    // 统一成「10月14日」。toLocaleDateString 会给 2026/10/14，小字号里又长又难读；
    // 跨年才带年份，否则书架上一半是日期一半是"3天前"，看起来像没对齐。
    if (date.getFullYear() !== now.getFullYear()) {
        return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    }
    return `${date.getMonth() + 1}月${date.getDate()}日`;
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

// 内联 onclick 的字符串参数专用，不能拿 escapeHtml 顶替。
// escapeHtml 把 ' 转成 &#39;，但浏览器解析属性值时会把它解码回一个裸单引号，
// 最终进 JS 的仍是 fn('O'Brien') —— 字符串被截断，按钮点不动（甚至可被构造成注入）。
// 这里直接输出 JS 转义序列；HTML 特殊字符另外处理，保证属性本身不被提前闭合。
function escapeJs(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
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
    // Web/PWA：页面栈与浏览器历史同步维护（见 navigateTo），有历史就交给 history.back()，
    // 由 popstate 统一处理；否则两条栈会各退一次，点一次回到两页之前。
    // 原生壳：返回键由 backButton 接管，这里保持原来的手写回退，避免双退。
    if (!isNativeApp() && pageHistory.length > 0) {
        try { history.back(); return; } catch (_) { /* 不支持时退回下面的手写逻辑 */ }
    }
    const prev = pageHistory.pop();
    if (!prev || !prev.page) {
        if (store.currentPage !== fallback) navigateTo(fallback, {}, true);
        return;
    }
    const isRoot = ROOT_PAGES.includes(prev.page);
    __suppressHistoryPush = !isRoot;
    navigateTo(prev.page, prev.params || {}, isRoot);
}

// Web 端（浏览器 / PWA）的系统返回键与侧滑手势：浏览器已经退掉一条历史，
// 这里把它翻译成页面栈的一次回退。注意不能再 pushState，否则会立刻把用户顶回去。
window.addEventListener('popstate', () => {
    if (isNativeApp()) return;
    const prev = pageHistory.pop();
    if (!prev || !prev.page) {
        // 栈里没有对应页面，但浏览器已经退掉一条历史（切换底部 tab 时
        // replaceState 会留下这种状态）。旧实现直接 return：界面不动、历史却退了，
        // 用户再按一次就直接退出应用，感觉像"返回键坏了"。
        // 这里把当前页重新压回历史，保证「按一次返回 = 退一格」的直觉。
        try { history.pushState({ owNav: store.currentPage }, ''); } catch (_) {}
        __suppressHistoryPush = false;
        return;
    }
    __suppressHistoryPush = true;
    navigateTo(prev.page, prev.params || {}, ROOT_PAGES.includes(prev.page));
});

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
    // 先恢复上次在聊的会话，再进聊天页——否则重开 App 会把 currentSessionId 重置成 'main'，
    // 用户看到的是一个空会话，之前那段对话就像被清掉了
    restoreChatSessionId();
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
    rememberChatSession('chat_' + Date.now());
    store.activeChatSkill = null;
    closeChatDrawer();
    navigateTo('chat');
}

async function switchChatSession(sessionId) {
    __chatRestoreSeq++;   // 作废 renderChat 里还没回来的自动恢复
    rememberChatSession(sessionId);
    closeChatDrawer();
    navigateTo('chat');

    // 加载该会话的消息（渲染逻辑与 renderChat 的自动恢复共用 paintChatMessages）
    try {
        const msgs = await db.getAll('messages', 'sessionId', sessionId);
        if (store.currentPage !== 'chat') return;
        paintChatMessages(document.getElementById('page-chat'), msgs.sort((a, b) => (a.created || 0) - (b.created || 0)));
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
            rememberChatSession('chat_' + Date.now());
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
    // 以前这里强制要求页面里存在 #page-chat，不存在就直接 return ——
    // 从设置页、书架点「备忘录」时表现就是「点了没反应」。备忘录是全局功能，
    // 弹窗渲染在 modal 层，跟当前在哪个页面无关。
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
            // 批量同步不逐章走 saveChapter：它每次都重算作品统计（O(n) 读 + 整条 novel 重写），
            // 而且会在覆盖前归档旧版本——一次同步几十章就等于塞几十份全文快照进 IndexedDB。
            const updated = Object.assign({}, ch, {
                content: newContent,
                wordCount: newContent.length,
                updated: Date.now()
            });
            delete updated.paragraphs;   // 同上：段落缓存作废
            await db.put('chapters', updated);
        }
    }

    if (replacedCount) await novelManager.recountNovelStats(novelId);

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

// ===== 全书节奏总览（纯本地）=====
// 单章节拍只能看出"这一章怎么走"，看不出"整本书什么时候才有高潮"。
// 这里把每章的节拍占比堆成一条条，一眼能看到：前五章全是浅色（铺陈），
// 或者中间连着七八章没有深色（高潮）。
const PACE_COLORS = {
    setup: '#CFC7B8',
    transition: '#E3DCCD',
    conflict: '#8B7F6C',
    climax: '#3A342C',
    hook: '#1A1714'
};

async function renderPacingOverview(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    ui.setPageTitle('节奏总览');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>`);

    const chapters = (await novelManager.listChapters(novelId)).sort((a, b) => a.number - b.number);
    if (!chapters.length) {
        container.innerHTML = '<div class="empty-state"><div class="empty-title">还没有章节</div>'
            + '<div class="empty-desc">先写出章节，再来看整体节奏</div></div>';
        return;
    }

    const beatsMap = novel.beats || {};
    const rows = chapters.map(ch => {
        const bs = (beatsMap[ch.number] || []).filter(b => b && (b.desc || b.content));
        if (!bs.length) return { num: ch.number, title: ch.title, empty: true };
        const sum = { setup: 0, transition: 0, conflict: 0, climax: 0, hook: 0 };
        bs.forEach(b => {
            const t = sum[b.type] !== undefined ? b.type : 'transition';
            sum[t] += Number(b.pct) || 0;
        });
        const total = Object.values(sum).reduce((a, b) => a + b, 0) || 1;
        // 第一次冲突/高潮出现在第几条（1 起算，0 = 整章都没有）
        const hotIdx = bs.findIndex(b => b.type === 'conflict' || b.type === 'climax') + 1;
        // 前三条是否全是铺垫/过渡
        const firstThree = bs.slice(0, 3);
        const slowThree = firstThree.length === 3 && firstThree.every(b => b.type === 'setup' || b.type === 'transition');
        return { num: ch.number, title: ch.title, sum, total, count: bs.length, firstHot: hotIdx, slowThree };
    });

    // 诊断：只说真问题，不凑数
    const issues = [];
    const noBeat = rows.filter(r => r.empty).map(r => r.num);
    if (noBeat.length) {
        issues.push({
            level: 'warn',
            text: '第 ' + fmtRange(noBeat) + ' 章没有节拍。写这些章时模型会自己拆场景，容易一章塞三四个转折。'
        });
    }

    const slowOpen = rows.filter(r => !r.empty && (r.slowThree || r.firstHot === 0)).map(r => r.num);
    if (slowOpen.length) {
        issues.push({
            level: 'warn',
            text: '第 ' + fmtRange(slowOpen) + ' 章前三条节拍都在铺垫（或者整章没有冲突），第一次冲突来得偏晚。'
        });
    }

    // 连续 4 章以上高潮占比 < 5%
    let run = [];
    const flushRun = () => {
        if (run.length >= 4) {
            issues.push({
                level: 'warn',
                text: '第 ' + fmtRange(run.map(r => r.num)) + ' 章连续没有高潮（climax 占比低于 5%），读者容易中途弃。'
            });
        }
        run = [];
    };
    rows.forEach(r => {
        if (r.empty) { flushRun(); return; }
        const c = (r.sum.climax / r.total) * 100;
        if (c < 5) run.push(r); else flushRun();
    });
    flushRun();

    // 钩子占比低于 3%（注意要先乘 100，这里比较的是百分比）
    const noHook = rows.filter(r => !r.empty && (r.sum.hook / r.total) * 100 < 3).map(r => r.num);
    if (noHook.length) {
        issues.push({
            level: 'info',
            text: '第 ' + fmtRange(noHook) + ' 章结尾没有钩子。平台看稿第一条就是「章末能不能留住人」。'
        });
    }

    const okAll = !issues.length;

    const barHtml = (r) => {
        if (r.empty) return '<div class="pace-bar pace-empty"></div>';
        const order = ['setup', 'transition', 'conflict', 'climax', 'hook'];
        return '<div class="pace-bar">' + order.map(k => {
            const w = (r.sum[k] / r.total) * 100;
            return w > 0 ? '<i style="width:' + w.toFixed(1) + '%;background:' + PACE_COLORS[k] + '"></i>' : '';
        }).join('') + '</div>';
    };

    container.innerHTML = `
        <div class="pace-page">
            <div class="pace-legend">
                ${[['setup', '铺陈'], ['transition', '过渡'], ['conflict', '冲突'], ['climax', '高潮'], ['hook', '钩子']]
                    .map(([k, label]) => '<span class="pace-key"><i style="background:' + PACE_COLORS[k] + '"></i>' + label + '</span>').join('')}
            </div>

            ${okAll ? '<div class="pace-ok">每章都有节拍，冲突和高潮分布也正常。</div>' : ''}
            ${issues.length ? '<div class="pace-issues">' + issues.map(i =>
                '<div class="pace-issue lv-' + i.level + '">' + escapeHtml(i.text) + '</div>').join('') + '</div>' : ''}

            <div class="pace-list">
                ${rows.map(r => `
                    <div class="pace-row${r.empty ? ' is-empty' : ''}">
                        <div class="pace-num">${r.num}</div>
                        <div class="pace-main">
                            <div class="pace-title">${escapeHtml((r.title || '').replace(CHAPTER_PREFIX_RE, '').trim() || '未命名')}</div>
                            ${barHtml(r)}
                        </div>
                        <div class="pace-meta">${r.empty ? '无节拍' : r.count + ' 拍'}</div>
                    </div>`).join('')}
            </div>

            <div class="pace-foot">只统计已保存的节拍。占比按每条节拍填的 pct 计算，不读正文。</div>
        </div>`;
}

// 只合并真正连续的章号。1、5、6 不能写成 "1–6"，
// 那样读者会以为 2、3、4 也缺节拍。
function fmtRange(nums) {
    const a = [...new Set(nums.filter(n => Number.isFinite(n)))].sort((x, y) => x - y);
    if (!a.length) return '';
    const groups = [];
    let start = a[0], prev = a[0];
    for (let i = 1; i < a.length; i++) {
        if (a[i] === prev + 1) { prev = a[i]; continue; }
        groups.push([start, prev]);
        start = prev = a[i];
    }
    groups.push([start, prev]);
    return groups.map(([s, e]) => (s === e ? String(s) : s + '–' + e)).join('、');
}

const BEAT_LABELS = { setup: '铺陈', conflict: '冲突', climax: '高潮', hook: '钩子', transition: '过渡' };

function beatRowHtml(b, i) {
    const t = b.type || 'transition';
    const opt = (v) => '<option value="' + v + '"' + (t === v ? ' selected' : '') + '>'
        + BEAT_LABELS[v] + '</option>';
    // 落地状态：写完对照后才有，存在内存里，不写库
    const f = b.fulfill;
    const statusHtml = f
        ? '<span class="beat-status st-' + f.status + '">'
          + (f.status === 'done' ? '已写' : f.status === 'partial' ? '部分' : '没写') + '</span>'
        : '';
    return '<div class="beat-item' + (f ? ' has-status st-' + f.status : '') + '" data-idx="' + i + '">'
        + '<div class="beat-num">' + (i + 1) + '</div>'
        + '<div style="flex:1;min-width:0;">'
        + '<div class="beat-row-top">'
        + '<select class="input beat-type" id="beat-type-' + i + '">'
        + opt('setup') + opt('conflict') + opt('climax') + opt('hook') + opt('transition')
        + '</select>'
        + '<input type="number" class="input beat-pct" id="beat-pct-' + i + '" value="' + (b.pct || 10) + '" min="1" max="100">'
        + '<span class="beat-pct-unit">%</span>'
        + statusHtml
        + '<button class="beat-del" onclick="removeBeat(' + i + ')">✕</button>'
        + '</div>'
        + '<input type="text" class="input beat-desc" id="beat-desc-' + i + '"'
        + ' value="' + escapeAttr(b.desc || '') + '"'
        + ' placeholder="谁在哪做了什么，到这一步什么变了">'
        + (f && f.evidence ? '<div class="beat-evidence">「' + escapeHtml(f.evidence) + '」</div>' : '')
        + (f && f.note ? '<div class="beat-note">' + escapeHtml(f.note) + '</div>' : '')
        + '</div></div>';
}

function paintBeats() {
    const box = document.getElementById('beat-list');
    if (!box || !beatEditData) return;
    if (!beatEditData.beats.length) {
        box.innerHTML = '<div class="beat-empty">还没有节拍。点下面的按钮按大纲自动拆一份，也可以手动加。</div>'
            + '<button class="btn btn-secondary btn-block" style="margin-top:8px;" onclick="addBeat()">+ 手动添加</button>';
        return;
    }
    box.innerHTML = beatEditData.beats.map(beatRowHtml).join('')
        + '<button class="btn btn-secondary btn-block" style="margin-top:8px;" onclick="addBeat()">+ 添加节拍</button>';
}

// 把界面上改过的内容读回内存，再重绘/保存，避免刷新时丢掉刚输入的字
function readBeatsFromDom() {
    if (!beatEditData) return;
    const items = document.querySelectorAll('#beat-list .beat-item');
    if (!items.length) return;
    const out = [];
    items.forEach((el, i) => {
        const type = (document.getElementById('beat-type-' + i) || {}).value || 'transition';
        const pct = parseInt((document.getElementById('beat-pct-' + i) || {}).value || '10', 10);
        const desc = (document.getElementById('beat-desc-' + i) || {}).value || '';
        const prev = beatEditData.beats[i] || {};
        // 重绘时把落地状态带过去，否则每改一个字结果就没了
        out.push({ type, label: BEAT_LABELS[type] || '过渡', desc, pct, fulfill: prev.fulfill });
    });
    beatEditData.beats = out;
}

async function renderBeatControl(container, novelId, chapterNum) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    ui.setPageTitle('第' + chapterNum + '章节拍');
    ui.setHeaderActions('<button class="header-btn" onclick="saveBeatControl()">保存</button>');

    const beats = await novelManager.getBeats(novelId, chapterNum);
    beatEditData = { novelId, chapterNum, beats: Array.isArray(beats) ? beats : [] };

    container.innerHTML = `
        <div class="beat-page">
            <div class="beat-intro">节拍决定这一章怎么推进。AI 续写时会按这些节拍走，而不是自己拆场景。
            每条都要落到「谁在哪做了什么、什么变了」——「冲突升级」这种写不出来。</div>
            <div id="beat-list"></div>
            <button class="btn btn-primary btn-block" style="margin-top:12px;"
                onclick="aiDraftBeats('${novelId}', ${chapterNum})">按大纲拆节拍</button>
            <button class="btn btn-outline btn-block" style="margin-top:8px;"
                onclick="checkBeatFulfillment('${novelId}', ${chapterNum})">对照正文：哪几条真写了</button>
            <button class="btn btn-outline btn-block" style="margin-top:8px;"
                onclick="aiCheckBeats('${novelId}', ${chapterNum})">检查节拍是否成立</button>
            <div id="beat-check-result" style="margin-top:12px;"></div>
        </div>`;
    paintBeats();
}

// 按大纲自动拆 6-8 个场景节拍。以前每个新章节默认 4 个空框（铺陈/冲突/高潮/钩子），
// 用户得自己填，实际没人填；更糟的是这 4 个空框会被当成节拍注入 prompt。
async function aiDraftBeats(novelId, chapterNum) {
    readBeatsFromDom();
    if (beatEditData && beatEditData.beats.some(b => b.desc)) {
        if (!confirm('这一章已经有节拍了。重新拆会覆盖现有的内容，继续？')) return;
    }

    ui.showToast('正在按大纲拆…', 3000);
    try {
        const novel = await novelManager.get(novelId);
        const outline = await novelManager.getOutline(novelId);
        const node = findOutlineChapter(outline, chapterNum);
        const chapter = await novelManager.getChapter(novelId, chapterNum);
        const summary = (node && node.summary) || (chapter && chapter.summary) || '';
        if (!summary) {
            ui.showToast('这一章还没有大纲，先去大纲里补一句本章要发生什么');
            return;
        }

        // 上一章结尾给个衔接锚点
        let prevTail = '';
        try {
            const chs = await novelManager.listChapters(novelId);
            const prev = chs.filter(c => c.number < chapterNum).sort((a, b) => b.number - a.number)[0];
            if (prev && prev.content) prevTail = String(prev.content).slice(-200);
        } catch (_) {}

        const prompt = '把这一章拆成 6-8 个场景节拍。\n\n'
            + '小说：《' + (novel.title || '') + '》\n'
            + '本章：第' + chapterNum + '章 ' + ((node && node.title) || '') + '\n'
            + '本章概要：' + summary + '\n'
            + (prevTail ? '上一章结尾：' + prevTail + '\n' : '')
            + `\n要求：
1. 每个节拍写清「谁、在哪、做了什么」，以及「到这一步什么变了」。
2. 不许写"冲突升级""气氛紧张""推进剧情"这类不可执行的话。
3. 按叙事顺序排列，覆盖全章，不重复。
4. pct 是篇幅占比，总和约 100。
5. type 只能取 setup / conflict / climax / hook / transition。

只输出 JSON，不要 markdown 代码块：
{"beats":[{"type":"setup","desc":"陈默雨夜收车，后座落下把钥匙","pct":15}]}`;

        const raw = await ai.chat([
            { role: 'system', content: '你是网文结构编辑，只输出可执行的场景节拍。' },
            { role: 'user', content: prompt }
        ], null, 1800);

        const plan = parseJsonLoose(raw, '{', '}', (v) => v && Array.isArray(v.beats) && v.beats.length);
        if (!plan) { ui.showToast('没拆出来（模型返回格式不对），再试一次'); return; }

        beatEditData.beats = plan.beats.slice(0, 12).map(b => {
            const type = BEAT_LABELS[b.type] ? b.type : 'transition';
            return {
                type,
                label: BEAT_LABELS[type],
                desc: String(b.desc || b.text || '').trim(),
                pct: Math.max(1, Math.min(100, Number(b.pct) || 10))
            };
        }).filter(b => b.desc);

        paintBeats();
        ui.showToast('拆出 ' + beatEditData.beats.length + ' 个节拍，记得点右上角保存', 4000);
    } catch (e) {
        ui.showToast('拆节拍失败：' + e.message);
    }
}

// 写完对照：这一章的正文到底落地了哪几条节拍。
// 模型经常"跳着写"——第 3 条写了，第 4 条直接略过去接第 5 条，
// 作者事后很难发现，下一章就接不上了。
async function checkBeatFulfillment(novelId, chapterNum) {
    readBeatsFromDom();
    const beats = (beatEditData && beatEditData.beats || []).filter(b => b.desc);
    if (!beats.length) { ui.showToast('先拆或先写几条节拍'); return; }

    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!chapter || !chapter.content) { ui.showToast('本章还没有正文，写完再来对照'); return; }

    ui.showToast('正在对照…', 3000);
    try {
        const beatText = beats.map((b, i) => (i + 1) + '. [' + b.label + '] ' + b.desc).join('\n');
        const body = String(chapter.content).slice(0, 6000);
        const prompt = '下面是一章的节拍规划和实际正文。逐条判断这条节拍是否真的写进去了。\n\n'
            + '【节拍】\n' + beatText + '\n\n'
            + '【正文】\n' + body + '\n\n'
            + `判断标准：
- done：正文里有对应的情节，且该有的"变化"发生了
- partial：提到了，但只是一笔带过，没形成场景
- missed：正文里找不到

只输出 JSON，不要解释：
{"results":[{"idx":1,"status":"done","evidence":"正文里对应的原句，10-30 字，没有就留空","note":"没写或只写一半时，一句提醒"}]}`;

        const raw = await ai.chat([
            { role: 'system', content: '你是严格的结构审校。只依据正文判断，不要替作者补。' },
            { role: 'user', content: prompt }
        ], null, 2000);

        const plan = parseJsonLoose(raw, '{', '}', (v) => v && Array.isArray(v.results));
        if (!plan) { ui.showToast('没对上（模型返回格式不对），再试一次'); return; }

        const byIdx = {};
        plan.results.forEach(r => { byIdx[Number(r.idx)] = r; });
        // 注意：模型返回的 idx 是"过滤掉空描述之后"的序号，
        // 而 beatEditData.beats 里可能有 desc 为空的占位行。
        // 直接用全量下标回填会整体错位，所以按同一套过滤顺序回填。
        const targets = beatEditData.beats.filter(b => b.desc);
        targets.forEach((b, i) => {
            const r = byIdx[i + 1];
            b.fulfill = r ? {
                status: ['done', 'partial', 'missed'].includes(r.status) ? r.status : 'partial',
                evidence: String(r.evidence || '').slice(0, 80),
                note: String(r.note || '').slice(0, 80)
            } : { status: 'missed', evidence: '', note: '没有返回这一条的判断' };
        });

        paintBeats();
        // 对照结果直接落库：离开页面再回来，作者还能看到这一章哪些节拍没写
        try { await novelManager.saveBeats(novelId, chapterNum, beatEditData.beats); } catch (_) {}
        const miss = beatEditData.beats.filter(b => b.fulfill && b.fulfill.status === 'missed').length;
        const part = beatEditData.beats.filter(b => b.fulfill && b.fulfill.status === 'partial').length;
        ui.showToast(miss || part
            ? `没写 ${miss} 条、写了一半 ${part} 条`
            : '每条都写到了', 4000);
    } catch (e) {
        ui.showToast('对照失败：' + e.message);
    }
}

function addBeat() {
    readBeatsFromDom();
    if (!beatEditData) return;
    beatEditData.beats.push({ type: 'transition', label: '过渡', desc: '', pct: 10 });
    paintBeats();
}

function removeBeat(idx) {
    readBeatsFromDom();
    if (!beatEditData) return;
    beatEditData.beats.splice(idx, 1);
    paintBeats();
}

async function saveBeatControl() {
    if (!beatEditData) return;
    readBeatsFromDom();
    const { novelId, chapterNum, beats } = beatEditData;
    try {
        await novelManager.saveBeats(novelId, chapterNum, beats);
        ui.showToast('节拍已保存（' + beats.length + ' 条）');
    } catch (e) {
        ui.showToast('保存失败：' + e.message);
    }
}

async function aiCheckBeats(novelId, chapterNum) {
    readBeatsFromDom();   // 用户可能改过还没保存
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

// 第三个参数是页面容器，由路由表传入；其他调用点（保存后重渲染）不传，
// 退回自己按 id 取，保持向后兼容。
async function renderParagraphEdit(novelId, chapterNum, container = null) {
    const view = container || document.getElementById('page-paragraphEdit');
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
                <button class="btn btn-outline btn-block" style="margin-top:8px;" onclick="showRawReaderOutput('${escapeJs(rawText?.substring(0, 800) || '')}')">📄 查看原始输出</button>
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
        // 是否有可撤销的批量替换（只保留最近一次，见 consistencyReplaceExecute）
        const replaceBackup = await settings.get(REPLACE_BACKUP_KEY, null);
        const canUndo = !!(replaceBackup && replaceBackup.novelId === novelId
            && Array.isArray(replaceBackup.chapters) && replaceBackup.chapters.length);
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
                ${canUndo ? `<div class="consistency-undo">
                    <button class="btn btn-outline btn-sm" onclick="undoLastReplace('${escapeJs(novelId)}')">撤销上次替换（${replaceBackup.chapters.length} 章）</button>
                    <span class="consistency-undo-hint">${escapeHtml(replaceBackup.oldText)} → ${escapeHtml(replaceBackup.newText)}</span>
                </div>` : ''}

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
                                <button class="btn btn-sm btn-primary" onclick="consistencyQuickReplace('${escapeJs(novelId)}', '${escapeJs((v.aliases || [])[0] || '')}', '${escapeJs(v.canonical || '')}')">统一为规范名</button>
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
                <button class="btn btn-danger" onclick="consistencyReplaceExecute('${escapeJs(novelId)}', '${escapeJs(oldText)}', '${escapeJs(newText)}', ${affected})">⚠️ 确认替换全部 ${totalOccur} 处</button>
            </div>`;
    } catch (e) {
        box.innerHTML = `<div class="consistency-error">❌ ${escapeHtml(e.message)}</div>`;
    }
}

// 批量替换的原文备份。只存命中的章节，且只保留最近一次：
// versions 表按章存快照会随批量操作膨胀（一次替换 100 章就是 100 份全文），
// 这里用一个独立键控制体积，能撤销「刚做的那一次」就够。
const REPLACE_BACKUP_KEY = 'replaceBackup';

async function undoLastReplace(novelId) {
    const backup = await settings.get(REPLACE_BACKUP_KEY, null);
    if (!backup || backup.novelId !== novelId || !Array.isArray(backup.chapters) || !backup.chapters.length) {
        ui.showToast('没有可撤销的替换记录');
        return;
    }
    if (!confirm(`撤销「${backup.oldText}」→「${backup.newText}」？将恢复 ${backup.chapters.length} 章的原文。`)) return;
    try {
        for (const saved of backup.chapters) {
            const cur = await db.get('chapters', saved.id);
            if (!cur) continue;   // 章节已被删掉就跳过，不要凭空造回来
            await db.put('chapters', Object.assign({}, cur, {
                content: saved.content,
                wordCount: saved.wordCount != null ? saved.wordCount : saved.content.length,
                updated: Date.now()
            }));
        }
        await novelManager.recountNovelStats(novelId);
        // 用完即清：留着容易被误点，把之后新写的内容一起覆盖回去
        await settings.set(REPLACE_BACKUP_KEY, null);
        ui.showToast(`已恢复 ${backup.chapters.length} 章原文`);
        const view = document.getElementById('page-consistencyCheck');
        if (store.currentPage === 'consistencyCheck' && view) renderConsistencyCheck(view, novelId);
    } catch (e) {
        ui.showToast('撤销失败: ' + e.message);
    }
}

async function consistencyReplaceExecute(novelId, oldText, newText, affected) {
    if (!confirm(`确认将「${oldText}」替换为「${newText}」？将影响 ${affected} 个章节，此操作不可撤销。`)) return;
    try {
        const chapters = await novelManager.listChapters(novelId);
        // 先备份原文再动手：批量替换是多章一次性改写，没有逐章 undo 栈。
        // 只存命中的章节，覆盖上一条备份（只保留最近一次）。
        const backupChapters = chapters
            .filter(ch => (ch.content || '').includes(oldText))
            .map(ch => ({ id: ch.id, number: ch.number, title: ch.title, content: ch.content, wordCount: ch.wordCount }));
        if (backupChapters.length) {
            await settings.set(REPLACE_BACKUP_KEY, {
                novelId, oldText, newText, at: Date.now(), chapters: backupChapters
            });
        }

        let done = 0;
        for (const ch of chapters) {
            if (!(ch.content || '').includes(oldText)) continue;
            const newContent = ch.content.split(oldText).join(newText);
            // 直接写记录，不走 saveChapter：
            // 1) saveChapter 每次都全量重算作品统计，替换 N 章就是 N 次 O(n) 读 —— 整体 O(n²)；
            // 2) 它还会在覆盖前归档旧版本，替换 100 章等于把 100 份全文快照塞进 versions 表，
            //    几十万字的老书一次替换就能吃掉大半配额。
            const updated = Object.assign({}, ch, {
                content: newContent,
                wordCount: newContent.length,
                updated: Date.now()
            });
            // 段落缓存必须作废：不清的话进分段编辑器还是旧段落，
            // 一点保存就把刚替换好的正文整体覆盖回去。
            delete updated.paragraphs;
            await db.put('chapters', updated);
            done++;
        }
        if (done) await novelManager.recountNovelStats(novelId);

        const box = document.getElementById('consistency-replace-result');
        if (box) box.innerHTML = `<div class="consistency-clean">✅ 替换完成：${done} 个章节已更新</div>`;
        ui.showToast(`已替换 ${done} 章`);
        const oldInput = document.getElementById('consistency-old');
        const newInput = document.getElementById('consistency-new');
        if (oldInput) oldInput.value = '';
        if (newInput) newInput.value = '';

        // 刷新实体列表。旧代码是 location.reload()：整页重载会把用户刚看到的
        // 检查结果、滚动位置全清掉，在 APK 里还会闪一下白屏。
        // 这里只重渲染当前页，延迟一点让用户先看到"替换完成"。
        setTimeout(() => {
            if (store.currentPage !== 'consistencyCheck') return;
            const view = document.getElementById('page-consistencyCheck');
            if (view) renderConsistencyCheck(view, novelId);
        }, 1200);
    } catch (e) {
        ui.showToast('替换失败: ' + e.message);
    }
}
