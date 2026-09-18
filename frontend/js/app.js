/**
 * OpenWrite Mobile - Pure Frontend Architecture
 * All logic runs in the browser/webkit. No backend server required.
 * Data stored in IndexedDB. AI calls go directly to provider APIs.
 */

// ===== Configuration =====
const CONFIG = {
    VERSION: '2.7.1',
    APP_NAME: 'OpenWrite',
    DB_NAME: 'OpenWriteDB',
    DB_VERSION: 7
};

// ===== IndexedDB Store =====
const db = {
    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
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
                if (!db.objectStoreNames.contains('worldbuilding')) {
                    const wb = db.createObjectStore('worldbuilding', { keyPath: 'id' });
                    wb.createIndex('novelId', 'novelId', { unique: false });
                    wb.createIndex('category', 'category', { unique: false });
                }
            };
        });
    },

    async get(store, key) {
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
    STORES: ['novels', 'chapters', 'settings', 'messages', 'skills', 'reviews', 'templates', 'skillStore', 'memos', 'characters', 'worldbuilding'],

    async exportAll() {
        const database = await this.open();
        const result = {};
        for (const store of this.STORES) {
            if (!database.objectStoreNames.contains(store)) continue;
            result[store] = await this.getAll(store);
        }
        return {
            app: CONFIG.APP_NAME,
            version: CONFIG.VERSION,
            exportedAt: new Date().toISOString(),
            stores: result
        };
    },

    async importAll(backup) {
        const database = await this.open();
        const stores = backup && backup.stores ? backup.stores : backup || {};
        for (const store of this.STORES) {
            if (!database.objectStoreNames.contains(store)) continue;
            const records = stores[store];
            if (!Array.isArray(records)) continue;
            const tx = database.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            await new Promise((resolve, reject) => {
                os.clear();
                records.forEach(r => os.put(r));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
        return true;
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

// ===== AI API Client =====
const ai = {
    async chat(messages, onStream = null, maxTokens = null) {
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

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`API Error ${response.status}: ${error}`);
        }

        if (onStream && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content || '';
                            if (content) {
                                fullContent += content;
                                onStream(content, fullContent);
                            }
                        } catch (e) {
                            // ignore parse errors
                        }
                    }
                }
            }
            return fullContent;
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

    async continueChapter(novelInfo, previousChapters, chapterNum, prompt) {
        const charContext = await buildCharacterContext(novelInfo.id, chapterNum);
        const wbContext = await buildWorldbuildingContext(novelInfo.id);
        const context = previousChapters.map(ch => `第${ch.number}章：${ch.title}\n${ch.content.substring(0, 500)}...`).join('\n\n');

        const userPrompt = `请为小说《${novelInfo.title}》生成第${chapterNum}章。

${charContext ? '以下为已设定的角色卡（写作时必须严格遵照角色性格、外貌、口头禅和当前状态）：\n\n' + charContext + '\n\n' : ''}
${wbContext ? '以下为世界观设定（写作时必须严格遵守规则）：\n\n' + wbContext + '\n\n' : ''}
前文章节概要：
${context}

写作提示：${prompt || '请延续前文情节，保持故事连贯性'}

请生成第${chapterNum}章的标题和正文（2000-3000字）。`;

        return await this.chat([
            { role: 'system', content: `你是小说《${novelInfo.title}》的AI写作助手。保持文风一致，情节连贯。` },
            { role: 'user', content: userPrompt }
        ]);
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
        }
        await db.delete('novels', novelId);
    },

    async listChapters(novelId) {
        return await db.getAll('chapters', 'novelId', novelId);
    },

    async getChapter(novelId, chapterNum) {
        const chapters = await this.listChapters(novelId);
        return chapters.find(ch => ch.number === chapterNum);
    },

    async saveChapter(novelId, chapterNum, title, content, paragraphs = null) {
        const id = `${novelId}_ch${chapterNum}`;
        const chapter = {
            id,
            novelId,
            number: chapterNum,
            title: title || `第${chapterNum}章`,
            content,
            wordCount: content.length,
            created: Date.now(),
            updated: Date.now()
        };
        if (paragraphs !== null) {
            chapter.paragraphs = paragraphs;
        }
        await db.put('chapters', chapter);

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
        const id = `char_${novelId}_${Date.now()}`;
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
        const id = `wb_${novelId}_${Date.now()}`;
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

function navigateTo(page, params = {}, isRootTab = false) {
    if (!isRootTab) {
        pageHistory.push({ page: store.currentPage, params: {} });
    } else {
        pageHistory = [];
    }
    
    store.currentPage = page;
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

    const renderers = {
        bookshelf: renderBookshelf,
        writing: renderWriting,
        settings: renderSettings,
        novelDetail: () => renderNovelDetail(params.novelId),
        chapterEdit: () => renderChapterEdit(params.novelId, params.chapterNum),
        about: renderAbout,
        chat: renderChat,
        // 技能中心
        skillCenter: renderSkillCenter,
        skillDetail: () => renderSkillDetail(params.skillId),
        skillUse: () => renderSkillUse(params.skillId, params.mode),
        skillHistory: renderSkillHistory,
        // Skill 广场
        skillPlaza: renderSkillPlaza,
        // 蒸馏
        distill: renderDistill,
        distillTemplates: renderDistillTemplates,
        distillResult: () => renderDistillResult(params.templateId),
        distillWrite: () => renderDistillWrite(params.templateId),
        // 参数配置
        paramConfig: renderParamConfig,
        // 数据管理
        dataManage: renderDataManage,
        // 大纲编辑器
        outlineEditor: () => renderOutlineEditor(params.novelId),
        // 情节推演
        plotSimulate: () => renderPlotSimulate(params.novelId),
        // 节拍控制
        beatControl: () => renderBeatControl(params.novelId, params.chapterNum),
        // 角色卡
        characterCards: () => renderCharacterCards(params.novelId),
        characterEdit: () => renderCharacterEdit(params.novelId, params.characterId),
        // 世界观
        worldview: () => renderWorldView(params.novelId),
        worldviewEdit: () => renderWorldviewEdit(params.novelId, params.worldviewId),
        paragraphEdit: () => renderParagraphEdit(params.novelId, params.chapterNum),
        // 多Agent协作
        agentStudio: () => renderAgentStudio(params.novelId),
        // 一致性检查
        consistencyCheck: () => renderConsistencyCheck(params.novelId),
        // 导出分发
        novelExport: () => renderNovelExport(params.novelId)
    };

    if (renderers[page]) renderers[page](view);
    window.scrollTo(0, 0);
}

// ===== Chat / Home Page =====
function renderChat(container) {
    ui.setPageTitle('新对话');
    // 竞品风格：无顶部操作按钮，模型名在标题下方显示
    ui.setHeaderActions(`
        <button class="hamburger-btn" onclick="openChatDrawer()">
            <span></span><span></span><span></span>
        </button>
    `);

    container.innerHTML = `
        <div style="padding: 0 16px; display: flex; flex-direction: column; height: calc(100vh - 120px); overflow-y: auto;">
            <!-- 顶部模型指示器 -->
            <div style="font-size: 13px; color: var(--text-tertiary); margin: 4px 0 12px;">${store.modelName || 'glm-5.1'}</div>

            <!-- 快捷工具胶囊行 -->
            <div class="chat-tool-row">
                <button class="chat-tool-pill" onclick="showMemo()"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>备忘录</button>
                <button class="chat-tool-pill" onclick="showNameGenerator()"><span class="tool-pill-icon" style="font-size:13px;font-weight:600;">T</span>起名</button>
                <button class="chat-tool-pill primary" onclick="navigateTo('distill')"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 3l9 16H3L12 3z"/><path d="M12 12v4"/></svg></span>蒸馏</button>
                <button class="chat-tool-pill" onclick="showDeconstruct()"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>拆解</button>
                <button class="chat-tool-pill" onclick="showRank()"><span class="tool-pill-icon"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg></span>扫榜</button>
            </div>

            <!-- 中央 Logo 区域 -->
            <div class="chat-hero">
                <div class="chat-hero-logo"><svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--primary)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
                <div class="chat-hero-title">OpenWrite</div>
                <div class="chat-hero-subtitle">你的 AI 小说写作助手</div>
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
            <div class="composer-top">
                <button class="composer-search-btn" onclick="showWebSearch()">🌐 联网搜索</button>
            </div>
            <div class="composer-input-box">
                <textarea class="composer-textarea" id="chat-input" placeholder="写下你的故事..."></textarea>
            </div>
            <div class="composer-toolbar">
                <button class="composer-btn" onclick="openSkillPicker()">@ 技能</button>
                <button class="composer-btn" onclick="attachFile()"># 文件</button>
                <button class="composer-btn" onclick="showModelIndicator()">⚙ 默认</button>
                <button class="composer-btn" onclick="showMemory()">🧠</button>
                <button class="composer-btn" onclick="rollDice()">🎲</button>
                <button class="composer-send" onclick="sendMessage()">➤</button>
            </div>
        </div>
    `;
}

// ===== 聊天消息发送（修复：真实渲染消息，而非仅 toast） =====
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

    // 用户消息
    const userMsg = document.createElement('div');
    userMsg.className = 'msg-row user';
    userMsg.innerHTML = `<div class="msg-bubble user">${escapeHtml(text)}</div>`;
    messagesBox.appendChild(userMsg);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    // AI 思考中
    const aiLoading = document.createElement('div');
    aiLoading.className = 'msg-row ai';
    aiLoading.innerHTML = `<div class="msg-bubble ai loading">AI 思考中<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    messagesBox.appendChild(aiLoading);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    // 判定是否带技能上下文
    let systemPrompt = '你是OpenWrite AI小说写作助手。帮助用户构思情节、塑造人物、润色文字。回答保持简洁、直接、有行动建议。';
    const activeSkill = store.activeChatSkill;
    if (activeSkill) {
        const skill = await skillManager.get(activeSkill);
        if (skill && skill.enabled) {
            systemPrompt = `你是资深中文小说编辑，正在使用技能《${skill.name}》辅助创作。以下是技能规则，请按规则处理用户需求：\n\n${skill.content}\n\n请按技能要求给出专业回答。`;
        }
    }

    try {
        let fullText = '';
        const response = await ai.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ], (chunk, full) => {
            fullText = full;
            aiLoading.innerHTML = `<div class="msg-bubble ai">${escapeHtml(fullText).replace(/\n/g, '<br>')}</div>`;
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }, 4000);

        if (!fullText) fullText = response;
        aiLoading.innerHTML = `<div class="msg-bubble ai">${escapeHtml(fullText).replace(/\n/g, '<br>')}</div>`;

        // 保存消息
        try {
            await db.put('messages', { sessionId: 'main', role: 'user', content: text, created: Date.now() });
            await db.put('messages', { sessionId: 'main', role: 'assistant', content: fullText, created: Date.now() });
        } catch (e) { /* ignore */ }
    } catch (err) {
        aiLoading.innerHTML = `<div class="msg-bubble ai error">⚠️ ${escapeHtml(err.message)}</div>`;
    }
    messagesBox.scrollTop = messagesBox.scrollHeight;
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
    const options = enabled.map(s => `<div class="skill-pick-item" onclick="pickChatSkill('${s.id}')"><span>${s.icon}</span><div style="flex:1;"><div style="font-weight:600;">${s.name}</div><div style="font-size:12px;color:var(--text-secondary);">${s.description.slice(0, 30)}...</div></div><span style="color:var(--text-secondary);">›</span></div>`).join('');
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
function showMemory() { ui.showToast('记忆功能：写作设定记忆库开发中...'); }
function showNameGenerator() { ui.showToast('起名功能开发中...'); }
function showDeconstruct() { ui.showToast('拆解功能开发中...'); }
function showRank() { ui.showToast('扫榜功能开发中...'); }
function continueWriting() { navigateTo('bookshelf'); }
function showTutorial() { showTutorialModal(); }
function showDistill() { navigateTo('distill'); }
function useSkill() { openSkillPicker(); }
function attachFile() { ui.showToast('文件功能开发中...'); }
function rollDice() { ui.showToast(`🎲 ${Math.floor(Math.random() * 6) + 1}`); }
function webSearch() { ui.showToast('联网搜索功能开发中...'); }

// ===== Bookshelf Page (v2.2.0 with stats dashboard) =====
async function renderBookshelf(container) {
    ui.setPageTitle('我的小说');
    ui.setHeaderActions(`
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
                    <div class="empty-desc">点击右上角 + 新建开始创作你的第一部小说</div>
                </div>
            `;
            return;
        }

        container.innerHTML = `
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
                        <div class="novel-cover">${novel.title.charAt(0)}</div>
                        <div class="novel-info">
                            <div class="novel-title">${novel.title}</div>
                            <div class="novel-meta">${novel.chapterCount || 0}章 · ${(novel.wordCount || 0).toLocaleString()}字 · ${formatDate(novel.updated)}</div>
                            ${novel.genre ? `<div class="novel-genre">${novel.genre}</div>` : ''}
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
        const outlineItems = novel.outline || [];
        const characters = novel.characters || [];
        
        container.innerHTML = `
            <div class="novel-header-card">
                <div class="novel-header-cover">${novel.title.charAt(0)}</div>
                <div class="novel-header-info">
                    <div class="novel-header-title">${novel.title}</div>
                    <div class="novel-header-meta">${novel.chapterCount || 0}章 · ${(novel.wordCount || 0).toLocaleString()}字</div>
                    <div class="novel-header-desc">${novel.description || '暂无简介'}</div>
                </div>
            </div>

            <div class="action-buttons-row" style="margin-bottom: 12px;">
                <button class="btn btn-primary" onclick="showWriteChapterModal('${novelId}')">✍️ 写新章节</button>
                <button class="btn btn-secondary" onclick="aiWriteNext('${novelId}')">🤖 AI续写</button>
            </div>

            <div class="action-buttons-row" style="margin-bottom: 12px;">
                <button class="btn btn-outline" onclick="navigateTo('outlineEditor', { novelId: '${novelId}' })">📋 编辑大纲</button>
                <button class="btn btn-outline" onclick="navigateTo('plotSimulate', { novelId: '${novelId}' })">🔮 情节推演</button>
                <button class="btn btn-outline" onclick="navigateTo('characterCards', { novelId: '${novelId}' })">👥 角色卡</button>
            </div>
            <div class="action-buttons-row" style="margin-bottom: 12px;">
                <button class="btn btn-outline" onclick="navigateTo('worldview', { novelId: '${novelId}' })">🌍 世界观</button>
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
                                    <span class="tree-file-name">第${item.chapter}章 ${item.title}</span>
                                    <span class="tree-file-meta">${item.summary?.substring(0, 20) || ''}...</span>
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
                                    <span class="tree-file-name">${char.name}</span>
                                    <span class="tree-file-meta">${char.role || '角色'}</span>
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
                        <span class="tree-count">${chapters.length}章</span>
                    </div>
                    <div class="tree-folder-content">
                        ${chapters.length === 0
                            ? '<div class="tree-empty">暂无章节</div>'
                            : chapters.map(ch => `
                                <div class="tree-file" onclick="event.stopPropagation(); navigateTo('chapterEdit', { novelId: '${novelId}', chapterNum: ${ch.number} })">
                                    <span class="tree-file-icon">📄</span>
                                    <span class="tree-file-name">第${ch.number}章 ${ch.title}</span>
                                    <span class="tree-file-meta">${(ch.wordCount || 0).toLocaleString()}字</span>
                                </div>
                            `).join('')}
                    </div>
                </div>
            </div>
        `;
    } catch (err) {
        ui.showEmptyState(container, { icon: '⚠️', title: '加载失败', desc: err.message });
    }
}

