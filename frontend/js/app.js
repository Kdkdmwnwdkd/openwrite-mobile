/**
 * OpenWrite Mobile - Pure Frontend Architecture
 * All logic runs in the browser/webkit. No backend server required.
 * Data stored in IndexedDB. AI calls go directly to provider APIs.
 */

// ===== Configuration =====
const CONFIG = {
    VERSION: '2.1.0',
    APP_NAME: 'OpenWrite',
    DB_NAME: 'OpenWriteDB',
    DB_VERSION: 2
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
    }
};

// ===== AI API Client =====
const ai = {
    async chat(messages, onStream = null, maxTokens = 4000) {
        const config = await settings.getModelConfig();
        if (!config.apiKey) {
            throw new Error('请先配置 API Key');
        }

        const url = config.baseUrl ? `${config.baseUrl}/chat/completions` : 'https://api.deepseek.com/chat/completions';

        const body = {
            model: config.model || 'deepseek-chat',
            messages: messages,
            stream: !!onStream,
            temperature: 0.7,
            max_tokens: maxTokens
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
        // 蒸馏
        distill: renderDistill,
        distillTemplates: renderDistillTemplates,
        distillResult: () => renderDistillResult(params.templateId),
        distillWrite: () => renderDistillWrite(params.templateId)
    };

    if (renderers[page]) renderers[page](view);
    window.scrollTo(0, 0);
}

// ===== Chat / Home Page =====
function renderChat(container) {
    ui.setPageTitle('新对话');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="showModelIndicator()">${store.modelName || 'glm-5.1'}</button>
    `);

    container.innerHTML = `
        <div style="padding: 16px; display: flex; flex-direction: column; min-height: calc(100vh - 140px);">
            <!-- 功能工作台：蒸馏 / 技能审查 置顶（用户核心功能） -->
            <div class="workbench">
                <div class="workbench-title">创作者工作台</div>
                <div class="workbench-grid">
                    <div class="workbench-item primary" onclick="navigateTo('distill')">
                        <div class="workbench-icon">✨</div>
                        <div class="workbench-name">蒸馏</div>
                        <div class="workbench-desc">学风格写</div>
                    </div>
                    <div class="workbench-item primary" onclick="navigateTo('skillCenter')">
                        <div class="workbench-icon">🧪</div>
                        <div class="workbench-name">去AI味</div>
                        <div class="workbench-desc">审查润色</div>
                    </div>
                    <div class="workbench-item" onclick="showNameGenerator()">
                        <div class="workbench-icon">📛</div>
                        <div class="workbench-name">起名</div>
                        <div class="workbench-desc">角色灵感</div>
                    </div>
                    <div class="workbench-item" onclick="showDeconstruct()">
                        <div class="workbench-icon">🔎</div>
                        <div class="workbench-name">拆解</div>
                        <div class="workbench-desc">结构分析</div>
                    </div>
                    <div class="workbench-item" onclick="showRank()">
                        <div class="workbench-icon">📊</div>
                        <div class="workbench-name">扫榜</div>
                        <div class="workbench-desc">市场风向</div>
                    </div>
                    <div class="workbench-item" onclick="showMemory()">
                        <div class="workbench-icon">🧠</div>
                        <div class="workbench-name">记忆</div>
                        <div class="workbench-desc">写作设定</div>
                    </div>
                </div>
            </div>

            <!-- 快捷操作（旧快捷按钮替代：小说/对话直达） -->
            <div style="display: flex; gap: 8px; overflow-x: auto; margin-bottom: 20px; padding-bottom: 4px;">
                <div class="quick-action" onclick="navigateTo('bookshelf')">
                    <span class="quick-icon">📖</span>
                    <span>我的小说</span>
                </div>
                <div class="quick-action" onclick="continueWriting()">
                    <span class="quick-icon">✍️</span>
                    <span>继续写作</span>
                </div>
                <div class="quick-action" onclick="navigateTo('skillHistory')">
                    <span class="quick-icon">📜</span>
                    <span>审查历史</span>
                </div>
            </div>

            <!-- Main Actions -->
            <div class="main-actions">
                <div class="action-card" onclick="showCreateNovelModal()">
                    <div class="action-icon">📚</div>
                    <div class="action-content">
                        <div class="action-title">新书启航</div>
                        <div class="action-desc">初始化小说项目，创建目录结构</div>
                    </div>
                    <span class="action-arrow">›</span>
                </div>

                <div class="action-card" onclick="showTutorial()">
                    <div class="action-icon">📖</div>
                    <div class="action-content">
                        <div class="action-title">使用教程</div>
                        <div class="action-desc">快速上手：蒸馏、审查、写作</div>
                    </div>
                    <span class="action-arrow">›</span>
                </div>
            </div>

            <!-- 对话记录 -->
            <div id="chat-messages" class="chat-messages">
                <div class="chat-welcome">
                    <div class="chat-welcome-icon">✒️</div>
                    <div class="chat-welcome-text">你好，我是你的 AI 写作搭子。<br>可以直接告诉我你的写作想法，也可以先用「蒸馏」学一本好书的风格。</div>
                </div>
            </div>
        </div>

        <!-- Chat Input Area -->
        <div class="chat-input-area">
            <div class="chat-input-wrapper">
                <textarea class="chat-textarea" id="chat-input" placeholder="写下你的故事..."></textarea>
                <div class="chat-actions">
                    <button class="chat-action-btn" onclick="openSkillPicker()">@ 技能</button>
                    <button class="chat-action-btn" onclick="attachFile()"># 文件</button>
                    <button class="chat-action-btn" onclick="rollDice()">🎲</button>
                    <button class="chat-send-btn" onclick="sendMessage()">➤</button>
                </div>
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
    const welcome = messagesBox.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

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

// ===== Bookshelf Page =====
async function renderBookshelf(container) {
    ui.setPageTitle('我的小说');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="showCreateNovelModal()">+ 新建</button>
    `);
    ui.showLoading(container);

    try {
        const novels = await novelManager.list();
        store.novels = novels;

        if (novels.length === 0) {
            ui.showEmptyState(container, {
                icon: '📖',
                title: '书架空空如也',
                desc: '点击右上角 + 新建开始创作你的第一部小说'
            });
            return;
        }

        container.innerHTML = `
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

        container.innerHTML = `
            <div class="novel-header-card">
                <div class="novel-header-cover">${novel.title.charAt(0)}</div>
                <div class="novel-header-info">
                    <div class="novel-header-title">${novel.title}</div>
                    <div class="novel-header-meta">${novel.chapterCount || 0}章 · ${(novel.wordCount || 0).toLocaleString()}字</div>
                    <div class="novel-header-desc">${novel.description || '暂无简介'}</div>
                </div>
            </div>

            <div class="action-buttons-row">
                <button class="btn btn-primary" onclick="showWriteChapterModal('${novelId}')">✍️ 写新章节</button>
                <button class="btn btn-secondary" onclick="aiWriteNext('${novelId}')">🤖 AI续写</button>
            </div>

            <div class="chapter-list">
                ${chapters.length === 0
                    ? '<div class="empty-state" style="padding: 40px 20px;"><div class="empty-icon">📝</div><div class="empty-title">暂无章节</div></div>'
                    : chapters.map(ch => `
                        <div class="chapter-item" onclick="navigateTo('chapterEdit', { novelId: '${novelId}', chapterNum: ${ch.number} })">
                            <span class="chapter-num">第${ch.number}章</span>
                            <span class="chapter-title">${ch.title}</span>
                            <span class="chapter-status written">${(ch.wordCount || 0).toLocaleString()}字</span>
                        </div>
                    `).join('')}
            </div>`;
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

// ===== Settings Page =====
async function renderSettings(container) {
    ui.setPageTitle('设置');
    ui.setHeaderActions();

    const config = await settings.getModelConfig();
    const stats = await novelManager.getStats();
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
        </div>

        <div class="settings-group">
            <div class="settings-group-title">数据统计</div>
            <div class="settings-item">
                <div class="settings-item-left">
                    <div class="settings-icon">📚</div>
                    <div><div class="settings-label">作品总数</div><div class="settings-value">${stats.totalNovels} 部</div></div>
                </div>
            </div>
            <div class="settings-item">
                <div class="settings-item-left">
                    <div class="settings-icon">📝</div>
                    <div><div class="settings-label">章节总数</div><div class="settings-value">${stats.totalChapters} 章</div></div>
                </div>
            </div>
            <div class="settings-item">
                <div class="settings-item-left">
                    <div class="settings-icon">📊</div>
                    <div><div class="settings-label">总字数</div><div class="settings-value">${stats.totalWords.toLocaleString()} 字</div></div>
                </div>
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
            <button class="btn btn-primary btn-block" onclick="createNovel()">创建</button>
        </div>`);
    modal.show();
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

function showModelConfigModal() {
    const modal = createModal('模型配置', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">API Key</label>
            <input type="password" class="input" id="model-api-key" placeholder="输入你的 API Key..."></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">模型</label>
            <select class="input" id="model-name">
                <option value="deepseek-chat">DeepSeek Chat</option>
                <option value="deepseek-reasoner">DeepSeek Reasoner</option>
                <option value="gpt-4">GPT-4</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                <option value="claude-3-sonnet">Claude 3 Sonnet</option>
                <option value="glm-4">GLM-4</option>
            </select></div>
            <div><label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">Base URL（可选）</label>
            <input type="text" class="input" id="model-base-url" placeholder="https://api.deepseek.com"></div>
            <button class="btn btn-primary btn-block" onclick="configureModel()">保存配置</button>
        </div>`);
    modal.show();
}

async function configureModel() {
    const apiKey = document.getElementById('model-api-key').value.trim();
    const model = document.getElementById('model-name').value;
    const baseUrl = document.getElementById('model-base-url').value.trim();

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
