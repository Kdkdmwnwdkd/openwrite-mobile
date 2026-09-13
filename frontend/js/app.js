/**
 * OpenWrite Mobile - Core Application Logic
 * PWA frontend that consumes the FastAPI backend
 */

// ===== Configuration =====
const CONFIG = {
    API_BASE: window.location.origin.includes('localhost') 
        ? 'http://localhost:4567' 
        : window.location.origin,
    VERSION: '2.0.1',
    APP_NAME: 'OpenWrite'
};

// ===== State Management =====
const store = {
    currentPage: 'bookshelf',
    currentNovel: null,
    currentChapter: null,
    novels: [],
    chapters: [],
    modelConfigured: false,
    
    save(key, value) {
        localStorage.setItem(`ow_${key}`, JSON.stringify(value));
    },
    
    load(key, defaultValue = null) {
        try {
            const data = localStorage.getItem(`ow_${key}`);
            return data ? JSON.parse(data) : defaultValue;
        } catch {
            return defaultValue;
        }
    },
    
    remove(key) {
        localStorage.removeItem(`ow_${key}`);
    }
};

// ===== API Client =====
const api = {
    async request(endpoint, options = {}) {
        const url = `${CONFIG.API_BASE}${endpoint}`;
        const defaults = {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };
        
        try {
            const response = await fetch(url, { ...defaults, ...options });
            
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.detail || `HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (err) {
            console.error('API Error:', err);
            throw err;
        }
    },
    
    async get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    },
    
    async post(endpoint, data) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
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
        container.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
            </div>
        `;
    },
    
    showEmptyState(container, { icon = '📚', title = '暂无内容', desc = '点击添加按钮开始创作' }) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${icon}</div>
                <div class="empty-title">${title}</div>
                <div class="empty-desc">${desc}</div>
            </div>
        `;
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
    
    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });
    
    // Hide all views
    document.querySelectorAll('.page-view').forEach(view => {
        view.classList.remove('active');
    });
    
    // Show target view or render it
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
    
    // Route to page renderer
    const renderers = {
        bookshelf: renderBookshelf,
        writing: renderWriting,
        settings: renderSettings,
        novelDetail: () => renderNovelDetail(params.novelId),
        chapterEdit: () => renderChapterEdit(params.novelId, params.chapterNum),
        about: renderAbout
    };
    
    if (renderers[page]) {
        renderers[page](view);
    }
    
    window.scrollTo(0, 0);
}

// ===== Bookshelf Page =====
async function renderBookshelf(container) {
    ui.setPageTitle('书架');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="showCreateNovelModal()">+ 新建</button>
    `);
    
    ui.showLoading(container);
    
    try {
        const data = await api.get('/api/novels');
        store.novels = data.novels || [];
        
        if (store.novels.length === 0) {
            ui.showEmptyState(container, {
                icon: '📖',
                title: '书架空空如也',
                desc: '点击右上角 + 新建开始创作你的第一部小说'
            });
            return;
        }
        
        container.innerHTML = `
            <div class="novel-list">
                ${store.novels.map(novel => `
                    <div class="novel-item" onclick="navigateTo('novelDetail', { novelId: '${novel.id}' })">
                        <div class="novel-cover">${novel.title.charAt(0)}</div>
                        <div class="novel-info">
                            <div class="novel-title">${novel.title}</div>
                            <div class="novel-meta">${novel.id} · 最后更新 ${formatDate(novel.modified)}</div>
                            <div class="novel-progress">
                                <div class="novel-progress-bar" style="width: 30%"></div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (err) {
        ui.showEmptyState(container, {
            icon: '⚠️',
            title: '加载失败',
            desc: err.message
        });
    }
}

// ===== Novel Detail Page =====
async function renderNovelDetail(container, novelId) {
    const novel = store.novels.find(n => n.id === novelId);
    ui.setPageTitle(novel?.title || '作品详情');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('bookshelf')">返回</button>
    `);
    
    ui.showLoading(container);
    
    try {
        const data = await api.get(`/api/novels/${novelId}`);
        store.currentNovel = data;
        
        container.innerHTML = `
            <div style="margin-bottom: 16px;">
                <div class="card">
                    <div class="card-title">${data.id}</div>
                    <div class="card-subtitle">${data.chapter_count} 章 · ${data.description?.split('\n')[0] || '暂无简介'}</div>
                </div>
            </div>
            
            <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                <button class="btn btn-primary btn-block" onclick="showWriteChapterModal('${novelId}')">
                    ✍️ 写新章节
                </button>
                <button class="btn btn-secondary btn-block" onclick="navigateTo('writing', { novelId: '${novelId}' })">
                    📋 工作台
                </button>
            </div>
            
            <div class="chapter-list">
                ${data.chapters.length === 0 
                    ? '<div class="empty-state"><div class="empty-icon">📝</div><div class="empty-title">暂无章节</div><div class="empty-desc">点击上方按钮开始写作</div></div>'
                    : data.chapters.map(ch => `
                        <div class="chapter-item" onclick="navigateTo('chapterEdit', { novelId: '${novelId}', chapterNum: ${ch.number} })">
                            <span class="chapter-num">第${ch.number}章</span>
                            <span class="chapter-title">${ch.title}</span>
                            <span class="chapter-status written">${ch.word_count}字</span>
                        </div>
                    `).join('')
                }
            </div>
        `;
    } catch (err) {
        ui.showEmptyState(container, {
            icon: '⚠️',
            title: '加载失败',
            desc: err.message
        });
    }
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
            
            <button class="btn btn-primary btn-block" style="margin-top: 12px;" onclick="startWriting()">
                🤖 开始写作
            </button>
        </div>
        
        <div class="card" style="margin-top: 12px;">
            <div class="card-title">📊 写作统计</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 12px;">
                <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: 600; color: var(--primary);">0</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">今日字数</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: 600; color: var(--primary);">0</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">今日章节</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: 600; color: var(--primary);">0</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">连续天数</div>
                </div>
            </div>
        </div>
    `;
}

// ===== Chapter Edit Page =====
async function renderChapterEdit(container, novelId, chapterNum) {
    ui.setPageTitle(`第${chapterNum}章`);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
        <button class="header-btn" onclick="saveChapter('${novelId}', ${chapterNum})">保存</button>
    `);
    
    try {
        const data = await api.get(`/api/novels/${novelId}/chapters/${chapterNum}`);
        
        container.innerHTML = `
            <div class="editor-container">
                <input type="text" class="editor-title-input" id="chapter-title" 
                    value="${data.title}" placeholder="章节标题...">
                <textarea class="editor-content" id="chapter-content" 
                    placeholder="在此开始写作...">${data.content}</textarea>
            </div>
            
            <div style="display: flex; gap: 8px; margin-top: 12px;">
                <button class="btn btn-secondary btn-block" onclick="reviewChapter('${novelId}', ${chapterNum})">
                    🔍 AI审稿
                </button>
                <button class="btn btn-primary btn-block" onclick="aiContinue('${novelId}', ${chapterNum})">
                    ✨ AI续写
                </button>
            </div>
        `;
    } catch (err) {
        ui.showEmptyState(container, {
            icon: '⚠️',
            title: '加载失败',
            desc: err.message
        });
    }
}

// ===== Settings Page =====
async function renderSettings(container) {
    ui.setPageTitle('设置');
    ui.setHeaderActions();
    
    try {
        const modelStatus = await api.get('/api/model/status');
        const stats = await api.get('/api/stats');
        
        container.innerHTML = `
            <div class="settings-group">
                <div class="settings-group-title">AI 模型</div>
                <div class="settings-item" onclick="showModelConfigModal()">
                    <div class="settings-item-left">
                        <div class="settings-icon">🤖</div>
                        <div>
                            <div class="settings-label">模型配置</div>
                            <div class="settings-value">${modelStatus.configured ? modelStatus.model : '未配置'}</div>
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
                        <div>
                            <div class="settings-label">作品总数</div>
                            <div class="settings-value">${stats.total_novels} 部</div>
                        </div>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-left">
                        <div class="settings-icon">📝</div>
                        <div>
                            <div class="settings-label">章节总数</div>
                            <div class="settings-value">${stats.total_chapters} 章</div>
                        </div>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-left">
                        <div class="settings-icon">📊</div>
                        <div>
                            <div class="settings-label">总字数</div>
                            <div class="settings-value">${stats.total_words.toLocaleString()} 字</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="settings-group">
                <div class="settings-group-title">关于</div>
                <div class="settings-item" onclick="navigateTo('about')">
                    <div class="settings-item-left">
                        <div class="settings-icon">ℹ️</div>
                        <div>
                            <div class="settings-label">关于 OpenWrite</div>
                            <div class="settings-value">版本 ${CONFIG.VERSION}</div>
                        </div>
                    </div>
                    <span class="settings-arrow">›</span>
                </div>
                <div class="settings-item" onclick="checkForUpdates()">
                    <div class="settings-item-left">
                        <div class="settings-icon">🔄</div>
                        <div>
                            <div class="settings-label">检查更新</div>
                            <div class="settings-value">当前版本 ${CONFIG.VERSION}</div>
                        </div>
                    </div>
                    <span class="settings-arrow">›</span>
                </div>
            </div>
        `;
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <div class="empty-title">加载失败</div>
                <div class="empty-desc">${err.message}</div>
            </div>
        `;
    }
}