// ===== Chapter Edit Page =====
async function renderChapterEdit(container, novelId, chapterNum) {
    const novel = await novelManager.get(novelId);
    const chapter = await novelManager.getChapter(novelId, chapterNum);

    ui.setPageTitle(chapter ? chapter.title : `第${chapterNum}章`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="saveAndBack('${novelId}', ${chapterNum})">保存</button>
    `);

    const title = chapter ? chapter.title : `第${chapterNum}章`;
    const content = chapter ? chapter.content : '';

    container.innerHTML = `
        <div class="editor-container">
            <input type="text" class="editor-title-input" id="chapter-title" value="${title}" placeholder="章节标题...">
            <textarea class="editor-content" id="chapter-content" placeholder="在此开始写作...">${content}</textarea>
        </div>
        <div class="action-buttons-row" style="margin-top: 12px;">
            <button class="btn btn-secondary" onclick="reviewThisChapter('${novelId}', ${chapterNum})">🔍 AI审稿</button>
            <button class="btn btn-primary" onclick="aiContinueChapter('${novelId}', ${chapterNum})">✨ AI续写</button>
        </div>
        <div class="action-buttons-row" style="margin-top: 8px;">
            <button class="btn btn-outline" onclick="navigateTo('beatControl', { novelId: '${novelId}', chapterNum: ${chapterNum} })">🎬 节拍控制</button>
            <button class="btn btn-outline" onclick="navigateTo('paragraphEdit', { novelId: '${novelId}', chapterNum: ${chapterNum} })">📄 分段编辑</button>
            <button class="btn btn-outline" onclick="aiReaderSimulate('${novelId}', ${chapterNum})">🎭 AI读者</button>
        </div>
    `;
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
                ${store.novels.map(n => `<option value="${n.id}">${n.title}</option>`).join('')}
            </select>
            <input type="number" class="input" id="writing-chapter-num" placeholder="章节号（如：1）" style="margin-bottom: 12px;">
            <textarea class="textarea" id="writing-prompt" placeholder="输入写作提示（可选）..."></textarea>
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
        const url = URL.createObjectURL(blob);
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const filename = `openwrite-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        ui.showToast('备份文件已导出');
    } catch (e) {
        ui.showToast('导出失败: ' + e.message);
    } finally {
        const btn = document.getElementById('btn-export');
        if (btn) { btn.disabled = false; btn.textContent = '导出数据'; }
    }
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
            await db.importAll(data);
            ui.showToast('✅ 数据恢复成功');
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
    
    // AI 第一条消息：问类型（自由输入）
    addChatMessage('ai', '你好！我是你的 AI 写作助手 ✨\n\n你想写什么类型的小说？（如：玄幻、都市、科幻、悬疑等）');
    setupGuideInputHandler('genre');
}

