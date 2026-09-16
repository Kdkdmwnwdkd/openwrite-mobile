/**
 * OpenWrite Mobile - 蒸馏功能
 * 上传书籍 → AI 分析作者写法与风格 → 生成风格模板 → 按模板仿写
 * 数据存储在 IndexedDB (templates store)
 */

// ===== 蒸馏管理器 =====
const distillManager = {
    /** 读取本地文件为文本（支持 txt/md；UTF-8/GBK 自动探测） */
    readFileAsText(file, onProgress) {
        return new Promise((resolve, reject) => {
            if (!file) { reject(new Error('未选择文件')); return; }
            const name = (file.name || '').toLowerCase();
            const ext = name.split('.').pop() || '';

            if (['txt', 'md', 'markdown', 'text', 'log'].includes(ext)) {
                // 纯文本：尝试多种编码
                const reader = new FileReader();
                reader.onload = () => {
                    const buffer = reader.result;
                    resolve({ text: decodeText(buffer), fileName: file.name, size: file.size });
                };
                reader.onerror = () => reject(new Error('文件读取失败'));
                reader.readAsArrayBuffer(file);
            } else if (ext === 'epub') {
                reject(new Error('epub 为压缩格式，暂不支持直接解析。请先用工具转换成 txt 后导入。'));
            } else {
                reject(new Error(`暂不支持 ${ext || '未知'} 格式，请使用 txt / md 文本文件`));
            }
        });
    },

    async saveTemplate(template) {
        const existing = await db.getAll('templates');
        const count = existing.length;
        template.id = template.id || 'tpl_' + Date.now();
        template.created = template.created || Date.now();
        template.updated = Date.now();
        await db.put('templates', template);
        return template;
    },

    async listTemplates() {
        try {
            const list = await db.getAll('templates');
            return list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        } catch (e) { return []; }
    },

    async getTemplate(id) {
        try { return await db.get('templates', id); } catch (e) { return null; }
    },

    async deleteTemplate(id) {
        try { await db.delete('templates', id); } catch (e) { /* ignore */ }
    }
};

/**
 * 文本解码：优先 UTF-8（含 BOM 检测），失败回退 GBK
 */
function decodeText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);

    // BOM 检测
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return new TextDecoder('utf-8').decode(bytes.slice(3));
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(bytes.slice(2));
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(bytes.slice(2));
    }

    // 尝试 UTF-8
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
        // 回退 GBK / GB18030（多标签尝试，兼容不同环境）
        for (const label of ['gbk', 'gb18030']) {
            try {
                return new TextDecoder(label).decode(bytes);
            } catch (e2) { /* 该环境不支持此标签，尝试下一个 */ }
        }
        // 最终兜底：宽松 UTF-8
        return new TextDecoder('utf-8').decode(bytes);
    }
}