// ===== About Page =====
function renderAbout(container) {
    ui.setPageTitle('关于');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('settings')">返回</button>
    `);
    
    container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px;">
            <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #818cf8, #6366f1); 
                        border-radius: 20px; margin: 0 auto 20px; display: flex; align-items: center; 
                        justify-content: center; color: white; font-size: 36px;">
                ✨
            </div>
            <h1 style="font-size: 24px; margin-bottom: 8px;">OpenWrite</h1>
            <div style="display: inline-block; padding: 4px 16px; background: var(--bg); 
                        border-radius: 20px; font-size: 14px; color: var(--text-secondary); margin-bottom: 16px;">
                版本 ${CONFIG.VERSION}
            </div>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 32px;">
                你的 AI 小说写作助手
            </p>
        </div>
        
        <div class="settings-group">
            <div class="settings-group-title">加入社区</div>
            <div class="settings-item" onclick="window.open('https://github.com/LiPu-jpg/Openwrite', '_blank')">
                <div class="settings-item-left">
                    <div class="settings-icon">💬</div>
                    <div>
                        <div class="settings-label">OpenWrite AI 写作交流群</div>
                        <div class="settings-value">群号 1106407987</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>
        
        <div class="settings-group">
            <div class="settings-group-title">资源</div>
            <div class="settings-item">
                <div class="settings-item-left">
                    <div class="settings-icon">📖</div>
                    <div>
                        <div class="settings-label">使用教程</div>
                        <div class="settings-value">快速上手指南</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item">
                <div class="settings-item-left">
                    <div class="settings-icon">💡</div>
                    <div>
                        <div class="settings-label">意见反馈</div>
                        <div class="settings-value">问题和建议直达开发者后台</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
            <div class="settings-item">
                <div class="settings-item-left">
                    <div class="settings-icon">💻</div>
                    <div>
                        <div class="settings-label">Windows 版下载</div>
                        <div class="settings-value">在电脑上获得完整写作体验</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>
        
        <div class="settings-group">
            <div class="settings-group-title">帮助与维护</div>
            <div class="settings-item" onclick="checkForUpdates()">
                <div class="settings-item-left">
                    <div class="settings-icon">⬇️</div>
                    <div>
                        <div class="settings-label">检查更新</div>
                        <div class="settings-value">当前版本 ${CONFIG.VERSION}</div>
                    </div>
                </div>
                <span class="settings-arrow">›</span>
            </div>
        </div>
        
        <div style="text-align: center; padding: 32px 20px; color: var(--text-secondary); font-size: 12px;">
            <p>基于 OpenWrite 开源项目构建</p>
            <p style="margin-top: 4px;">Apache-2.0 License</p>
        </div>
    `;
}

