/**
 * OpenWrite Mobile - Pure Frontend Architecture
 * All logic runs in the browser/webkit. No backend server required.
 * Data stored in IndexedDB. AI calls go directly to provider APIs.
 */

// ===== Configuration =====
const CONFIG = {
    VERSION: '2.4.0',
    APP_NAME: 'OpenWrite',
    DB_NAME: 'OpenWriteDB',
    DB_VERSION: 4
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
    STORES: ['novels', 'chapters', 'settings', 'messages', 'skills', 'reviews', 'templates', 'skillStore', 'memos'],

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
        const prompt = `你是一个专业的小说写作助手。请根据以下信息生成一部小说的第一章：

小说名称：${novelInfo.title}
类型：${novelInfo.genre || '未指定'}
简介：${novelInfo.description || '暂无'}

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
        const context = previousChapters.map(ch => `第${ch.number}章：${ch.title}\n${ch.content.substring(0, 500)}...`).join('\n\n');

        const userPrompt = `请为小说《${novelInfo.title}》生成第${chapterNum}章。

前文章节概要：
${context}

写作提示：${prompt || '请延续前文情节，保持故事连贯性'}

请生成第${chapterNum}章的标题和正文（2000-3000字）。`;

        return await this.chat([
            { role: 'system', content: `你是小说《${novelInfo.title}》的AI写作助手。保持文风一致，情节连贯。` },
            { role: 'user', content: userPrompt }
        ]);
    },

    async reviewChapter(chapterContent, novelInfo) {
        const prompt = `请对以下小说章节进行专业审稿：

小说：${novelInfo.title}
章节内容：
${chapterContent}

请从以下维度进行评价（每项满分10分）：
1. 情节连贯性
2. 人物塑造
3. 文笔流畅度
4. 场景描写
5. 对话质量

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

    async saveChapter(novelId, chapterNum, title, content) {
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
function navigateTo(page, params = {}) {
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
        beatControl: () => renderBeatControl(params.novelId, params.chapterNum)
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
                <button class="chat-tool-pill" onclick="showMemo()"><span class="tool-pill-icon">📝</span>备忘录</button>
                <button class="chat-tool-pill" onclick="showNameGenerator()"><span class="tool-pill-icon">T</span>起名</button>
                <button class="chat-tool-pill primary" onclick="navigateTo('distill')"><span class="tool-pill-icon">✨</span>蒸馏</button>
                <button class="chat-tool-pill" onclick="showDeconstruct()"><span class="tool-pill-icon">📖</span>拆解</button>
                <button class="chat-tool-pill" onclick="showRank()"><span class="tool-pill-icon">📊</span>扫榜</button>
            </div>

            <!-- 中央 Logo 区域 -->
            <div class="chat-hero">
                <div class="chat-hero-logo">✨</div>
                <div class="chat-hero-title">OpenWrite</div>
                <div class="chat-hero-subtitle">你的 AI 小说写作助手</div>
            </div>

            <!-- 操作卡片 -->
            <div class="chat-action-list">
                <div class="chat-action-card" onclick="showCreateNovelModal()">
                    <div class="chat-action-icon" style="background: linear-gradient(135deg, #ede9fe, #ddd6fe);">📚</div>
                    <div class="chat-action-body">
                        <div class="chat-action-title">新书启航</div>
                        <div class="chat-action-desc">初始化小说项目，创建目录结构</div>
                    </div>
                    <span class="chat-action-arrow">›</span>
                </div>
                <div class="chat-action-card" onclick="continueWriting()">
                    <div class="chat-action-icon" style="background: linear-gradient(135deg, #fef3c7, #fde68a);">✍️</div>
                    <div class="chat-action-body">
                        <div class="chat-action-title">继续写作</div>
                        <div class="chat-action-desc">继续上一次的对话</div>
                    </div>
                    <span class="chat-action-arrow">›</span>
                </div>
                <div class="chat-action-card" onclick="showTutorial()">
                    <div class="chat-action-icon" style="background: linear-gradient(135deg, #fce7f3, #fbcfe8);">📖</div>
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
        <button class="header-btn" onclick="showCreateNovelModal()">+ 新建</button>
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
                    <div class="settings-icon">🤖</div>
                    <div>
                        <div class="settings-label">模型配置</div>
                        <div class="settings-value">${config.provider || '未配置'} - ${config.model || ''}</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('skillCenter')">
                <div class="settings-item-left">
                    <div class="settings-icon">🧩</div>
                    <div>
                        <div class="settings-label">Skill 管理</div>
                        <div class="settings-value">浏览、导入与管理写作技能</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('skillPlaza')">
                <div class="settings-item-left">
                    <div class="settings-icon">🏪</div>
                    <div>
                        <div class="settings-label">Skill 广场</div>
                        <div class="settings-value">发现与分享写作技能</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">创作工具</div>
            <div class="settings-item" onclick="navigateTo('distill')">
                <div class="settings-item-left">
                    <div class="settings-icon">✨</div>
                    <div>
                        <div class="settings-label">蒸馏</div>
                        <div class="settings-value">上传书籍，提取作者写作风格</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('distillTemplates')">
                <div class="settings-item-left">
                    <div class="settings-icon">🗂️</div>
                    <div>
                        <div class="settings-label">风格档案</div>
                        <div class="settings-value">${tplCount} 个已蒸馏风格</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('skillHistory')">
                <div class="settings-item-left">
                    <div class="settings-icon">📜</div>
                    <div>
                        <div class="settings-label">审查历史</div>
                        <div class="settings-value">查看去AI味审查报告</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('paramConfig')">
                <div class="settings-item-left">
                    <div class="settings-icon">🎛️</div>
                    <div>
                        <div class="settings-label">参数配置</div>
                        <div class="settings-value">温度、上下文窗口与提示词</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item" onclick="navigateTo('dataManage')">
                <div class="settings-item-left">
                    <div class="settings-icon">💾</div>
                    <div>
                        <div class="settings-label">数据备份与恢复</div>
                        <div class="settings-value">导出/导入全部数据</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">关于</div>
            <div class="settings-item" onclick="navigateTo('about')">
                <div class="settings-item-left">
                    <div class="settings-icon">ℹ️</div>
                    <div><div class="settings-label">关于 OpenWrite</div><div class="settings-value">版本 ${CONFIG.VERSION}</div></div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>`;
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
    const title = document.getElementById('new-novel-title').value.trim();
    const desc = document.getElementById('new-novel-desc').value.trim();
    const genre = document.getElementById('new-novel-genre').value;

    if (!title) { ui.showToast('请输入作品名称'); return; }

    closeModal();
    
    // Show agent workflow UI
    const workflowHtml = `
        <div id="agent-workflow" style="padding: 16px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">AI 正在创建小说</div>
                <div style="font-size: 14px; color: var(--text-secondary);">《${escapeHtml(title)}》</div>
            </div>
            <div class="agent-steps" id="agent-steps"></div>
            <div id="agent-result" style="margin-top: 16px;"></div>
        </div>
    `;
    
    const container = document.getElementById('chat-view') || document.querySelector('.page-view.active');
    if (container) {
        container.innerHTML = workflowHtml;
    }

    const stepsEl = document.getElementById('agent-steps');
    const steps = [
        { id: 'find-skills', label: '查找相关技能', icon: '🧩' },
        { id: 'list-outline', label: '生成故事大纲', icon: '📋' },
        { id: 'read-templates', label: '读取风格模板', icon: '📄' },
        { id: 'generate-content', label: '生成章节内容', icon: '✍️' }
    ];

    function updateStep(index, status, detail) {
        const html = steps.map((s, i) => {
            const state = i < index ? 'completed' : i === index ? status : 'pending';
            const icon = state === 'completed' ? '✅' : state === 'in-progress' ? '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>' : '⏳';
            const color = state === 'completed' ? 'var(--success)' : state === 'in-progress' ? 'var(--primary)' : 'var(--text-tertiary)';
            return `
                <div style="display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 10px; background: ${state === 'in-progress' ? 'rgba(99,102,241,0.05)' : 'var(--bg)'}; margin-bottom: 8px;">
                    <div style="font-size: 20px;">${s.icon}</div>
                    <div style="flex: 1;">
                        <div style="font-size: 14px; font-weight: 500; color: ${color};">${s.label}</div>
                        ${detail && i === index ? `<div style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px;">${detail}</div>` : ''}
                    </div>
                    <div style="flex-shrink: 0;">${icon}</div>
                </div>
            `;
        }).join('');
        if (stepsEl) stepsEl.innerHTML = html;
    }

    try {
        // Step 1: Find relevant skills
        updateStep(0, 'in-progress', '搜索相关写作技能...');
        await new Promise(r => setTimeout(r, 800));
        const activeSkills = await skillManager.listActive();
        const relevantSkills = activeSkills.filter(s => 
            (genre && s.category?.includes(genre)) || 
            s.content?.includes('大纲') || 
            s.content?.includes('写作')
        );
        updateStep(0, 'completed', `找到 ${relevantSkills.length} 个相关技能`);

        // Step 2: Generate outline
        updateStep(1, 'in-progress', 'AI 正在构思故事大纲...');
        await new Promise(r => setTimeout(r, 500));
        
        const outlinePrompt = `请为小说《${title}》生成一个完整的故事大纲。
${desc ? '简介：' + desc : ''}
${genre ? '类型：' + genre : ''}

要求：
1. 给出10-15章的章节标题和简要内容
2. 包含主要人物设定
3. 标注关键剧情转折点

请以 JSON 格式输出：
{
  "title": "作品名称",
  "outline": [
    {"chapter": 1, "title": "第一章标题", "summary": "内容概要"}
  ],
  "characters": [
    {"name": "角色名", "role": "主角/配角", "description": "角色描述"}
  ]
}`;

        let outlineContent = '';
        try {
            outlineContent = await ai.chat([
                { role: 'system', content: '你是专业的小说大纲规划师，擅长构建完整的故事架构。' },
                { role: 'user', content: outlinePrompt }
            ], null, 4000);
        } catch (e) {
            outlineContent = '';
        }
        
        // Parse outline
        let outline = null;
        try {
            const jsonMatch = outlineContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                outline = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            outline = null;
        }
        
        updateStep(1, 'completed', outline ? `大纲生成完成，共 ${outline.outline?.length || 0} 章` : '大纲生成完成');

        // Step 3: Read templates
        updateStep(2, 'in-progress', '查找风格模板...');
        await new Promise(r => setTimeout(r, 600));
        const templates = await distillManager.listTemplates();
        const selectedTemplate = templates.length > 0 ? templates[0] : null;
        updateStep(2, 'completed', selectedTemplate ? `已加载风格模板：${selectedTemplate.name}` : '使用默认风格');

        // Step 4: Generate content
        updateStep(3, 'in-progress', 'AI 正在生成第一章内容...');
        await new Promise(r => setTimeout(r, 500));
        
        const novel = await novelManager.create(title, desc, genre);
        
        // Save outline as data
        if (outline) {
            novel.outline = outline.outline || [];
            novel.characters = outline.characters || [];
            await novelManager.update(novel);
        }

        // Generate first chapter
        const writePrompt = `请根据以下信息生成小说《${title}》第一章的完整内容。

${desc ? '作品简介：' + desc : ''}
${genre ? '类型：' + genre : ''}
${outline && outline.outline ? '故事大纲：\n' + outline.outline.slice(0, 3).map(o => `第${o.chapter}章 ${o.title}：${o.summary}`).join('\n') : ''}
${selectedTemplate ? '写作风格要求：\n' + selectedTemplate.content?.substring(0, 500) : ''}

要求：
1. 生成完整的第一章正文（2000-3000字）
2. 包含章节标题
3. 语言流畅，情节吸引人
4. 符合${genre || '小说'}类型的风格特点

请直接输出章节标题和正文内容。`;

        let chapterContent = '';
        let chapterTitle = '第一章';
        
        try {
            const fullContent = await ai.chat([
                { role: 'system', content: `你是专业的小说作家，擅长${genre || '各类'}小说创作。` },
                { role: 'user', content: writePrompt }
            ], null, 4000);
            
            // Extract title from content
            const titleMatch = fullContent.match(/^(第[一二三四五六七八九十\d]+章[：:]|第[一二三四五六七八九十\d]+章\s+)(.+)$/m);
            if (titleMatch) {
                chapterTitle = titleMatch[2].trim() || '第一章';
                chapterContent = fullContent.replace(titleMatch[0], '').trim();
            } else {
                chapterContent = fullContent;
            }
        } catch (e) {
            chapterContent = 'AI 生成内容时出现错误，请重试或手动编写。';
        }

        // Save chapter
        await novelManager.saveChapter(novel.id, 1, chapterTitle, chapterContent);
        
        updateStep(3, 'completed', '第一章生成完成！');

        // Show result
        const resultEl = document.getElementById('agent-result');
        if (resultEl) {
            resultEl.innerHTML = `
                <div style="background: var(--surface); border-radius: 12px; padding: 16px; margin-top: 16px;">
                    <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">✅ 小说创建成功</div>
                    <div style="font-size: 14px; color: var(--text-secondary); margin-bottom: 12px;">
                        《${escapeHtml(title)}》第一章已生成完毕
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-primary" style="flex: 1;" onclick="navigateTo('chapterEdit', { novelId: '${novel.id}', chapterNum: 1 })">查看章节</button>
                        <button class="btn btn-secondary" style="flex: 1;" onclick="navigateTo('novelDetail', { novelId: '${novel.id}' })">查看作品</button>
                    </div>
                </div>
            `;
        }

        ui.showToast('AI 已创建小说并生成第一章！');

    } catch (err) {
        console.error('AI 创建失败:', err);
        ui.showToast('AI 创建失败: ' + err.message);
        
        // Show error state
        if (stepsEl) {
            stepsEl.innerHTML += `
                <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 12px; margin-top: 12px;">
                    <div style="color: #b91c1c; font-size: 14px;">❌ 创建失败：${escapeHtml(err.message)}</div>
                </div>
            `;
        }
    }
}

async function createNovel() {
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

function showModelConfigModal() {
    const modal = createModal('模型配置', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">API Key</label>
            <input type="password" class="input" id="model-api-key" placeholder="输入你的 API Key..."></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">模型</label>
            <select class="input" id="model-name" onchange="toggleCustomModelRow()">
                <option value="glm-5.1">GLM-5.1（智谱）</option>
                <option value="glm-4.5">GLM-4.5（智谱）</option>
                <option value="glm-4">GLM-4（智谱）</option>
                <option value="deepseek-chat">DeepSeek Chat</option>
                <option value="deepseek-reasoner">DeepSeek Reasoner</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4">GPT-4</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                <option value="claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                <option value="custom">自定义模型名</option>
            </select></div>
            <div id="custom-model-row" style="display:none;"><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">模型名</label>
            <input type="text" class="input" id="model-custom-name" placeholder="如：glm-5.1"></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">Base URL（可选）</label>
            <input type="text" class="input" id="model-base-url" placeholder="https://api.deepseek.com"></div>
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
        await settings.setModelConfig({
            provider: 'custom',
            model,
            apiKey,
            baseUrl: baseUrl || undefined
        });
        ui.showToast('模型配置成功！');
        closeModal();
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
    outlineEditData = { novelId, outline };

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
        await novelManager.saveOutline(outlineEditData.novelId, outlineEditData.outline);
        ui.showToast('大纲已保存');
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