// ===== 蒸馏 AI 分析引擎 =====
const distillEngine = {
    /** 风格分析 System Prompt */
    buildStylePrompt() {
        return `你是一位资深文学评论家与网文编辑，精通不同作者、不同流派的写作风格分析。

【任务】分析用户提供的书籍文本片段，提炼作者的独特写作风格，生成一份结构化的"风格档案"。

【分析维度】
1. 叙事视角与人称（如：第三人称限知/全知、第一人称等）
2. 语言风格（句式长短、用词特点、修辞偏好、口语/书面语倾向）
3. 人物塑造方法（如何刻画人物、对话特点、心理描写方式）
4. 场景与氛围描写（环境描写风格、感官运用)
5. 情节节奏（冲突推进方式、章节转折特点、悬念设置）
6. 情感表达方式（含蓄/直白、抒情特征）
7. 独特标签（该作者区别于他人的3-5个核心写作特征）
8. 适仿提示（如果要模仿这本书的风格写作，最关键要注意什么）

【严格输出要求】
只输出 JSON 对象，不要输出任何其他文字、Markdown 代码块标记。格式如下：
{
  "bookStyle": {
    "perspective": "叙事视角与人称分析",
    "language": "语言风格分析",
    "characterization": "人物塑造方法",
    "sceneDescription": "场景与氛围描写",
    "pacing": "情节节奏",
    "emotion": "情感表达",
    "signature": ["独特标签1", "独特标签2", "独特标签3", "独特标签4"],
    "imitationTips": "模仿写作最关键的建议"
  },
  "fullAnalysis": "整体风格分析总结（300-500字）"
}`;
    },

    /** 分段提取风格特征 */
    async extractStyle(text, onProgress) {
        const MAX_CHUNK = 6000;
        const MAX_SAMPLE = 24000; // 最多分析 24000 字样本

        let sample = text;
        // 尝试智能取样：开头 + 中间 + 结尾
        if (text.length > MAX_SAMPLE) {
            const head = text.slice(0, 8000);
            const mid = text.slice(Math.floor(text.length / 2) - 4000, Math.floor(text.length / 2) + 4000);
            const tail = text.slice(text.length - 8000);
            sample = head + '\n\n[中段节选]\n\n' + mid + '\n\n[后段节选]\n\n' + tail;
            if (onProgress) onProgress('书籍较长，已自动取样开头/中间/结尾三处进行分析');
        }

        const chunks = [];
        for (let i = 0; i < sample.length; i += MAX_CHUNK) {
            chunks.push(sample.slice(i, i + MAX_CHUNK));
        }
        if (chunks.length > 2) {
            // 只取前两段做风格分析（控制成本）
            chunks.length = 2;
        }

        const analyses = [];
        for (let i = 0; i < chunks.length; i++) {
            if (onProgress) onProgress(`正在分析第 ${i + 1}/${chunks.length} 部分（约 ${chunks[i].length} 字）...`);
            const isLast = i === chunks.length - 1;
            let userMsg = `以下是书籍文本${chunks.length > 1 ? `第${i + 1}段` : ''}：\n\n${chunks[i]}`;
            if (!isLast) userMsg += '\n\n【注意】这只是全书的一部分，请先记录此段的风格线索。';
            else userMsg += '\n\n【注意】这是最后一段样本。请综合前面所有段落，输出完整JSON风格档案。';

            let response;
            try {
                response = await ai.chat([
                    { role: 'system', content: this.buildStylePrompt() },
                    { role: 'user', content: userMsg }
                ], null, 8000);
            } catch (err) {
                throw new Error('风格分析调用失败: ' + err.message);
            }
            analyses.push(response);
        }

        // 合并解析 JSON
        const lastRaw = analyses[analyses.length - 1];
        const parsed = this.extractJSON(lastRaw);
        if (parsed && parsed.bookStyle) {
            return parsed;
        }

        // 合并所有段落的原始分析，生成总结
        const merged = analyses.join('\n\n---\n\n');
        const summary = await this.mergeAnalyses(merged, onProgress);
        return summary;
    },

    /** 合并多段分析为最终风格档案 */
    async mergeAnalyses(analysesText, onProgress) {
        if (onProgress) onProgress('正在综合各段分析，生成完整风格档案...');
        const raw = await ai.chat([
            { role: 'system', content: this.buildStylePrompt() },
            { role: 'user', content: '以下是 AI 对书籍不同段落的分析结果，请综合为一份完整JSON风格档案：\n\n' + analysesText }
        ], null, 8000);
        return this.extractJSON(raw) || { fullAnalysis: raw, rawText: raw };
    },

    /** 容错提取 JSON */
    extractJSON(text) {
        if (!text) return null;
        let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return null;
        cleaned = cleaned.slice(start, end + 1);
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            try {
                cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
                return JSON.parse(cleaned);
            } catch (e2) {
                return null;
            }
        }
    },

    /** 仿写 Prompt */
    buildImitationPrompt(template, outline) {
        const style = template.style || {};
        const styleText = `
【风格档案】
- 叙事视角与人称：${style.perspective || '未提取'}
- 语言风格：${style.language || '未提取'}
- 人物塑造：${style.characterization || '未提取'}
- 场景描写：${style.sceneDescription || '未提取'}
- 情节节奏：${style.pacing || '未提取'}
- 情感表达：${style.emotion || '未提取'}
- 独特标签：${Array.isArray(style.signature) ? style.signature.join('、') : '未提取'}
- 模仿要点：${style.imitationTips || ''}

【全文分析】${template.fullAnalysis || ''}`;

        return `你是一位精通风格的作家，正在模仿《${template.bookName || '参考书籍'}》的作者风格进行创作。

${styleText}

【你的任务】
根据用户提供的创作要求，用上述风格写一部${template.genre || '小说'}的开篇（约2000-3000字）。
要求：
1. 严格遵循风格档案中的所有特征，让文字读起来就像该书的作者亲笔所写；
2. 不要提及"模仿""风格"等字眼，直接以作者口吻写作；
3. 起一个贴合${template.genre || '该书'}类型的书名和第一章标题。`;
    },

    /** 按模板仿写 */
    async imitate(template, userPrompt, onProgress) {
        if (onProgress) onProgress('正在按风格档案创作...');
        const raw = await ai.chat([
            { role: 'system', content: this.buildImitationPrompt(template, userPrompt) },
            { role: 'user', content: userPrompt || '请用该风格创作一部小说的开篇，题材自由发挥，要有吸引力。' }
        ], null, 8000);
        return raw;
    }
};