function addChatMessage(role, text, options = []) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg-row ${role}`;
    
    let optionsHtml = '';
    if (options.length > 0) {
        optionsHtml = `<div class="msg-options">${options.map((opt, i) => 
            `<button class="msg-option-btn" onclick="window._guideOption${Date.now()}_${i}()">${escapeHtml(opt.label)}</button>`
        ).join('')}</div>`;
        // 绑定全局函数
        options.forEach((opt, i) => {
            window[`_guideOption${Date.now()}_${i}`] = opt.action;
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
        // 已回答类型，问书名
        addChatMessage('ai', `好的，${answers.genre}题材！你想给这本书起什么名字？`);
        setupGuideInputHandler('title');
    } else if (step === 2) {
        // 已回答书名，直接生成大纲
        addChatMessage('ai', `收到，书名是《${answers.title}》。让我为你构思故事大纲…`);
        await generateNovelFromGuide();
    }
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
        // 生成大纲（只基于类型和书名，AI自动补充角色和梗概）
        const prompt = `请为一部${genre}小说生成完整大纲，书名是《${title}》：
1. 10-15章的章节大纲
2. 3-5个关键角色设定（含主角身份、性格）
3. 世界观简述
4. 故事梗概（100字左右）

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
        
        addChatMessage('ai', `📖 大纲已生成！\n\n书名：《${title}》\n\n📋 章节规划：\n${outlineText}\n\n👥 主要角色：\n${charsText}\n\n确认创建这本小说吗？`, [
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

function showWriteChapterModal(novelId) {
    const modal = createModal('写新章节', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <input type="number" class="input" id="new-chapter-num" placeholder="章节号">
            <input type="text" class="input" id="new-chapter-title" placeholder="章节标题">
            <textarea class="textarea" id="new-chapter-prompt" placeholder="写作提示（可选）..."></textarea>
            <button class="btn btn-primary btn-block" onclick="createAndWriteChapter('${novelId}')">开始写作</button>
        </div>`);
    modal.show();
}

async function createAndWriteChapter(novelId) {
    const num = parseInt(document.getElementById('new-chapter-num').value);
    const title = document.getElementById('new-chapter-title').value.trim();
    const prompt = document.getElementById('new-chapter-prompt').value.trim();

    if (!num || num < 1) { ui.showToast('请输入有效的章节号'); return; }

    closeModal();
    ui.showToast('AI 正在写作中...');

    try {
        const novel = await novelManager.get(novelId);
        const chapters = await novelManager.listChapters(novelId);
        const content = await ai.generateNovel(novel) || await ai.continueChapter(novel, chapters, num, prompt);

        await novelManager.saveChapter(novelId, num, title || `第${num}章`, content);
        ui.showToast(`第${num}章写作完成！`);
        navigateTo('chapterEdit', { novelId, chapterNum: num });
    } catch (err) {
        ui.showToast('写作失败: ' + err.message);
    }
}

async function aiWriteNext(novelId) {
    const chapters = await novelManager.listChapters(novelId);
    const nextNum = (chapters.length > 0 ? Math.max(...chapters.map(c => c.number)) : 0) + 1;
    showWriteChapterModal(novelId);
    document.getElementById('new-chapter-num').value = nextNum;
}

async function saveAndBack(novelId, chapterNum) {
    const title = document.getElementById('chapter-title').value;
    const content = document.getElementById('chapter-content').value;
    await novelManager.saveChapter(novelId, chapterNum, title, content);
    ui.showToast('章节已保存');
    navigateTo('novelDetail', { novelId });
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

async function aiContinueChapter(novelId, chapterNum) {
    try {
        const novel = await novelManager.get(novelId);
        const chapters = await novelManager.listChapters(novelId);
        const prevChapters = chapters.filter(c => c.number < chapterNum).sort((a, b) => a.number - b.number);

        ui.showToast('AI 正在续写...');
        const content = await ai.continueChapter(novel, prevChapters, chapterNum, '');

        const textarea = document.getElementById('chapter-content');
        if (textarea) {
            textarea.value += (textarea.value ? '\n\n' : '') + content;
        }
        ui.showToast('续写完成！');
    } catch (err) {
        ui.showToast('续写失败: ' + err.message);
    }
}

async function startWriting() {
    const novelId = document.getElementById('writing-novel-select').value;
    const chapterNum = parseInt(document.getElementById('writing-chapter-num').value);
    const prompt = document.getElementById('writing-prompt').value.trim();

    if (!novelId) { ui.showToast('请选择作品'); return; }
    if (!chapterNum || chapterNum < 1) { ui.showToast('请输入有效的章节号'); return; }

    try {
        const novel = await novelManager.get(novelId);
        const chapters = await novelManager.listChapters(novelId);
        ui.showToast('AI 正在写作中...');

        const content = await ai.continueChapter(novel, chapters, chapterNum, prompt);
        await novelManager.saveChapter(novelId, chapterNum, `第${chapterNum}章`, content);
        ui.showToast('写作完成！');
        navigateTo('chapterEdit', { novelId, chapterNum });
    } catch (err) {
        ui.showToast('写作失败: ' + err.message);
    }
}

async function showModelConfigModal() {
    // 读取已保存的配置，预填充到弹窗
    const saved = await settings.getModelConfig();
    const isCustom = saved.model && !['glm-5.1','glm-4.5','glm-4','deepseek-chat','deepseek-reasoner','gpt-4o','gpt-4','gpt-3.5-turbo','claude-3.5-sonnet'].includes(saved.model);
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
                <option value="gpt-4o" ${modelValue==='gpt-4o'?'selected':''}>GPT-4o</option>
                <option value="gpt-4" ${modelValue==='gpt-4'?'selected':''}>GPT-4</option>
                <option value="gpt-3.5-turbo" ${modelValue==='gpt-3.5-turbo'?'selected':''}>GPT-3.5 Turbo</option>
                <option value="claude-3.5-sonnet" ${modelValue==='claude-3.5-sonnet'?'selected':''}>Claude 3.5 Sonnet</option>
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

    // Default to chat page (matching competitor)
    navigateTo('chat');
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
    const builtinOptions = BUILTIN_SKILLS.map(s => `<option value="${s.id}">${s.icon} ${s.name}</option>`).join('');

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
        const container = document.getElementById('chat-view');
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
    const container = document.getElementById('chat-view');
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

function viewMemo(id) {
    // 可以查看/编辑备忘录详情
    ui.showToast('备忘录查看功能开发中');
}

// ===== Novel Tree Browser Helpers =====

function toggleTreeFolder(folderEl) {
    folderEl.classList.toggle('collapsed');
}

async function viewOutlineItem(novelId, index) {
    const novel = await novelManager.get(novelId);
    if (!novel || !novel.outline || !novel.outline[index]) {
        ui.showToast('大纲条目不存在');
        return;
    }
    
    const item = novel.outline[index];
    const modal = createModal(`第${item.chapter}章 ${item.title}`, `
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
async function renderForeshadowing(novelId) {
    const novel = await novelManager.getNovel(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    const items = await novelManager.listForeshadowing(novelId);
    const totalChapters = novel.chapters || 1;
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
    const content = document.getElementById('view-container');
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

async function renderForeshadowingEdit(novelId, foreshadowingId) {
    const novel = await novelManager.getNovel(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    const fs = foreshadowingId ? await novelManager.getForeshadowing(foreshadowingId) : null;
    const isNew = !fs;
    const maxChapter = Math.max(1, novel.chapters || 1);
    ui.setPageTitle(isNew ? '新建伏笔' : '编辑伏笔');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('foreshadowing', { novelId: '${novelId}' })">返回</button>
        ${!isNew ? `<button class="header-btn" onclick="deleteForeshadowing('${foreshadowingId}', '${novelId}')">删除</button>` : ''}
        <button class="header-btn" onclick="saveForeshadowing('${novelId}', '${foreshadowingId || ''}')">保存</button>
    `);
    const container = document.getElementById('view-container');
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
            if (saved && saved.v) {
                this.messages = saved.v.messages || [];
                this.history = saved.v.history || [];
            }
        } catch (_) {}
    },

    async save() {
        if (!this.novelId) return;
        try {
            await db.put('settings', { key: `agent_${this.novelId}`, v: { messages: this.messages.slice(-30), history: this.history.slice(-20) } });
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
    outputBox.innerHTML = `<div class="agent-output-loading"><div class="spinner"></div><div>${def.icon} ${def.name} 正在思考…</div></div>`;
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