// ===== Actions =====
function showCreateNovelModal() {
    const modal = createModal('新建作品', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div>
                <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">作品名称</label>
                <input type="text" class="input" id="new-novel-title" placeholder="输入作品名称...">
            </div>
            <div>
                <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">简介（可选）</label>
                <textarea class="textarea" id="new-novel-desc" placeholder="简单描述你的作品..." style="min-height: 80px;"></textarea>
            </div>
            <div>
                <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">类型（可选）</label>
                <select class="input" id="new-novel-genre">
                    <option value="">选择类型...</option>
                    <option value="玄幻">玄幻</option>
                    <option value="仙侠">仙侠</option>
                    <option value="都市">都市</option>
                    <option value="科幻">科幻</option>
                    <option value="历史">历史</option>
                    <option value="悬疑">悬疑</option>
                    <option value="言情">言情</option>
                    <option value="其他">其他</option>
                </select>
            </div>
            <button class="btn btn-primary btn-block" onclick="createNovel()">创建</button>
        </div>
    `);
    modal.show();
}

async function createNovel() {
    const title = document.getElementById('new-novel-title').value.trim();
    const desc = document.getElementById('new-novel-desc').value.trim();
    const genre = document.getElementById('new-novel-genre').value;
    
    if (!title) {
        ui.showToast('请输入作品名称');
        return;
    }
    
    try {
        await api.post('/api/novels', { title, description: desc, genre });
        ui.showToast('作品创建成功！');
        closeModal();
        navigateTo('bookshelf');
    } catch (err) {
        ui.showToast('创建失败: ' + err.message);
    }
}

function showModelConfigModal() {
    const modal = createModal('模型配置', `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div>
                <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">API Key</label>
                <input type="password" class="input" id="model-api-key" placeholder="输入你的 API Key...">
            </div>
            <div>
                <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">模型</label>
                <select class="input" id="model-name">
                    <option value="deepseek-chat">DeepSeek Chat</option>
                    <option value="deepseek-reasoner">DeepSeek Reasoner</option>
                    <option value="gpt-4">GPT-4</option>
                    <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                    <option value="claude-3-sonnet">Claude 3 Sonnet</option>
                    <option value="glm-4">GLM-4</option>
                </select>
            </div>
            <div>
                <label style="display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500;">Base URL（可选）</label>
                <input type="text" class="input" id="model-base-url" placeholder="https://api.deepseek.com">
            </div>
            <button class="btn btn-primary btn-block" onclick="configureModel()">保存配置</button>
        </div>
    `);
    modal.show();
}

async function configureModel() {
    const apiKey = document.getElementById('model-api-key').value.trim();
    const model = document.getElementById('model-name').value;
    const baseUrl = document.getElementById('model-base-url').value.trim();
    
    if (!apiKey) {
        ui.showToast('请输入 API Key');
        return;
    }
    
    try {
        await api.post('/api/model/configure', {
            api_key: apiKey,
            model,
            base_url: baseUrl || undefined
        });
        ui.showToast('模型配置成功！');
        closeModal();
    } catch (err) {
        ui.showToast('配置失败: ' + err.message);
    }
}

async function startWriting() {
    const novelId = document.getElementById('writing-novel-select').value;
    const chapterNum = parseInt(document.getElementById('writing-chapter-num').value);
    const prompt = document.getElementById('writing-prompt').value.trim();
    
    if (!novelId) {
        ui.showToast('请选择作品');
        return;
    }
    if (!chapterNum || chapterNum < 1) {
        ui.showToast('请输入有效的章节号');
        return;
    }
    
    try {
        await api.post(`/api/novels/${novelId}/write`, {
            novel_id: novelId,
            chapter_number: chapterNum,
            prompt,
            model: 'deepseek-chat'
        });
        ui.showToast('AI 正在写作中，请稍后查看...');
    } catch (err) {
        ui.showToast('写作请求失败: ' + err.message);
    }
}

async function saveChapter(novelId, chapterNum) {
    const title = document.getElementById('chapter-title').value;
    const content = document.getElementById('chapter-content').value;
    
    // In a full implementation, this would POST to backend
    // For now, we'll simulate with localStorage
    store.save(`chapter_${novelId}_${chapterNum}`, { title, content });
    ui.showToast('章节已保存');
}

async function reviewChapter(novelId, chapterNum) {
    try {
        const result = await api.post(`/api/novels/${novelId}/review`, {
            novel_id: novelId,
            chapter_number: chapterNum
        });
        
        const modal = createModal('AI 审稿结果', `
            <div style="white-space: pre-wrap; font-size: 14px; line-height: 1.6; max-height: 60vh; overflow-y: auto;">
                ${result.review || '暂无审稿结果'}
            </div>
        `);
        modal.show();
    } catch (err) {
        ui.showToast('审稿失败: ' + err.message);
    }
}

function aiContinue(novelId, chapterNum) {
    ui.showToast('AI 续写功能开发中...');
}

function checkForUpdates() {
    ui.showToast('当前已是最新版本 ' + CONFIG.VERSION);
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
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    requestAnimationFrame(() => overlay.classList.add('active'));
    
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    
    return {
        show: () => overlay.classList.add('active'),
        close: () => overlay.remove()
    };
}

function closeModal() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) modal.remove();
}

// ===== Utilities =====
function formatDate(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
    
    return date.toLocaleDateString('zh-CN');
}

// ===== Service Worker Registration (PWA) =====
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW registered'))
            .catch(err => console.log('SW registration failed'));
    });
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    // Check API health
    api.get('/api/health')
        .then(data => {
            console.log('API Health:', data);
            if (data.status === 'ok') {
                ui.showToast('已连接到 OpenWrite 后端');
            }
        })
        .catch(() => {
            ui.showToast('无法连接到后端服务，请确保后端已启动');
        });
    
    // Navigate to default page
    navigateTo('bookshelf');
});

// Prevent double-tap zoom on mobile
document.addEventListener('dblclick', (e) => {
    e.preventDefault();
}, { passive: false });