// ===== 蒸馏页面渲染 =====

// 蒸馏首页：上传书籍
function renderDistill(container) {
    ui.setPageTitle('蒸馏');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('chat')">返回</button>`);

    container.innerHTML = `
        <div class="distill-hero">
            <div class="distill-hero-icon">✨</div>
            <div class="distill-hero-title">蒸馏写作风格</div>
            <div class="distill-hero-desc">上传一本你喜欢的书，AI 分析作者的写法与风格，生成可复用的风格档案，之后一键仿写。</div>
        </div>

        <div class="card">
            <div class="card-title">📤 上传书籍</div>
            <div class="upload-area" id="upload-area" onclick="document.getElementById('file-input').click()">
                <div class="upload-icon">📁</div>
                <div class="upload-text">点击选择 txt / md 文件</div>
                <div class="upload-hint">支持 UTF-8 / GBK 编码，自动取样前后文</div>
                <input type="file" id="file-input" accept=".txt,.md,.markdown,.text,.log,.epub" style="display:none;" onchange="handleDistillFile(this)">
            </div>
            <div id="file-status" style="display:none;margin-top:12px;"></div>
            <div id="distill-progress" style="display:none;margin-top:12px;"></div>
        </div>

        <div class="card" onclick="showTextPaste()">
            <div style="display:flex;align-items:center;gap:12px;">
                <div style="font-size:22px;">📝</div>
                <div style="flex:1;">
                    <div style="font-weight:600;">粘贴文本直接分析</div>
                    <div style="font-size:13px;color:var(--text-secondary);">没有文件？可以直接粘贴书籍片段</div>
                </div>
                <span style="color:var(--text-secondary);">›</span>
            </div>
        </div>

        <div class="card" style="margin-top:16px;" onclick="navigateTo('distillTemplates')">
            <div style="display:flex;align-items:center;gap:12px;">
                <div style="font-size:22px;">🗂️</div>
                <div style="flex:1;">
                    <div style="font-weight:600;">我的风格档案</div>
                    <div style="font-size:13px;color:var(--text-secondary);">管理已蒸馏出的写作风格</div>
                </div>
                <span style="color:var(--text-secondary);">›</span>
            </div>
        </div>
    `;
}

// 处理上传文件
async function handleDistillFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    const statusEl = document.getElementById('file-status');
    statusEl.style.display = 'block';

    try {
        const { text, fileName, size } = await distillManager.readFileAsText(file);
        store.pendingDistillText = text;
        store.pendingDistillName = fileName.replace(/\.[^.]+$/, '');

        const sampleLen = text.length;
        statusEl.innerHTML = `
            <div class="file-ready">
                <div style="font-weight:600;">✅ ${escapeHtml(fileName)}</div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">共 ${sampleLen.toLocaleString()} 字${size > 1048576 ? ` · ${(size / 1048576).toFixed(1)}MB` : ` · ${Math.ceil(size / 1024)}KB`}</div>
            </div>`;

        // 自动弹出分析确认
        if (sampleLen >= 1000) {
            setTimeout(() => startDistill(), 300);
        } else {
            ui.showToast('文本太短，蒸馏效果会不理想，建议至少 1000 字');
        }
    } catch (err) {
        statusEl.innerHTML = `<div class="error-box">⚠️ ${escapeHtml(err.message)}</div>`;
    }
}

// 粘贴文本
function showTextPaste() {
    const modal = createModal('粘贴文本', `
        <div style="display:flex;flex-direction:column;gap:16px;">
            <div><label style="display:block;margin-bottom:6px;font-size:14px;font-weight:500;">书籍名称（可选）</label>
            <input type="text" class="input" id="paste-book-name" placeholder="如：斗破苍穹"></div>
            <div><label style="display:block;margin-bottom:6px;font-size:14px;font-weight:500;">书籍文本</label>
            <textarea class="textarea" id="paste-book-text" placeholder="粘贴书籍片段（建议 2000 字以上，风格提取更准）..." style="min-height:200px;"></textarea></div>
            <button class="btn btn-primary btn-block" onclick="confirmTextPaste()">开始蒸馏</button>
        </div>`);
    modal.show();
}

function confirmTextPaste() {
    const text = document.getElementById('paste-book-text').value.trim();
    const name = document.getElementById('paste-book-name').value.trim() || '粘贴文本';
    if (text.length < 500) { ui.showToast('文本太短，建议至少 500 字'); return; }

    store.pendingDistillText = text;
    store.pendingDistillName = name;
    closeModal();
    setTimeout(() => startDistill(), 200);
}

// 开始蒸馏
async function startDistill() {
    const text = store.pendingDistillText;
    if (!text) { ui.showToast('请先上传书籍'); return; }

    const progressEl = document.getElementById('distill-progress');
    if (progressEl) progressEl.style.display = 'block';

    const statusEl = document.getElementById('file-status');
    if (statusEl) statusEl.innerHTML = '';

    if (progressEl) {
        progressEl.innerHTML = `
            <div class="ai-working" style="margin:0;">
                <div class="ai-working-dots"><span></span><span></span><span></span></div>
                <span id="distill-progress-text">准备分析风格...</span>
            </div>`;
    }

    try {
        const result = await distillEngine.extractStyle(text, (msg) => {
            const el = document.getElementById('distill-progress-text') || document.getElementById('distill-progress');
            if (el) el.textContent = msg;
        });

        // 保存模板
        const bookName = store.pendingDistillName || '未命名书籍';
        const template = {
            bookName,
            genre: store.pendingDistillGenre || '',
            style: result.bookStyle || {},
            fullAnalysis: result.fullAnalysis || result.rawText || '',
            textSample: text.slice(0, 500),
            source: 'distill'
        };
        await distillManager.saveTemplate(template);

        if (progressEl) progressEl.style.display = 'none';
        ui.showToast('风格档案已生成！');
        navigateTo('distillResult', { templateId: template.id });
    } catch (err) {
        if (progressEl) progressEl.style.display = 'none';
        ui.showToast('蒸馏失败: ' + err.message);
    }
}

// 蒸馏结果页
async function renderDistillResult(container, templateId) {
    const template = await distillManager.getTemplate(templateId);
    if (!template) { ui.showToast('风格档案不存在'); navigateTo('distill'); return; }

    ui.setPageTitle('风格档案');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('distillTemplates')">返回</button>
    `);

    const style = template.style || {};
    const tags = Array.isArray(style.signature) ? style.signature.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('') : '';

    container.innerHTML = `
        <div class="tpl-header">
            <div class="tpl-icon">✨</div>
            <div>
                <div class="tpl-name">《${escapeHtml(template.bookName || '未命名')}》风格档案</div>
                <div class="tpl-meta">${formatDate(template.created)} 生成</div>
            </div>
        </div>

        <div class="action-buttons-row">
            <button class="btn btn-primary" onclick="navigateTo('distillWrite', { templateId: '${template.id}' })">✍️ 用此风格写作</button>
            <button class="btn btn-secondary" onclick="confirmDeleteTemplate('${template.id}')">🗑️ 删除</button>
        </div>

        ${tags ? `<div class="card"><div class="card-title">🏷️ 独特标签</div><div class="tag-list">${tags}</div></div>` : ''}

        <div class="card">
            <div class="card-title">🎭 叙事与人称</div>
            <p class="tpl-text">${escapeHtml(style.perspective || '未提取')}</p>
        </div>
        <div class="card">
            <div class="card-title">✒️ 语言风格</div>
            <p class="tpl-text">${escapeHtml(style.language || '未提取')}</p>
        </div>
        <div class="card">
            <div class="card-title">👤 人物塑造</div>
            <p class="tpl-text">${escapeHtml(style.characterization || '未提取')}</p>
        </div>
        <div class="card">
            <div class="card-title">🌄 场景与氛围</div>
            <p class="tpl-text">${escapeHtml(style.sceneDescription || '未提取')}</p>
        </div>
        <div class="card">
            <div class="card-title">⚡ 情节节奏</div>
            <p class="tpl-text">${escapeHtml(style.pacing || '未提取')}</p>
        </div>
        <div class="card">
            <div class="card-title">💗 情感表达</div>
            <p class="tpl-text">${escapeHtml(style.emotion || '未提取')}</p>
        </div>
        <div class="card">
            <div class="card-title">📖 整体分析</div>
            <p class="tpl-text">${escapeHtml(template.fullAnalysis || '')}</p>
        </div>
        <div class="card">
            <div class="card-title">💡 模仿提示</div>
            <p class="tpl-text tpl-tip">${escapeHtml(style.imitationTips || '未提取')}</p>
        </div>

        <div style="height:24px;"></div>
    `;
}

// 模板列表
async function renderDistillTemplates(container) {
    ui.setPageTitle('我的风格档案');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('distill')">返回</button>`);

    const templates = await distillManager.listTemplates();

    if (!templates.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🗂️</div>
                <div class="empty-title">暂无风格档案</div>
                <div class="empty-desc">上传一本书，让 AI 分析作者风格后这里就会出现</div>
                <button class="btn btn-primary" onclick="navigateTo('distill')">去蒸馏</button>
            </div>`;
        return;
    }

    container.innerHTML = `
        <div class="tpl-list">
            ${templates.map(t => `
                <div class="tpl-card" onclick="navigateTo('distillResult', { templateId: '${t.id}' })">
                    <div class="tpl-card-icon">✨</div>
                    <div class="tpl-card-body">
                        <div class="tpl-card-name">《${escapeHtml(t.bookName || '未命名')}》</div>
                        <div class="tpl-card-meta">${formatDate(t.created)} · ${escapeHtml((t.fullAnalysis || '').slice(0, 40))}${(t.fullAnalysis || '').length > 40 ? '...' : ''}</div>
                    </div>
                    <span style="color:var(--text-secondary);font-size:18px;">›</span>
                </div>
            `).join('')}
        </div>`;
}

async function confirmDeleteTemplate(id) {
    const modal = createModal('删除风格档案', `
        <div style="text-align:center;padding:8px 0 16px;">
            <div style="font-size:40px;margin-bottom:12px;">🗑️</div>
            <div style="font-size:15px;line-height:1.6;">确定删除这个风格档案吗？<br>删除后无法恢复。</div>
            <div class="action-buttons-row" style="margin-top:20px;">
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="doDeleteTemplate('${id}')">删除</button>
            </div>
        </div>`);
    modal.show();
}

async function doDeleteTemplate(id) {
    await distillManager.deleteTemplate(id);
    closeModal();
    ui.showToast('已删除');
    navigateTo('distillTemplates');
}

// 仿写页
async function renderDistillWrite(container, templateId) {
    const template = await distillManager.getTemplate(templateId);
    if (!template) { ui.showToast('风格档案不存在'); navigateTo('distillTemplates'); return; }

    ui.setPageTitle('仿写创作');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('distillResult', { templateId: '${template.id}' })">返回</button>
    `);

    const style = template.style || {};

    container.innerHTML = `
        <div class="card" style="margin-bottom:12px;">
            <div class="card-title">✍️ 按《${escapeHtml(template.bookName || '未命名')}》风格写作</div>
            <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.7;">
                ${escapeHtml((style.imitationTips || template.fullAnalysis || '').slice(0, 120))}...
            </div>
            <textarea class="textarea" id="imitation-prompt" placeholder="输入创作要求：类型、主角设定、开局情节等（如：写一个现代都市修仙的开篇，主角是个外卖小哥，意外觉醒前世记忆...）" style="min-height:140px;"></textarea>
            <button class="btn btn-primary btn-block" style="margin-top:12px;" onclick="runImitation('${template.id}')">🚀 开始仿写</button>
        </div>

        <div id="imitation-result-area">
            <div class="card">
                <div class="card-title">创作结果</div>
                <div style="font-size:13px;color:var(--text-secondary);">仿写结果会显示在这里，可直接复制或存入作品。</div>
            </div>
        </div>
    `;
}

async function runImitation(templateId) {
    const template = await distillManager.getTemplate(templateId);
    const prompt = document.getElementById('imitation-prompt').value.trim();

    const resultArea = document.getElementById('imitation-result-area');
    resultArea.innerHTML = `
        <div class="card">
            <div class="ai-working">
                <div class="ai-working-dots"><span></span><span></span><span></span></div>
                <span id="imitation-progress">正在按风格创作...</span>
            </div>
        </div>`;

    try {
        const content = await distillEngine.imitate(template, prompt, (msg) => {
            const el = document.getElementById('imitation-progress');
            if (el) el.textContent = msg;
        });

        store.lastImitation = { templateId, templateName: template.bookName, content };
        resultArea.innerHTML = `
            <div class="card">
                <div class="card-title">✨ 仿写完成</div>
                <div class="polish-output">${escapeHtml(content)}</div>
                <div class="action-buttons-row" style="margin-top:12px;">
                    <button class="btn btn-secondary" onclick="copyImitation()">📋 复制</button>
                    <button class="btn btn-primary" onclick="saveImitationToNovel()">📚 存入作品</button>
                </div>
            </div>`;
    } catch (err) {
        resultArea.innerHTML = `
            <div class="card">
                <div class="error-box">⚠️ 仿写失败：${escapeHtml(err.message)}<br><br>请检查「设置 → 模型配置」中的 API Key 是否正确。</div>
            </div>`;
    }
}

function copyImitation() {
    if (!store.lastImitation) return;
    const text = store.lastImitation.content;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => ui.showToast('已复制'), () => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

async function saveImitationToNovel() {
    if (!store.lastImitation) { ui.showToast('没有可保存的内容'); return; }
    const novels = await novelManager.list();
    if (!novels.length) {
        ui.showToast('请先在「小说」页新建作品');
        setTimeout(() => navigateTo('bookshelf'), 800);
        return;
    }
    const options = novels.map(n => `<option value="${n.id}">${n.title}</option>`).join('');
    const modal = createModal('存入作品', `
        <div style="display:flex;flex-direction:column;gap:16px;">
            <div><label style="display:block;margin-bottom:6px;font-size:14px;font-weight:500;">选择作品</label>
            <select class="input" id="save-novel-select">${options}</select></div>
            <div><label style="display:block;margin-bottom:6px;font-size:14px;font-weight:500;">章节标题（可选）</label>
            <input type="text" class="input" id="save-imitation-title" placeholder="如：第一章"></div>
            <button class="btn btn-primary btn-block" onclick="confirmSaveImitation()">保存</button>
        </div>`);
    modal.show();
}

async function confirmSaveImitation() {
    if (!store.lastImitation) return;
    const novelId = document.getElementById('save-novel-select').value;
    const title = document.getElementById('save-imitation-title').value.trim() || '仿写章节';
    if (!novelId) { ui.showToast('请选择作品'); return; }

    try {
        const chapters = await novelManager.listChapters(novelId);
        const nextNum = chapters.length > 0 ? Math.max(...chapters.map(c => c.number)) + 1 : 1;
        await novelManager.saveChapter(novelId, nextNum, title, store.lastImitation.content);
        ui.showToast(`已保存（第${nextNum}章）`);
        closeModal();
    } catch (err) {
        ui.showToast('保存失败: ' + err.message);
    }
}