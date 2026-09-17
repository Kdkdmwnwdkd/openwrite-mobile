/**
 * OpenWrite Mobile - Skill System
 * 内置写作技能库 + 技能审查执行引擎
 * 数据存储在 IndexedDB (skills store)
 */

// ===== 内置技能库 =====
const BUILTIN_SKILLS = [
    {
        id: 'de-ai-flavor',
        name: '去AI味小说润色',
        icon: '🧪',
        enabled: true,
        category: '文风矫正',
        version: 'v1.0',
        description: 'AI味症状诊断清单（过度解释/标签化情感/节奏机械/描写同质化/信息倾泻）+定向修正，适用正文润色与文风矫正。',
        content: `# 去AI味 · 小说润色Skill
## 版本：v1.0
## 适用：小说正文润色、AI生成稿后处理、新人作者文风矫正
## 核心目标：消除AI写作的"塑料感"，还原人类作者的情绪波动、叙事节奏与语言个性

---

## 一、AI味典型症状诊断清单

在润色前，先对照以下症状进行诊断，标记出文中存在的AI味类型：

### 1. 【过度解释症】
**症状**：角色每做一个动作、每产生一个情绪，作者都要立刻解释"为什么"和"意味着什么"。
**例**："他握紧了拳头。这说明他很愤怒，因为刚才的话刺痛了他的自尊。"
**修正**：删掉后半句，让读者从动作本身感受情绪。

### 2. 【标签化情感症】
**症状**：使用"感到一阵莫名的……""心中涌起一股……""不知道为什么，他突然……"等模板化情感前缀。
**例**："不知道为什么，她突然感到一阵莫名的悲伤涌上心头。"
**修正**：直接写具体的行为反应或生理感受，不要给情绪贴标签。

### 3. 【节奏机械症】
**症状**：段落长度过于均匀，每段3-4行；对话与叙述严格交替；场景切换总是在"说完话/做完动作"的节点，缺乏意外打断。
**修正**：故意打破节奏。让某段特别长（意识流），某段只有一句话。让对话被突发事件打断。

### 4. 【描写同质化症】
**症状**：所有角色的"紧张"都是"手心出汗+心跳加速"；所有"悲伤"都是"眼眶泛红+低下头"；所有"愤怒"都是"握紧拳头+青筋暴起"。
**修正**：为每个角色建立独特的情绪反应库。A角色紧张时会笑，B角色紧张时会整理头发。

### 5. 【信息倾泻症】
**症状**：在对话或叙述中，为了交代背景，让角色说出明显不符合当下情绪的长篇解释。
**例**：反派临死前突然交代"其实三十年前，我与你父亲......"
**修正**：背景信息碎片化，通过物品、环境、侧面透露，不要让人物变成"信息播报员"。

### 6. 【完美逻辑症】
**症状**：角色的每个决定都基于完全理性的因果链，没有冲动、没有误判、没有"当时就是脑子一热"。
**修正**：加入非理性决策。角色可以因为"就是看他不爽""当时阳光正好，突然不想杀了"而做出关键选择。

### 7. 【感官缺失症】
**症状**：只有视觉描写，缺少触觉、嗅觉、味觉、听觉；环境描写沦为"背景板"，与角色情绪无关。
**修正**：让环境描写成为情绪的放大器。不是"房间很暗"，而是"霉味混着廉价香薰，熏得人太阳穴发胀"。

### 8. 【人称僵硬症】
**症状**：第三人称视角下，叙述者像一个全知全能的摄像头，冷静记录一切，没有立场、没有情绪倾向。
**修正**：让叙述带有"偏见"。描写反派时可以用刻薄词汇，描写喜欢的角色时可以用温柔词汇。

---

## 二、核心修正指令集

### 指令A：【砍解释，留动作】
**操作**：找到文中所有"这说明/这意味着/显然/不难看出"等解释性短语，删除。让动作和细节自己说话。
**示例**：
- 原文："他冷笑了一声。显然，他对这个提议不屑一顾。"
- 修正："他冷笑了一声，把文件推回桌面，指尖在纸面上留下一道油渍。"

### 指令B：【情绪去标签化】
**操作**：搜索"感到/涌起/一阵/莫名/突然/不知为何"等词，替换为具体的生理反应或行为。
**转换表**：
| AI标签化表达 | 人类化表达 |
| --- | --- |
| 感到一阵莫名的悲伤 | 喉咙发紧，吞咽时像吞了碎玻璃 |
| 心中涌起一股怒火 | 后槽牙磨得发酸，耳膜嗡嗡响 |
| 不知道为什么，他突然想哭 | 鼻子一酸，赶紧仰头看天花板 |
| 一种难以言喻的恐惧 | 手指自己开始发抖，止不住 |

### 指令C：【节奏破壁】
**操作**：检查段落长度分布。如果超过60%的段落长度在3-5行之间，执行以下操作：
1. 选一个紧张场景，将某段扩写到8-10行，加入意识流或环境细节。
2. 选一个平淡场景，将某段压缩到1行，制造突兀感。
3. 在对话中插入非语言打断（动作、环境变化、第三人插话）。

### 指令D：【五感替换】
**操作**：每500字检查一次，确保至少出现一次非视觉感官描写。
**优先级**：嗅觉 > 触觉 > 听觉 > 味觉 > 视觉
**技巧**：用嗅觉暗示危险（血腥味、烧焦味），用触觉暗示亲密（衣料摩擦、体温），用听觉暗示紧张（心跳声、远处钟声）。

### 指令D+：【环境即情绪】
**操作**：检查环境描写是否与角色情绪形成"共振"或"反差"。
- 共振：角色绝望时，环境也在腐烂（"雨下得像在哭"）。
- 反差：角色极度悲伤时，环境却异常美好（"阳光很好，好得让人想死"）。

### 指令E：【逻辑崩坏】
**操作**：在关键决策点，故意让角色做出一个"不完全合理"的选择，并给出非理性动机。
- 理性版："他分析了利弊，决定暂时撤退，保存实力。"
- 人类版："他本来该走的。但对方那个轻蔑的眼神，和初中时霸凌他的人一模一样。于是他冲了上去。"

### 指令F：【叙述偏见】
**操作**：给叙述者一个"态度"。描写不同角色时，词汇选择带有明显倾向性。
**示例**：
- 对讨厌的角色："那张脸挤出一个笑，像面团上划了一刀。"
- 对喜欢的角色："她笑的时候，眼睛会先弯起来，像月牙提前亮了。"

---

## 三、分场景修正策略

### 场景1：对话
**AI味特征**：对话像"信息交换"，每句都在推进剧情，没有废话、没有跑题、没有情绪宣泄。
**修正策略**：
- 加入"无效对话"：角色在紧张时聊无关话题（"你吃了吗？""关你屁事"）。
- 加入"答非所问"：A问问题，B回答另一个问题，或根本不回答。
- 加入"话语碎片"：句子不完整，被情绪打断（"我不是那个意思，我是说--算了。"）。

### 场景2：动作描写
**AI味特征**：动作像说明书，每一步都清晰、合理、高效。
**修正策略**：
- 加入"多余动作"：角色在紧张时会无意识做某事（转笔、抠桌角）。
- 加入"动作变形"：同样的动作，在不同情绪下变形（"他点烟"→愤怒时"把打火机摔了三次才点着"→悲伤时"火光照亮他手背的疤，他盯着看了很久，忘了点烟"）。

### 场景3：心理描写
**AI味特征**：心理活动像"内心独白演讲"，逻辑清晰，排比工整。
**修正策略**：
- 改为"意识碎片"：不连贯的图像、记忆闪回、身体感受。
- 改为"外化"：把心理活动变成动作（"他想杀人"→"他把指甲掐进掌心，直到闻到血腥味"）。

### 场景4：恐怖/紧张场景
**AI味特征**：恐怖感来自"描述恐怖事物"，而非"让读者自己感到恐怖"。
**修正策略**：
- **延迟揭示**：先写异常的氛围（声音不对、气味不对），再写具体恐怖事物。
- **日常恐怖**：恐怖事物藏在日常细节中（"冰箱里的牛奶过期了，但昨天明明刚买的"）。
- **视角受限**：不要全知，让角色（和读者）只能看到局部，靠想象补全恐怖。

### 场景5：沙雕/搞笑场景
**AI味特征**：笑点像"段子集锦"，每个梗之间没有情绪连贯性，人物为搞笑而搞笑。
**修正策略**：
- **尴尬感**：真正的沙雕来自"当事人很认真，但旁观者觉得很蠢"的落差。
- **连锁反应**：一个意外引发一系列失控，而非独立段子拼接。
- **角色认真**：角色不要"知道自己很搞笑"，他们要严肃地对待荒谬的局面。

---

## 四、快速自检表

润色完成后，逐条检查：

- [ ] 文中是否有至少一处"没有解释原因"的情绪或动作？
- [ ] 是否有至少一段特别长或特别短，打破均匀节奏？
- [ ] 是否有至少一处非视觉感官描写（嗅觉/触觉/听觉）？
- [ ] 对话中是否有"废话""答非所问"或"被打断"？
- [ ] 角色是否做过至少一个"不完全理性"的决定？
- [ ] 叙述者对不同角色的描写是否有词汇倾向性？
- [ ] 环境描写是否与角色情绪形成共振或反差？
- [ ] 是否有至少一个"多余动作"或"动作变形"？

**通过6项以上 = AI味基本清除**
**通过4-5项 = 仍有轻微AI味，需针对性强化**
**通过3项以下 = 建议重写**

---

## 五、示范案例

### 原文（典型AI味）：

林九推开门，走进了房间。他感到一阵莫名的紧张，因为这里的气氛很诡异。房间里的灯光很暗，家具上布满了灰尘，显然已经很久没有人住过了。他深吸一口气，努力让自己冷静下来，然后继续向前走去。他知道，自己必须找到那个东西，这是他复仇的唯一希望。

### 润色后：

林九推开门，潮气扑面而来。霉味混着铁锈味，熏得太阳穴发胀。他站在门口没动，直到眼睛适应黑暗——沙发轮廓像伏着的兽。指尖擦过茶几，厚厚一层灰。脚步声在空旷里显得格外大。他摸到那把刀，刀柄上的旧刻痕还在。很好。他攥紧了它，往更深处走去。`
    }
];

// ===== Skill 管理器 =====
const skillManager = {
    async getAll() {
        let saved = [];
        try { saved = await db.getAll('skills'); } catch (e) { saved = []; }
        // 合并内置技能与用户保存的状态
        const result = BUILTIN_SKILLS.map(builtin => {
            const record = saved.find(s => s.id === builtin.id);
            return record ? { ...builtin, enabled: record.enabled } : { ...builtin };
        });
        // 包含用户自定义技能（从广场下载的）
        const customSkills = saved.filter(s => !BUILTIN_SKILLS.some(b => b.id === s.id));
        return [...result, ...customSkills.map(s => ({ ...s, enabled: s.enabled !== false }))];
    },

    async get(id) {
        try {
            const record = await db.get('skills', id);
            const builtin = BUILTIN_SKILLS.find(s => s.id === id);
            return record ? { ...builtin, enabled: record.enabled } : { ...builtin };
        } catch (e) {
            return BUILTIN_SKILLS.find(s => s.id === id) || null;
        }
    },

    async setEnabled(id, enabled) {
        await db.put('skills', { id, enabled, updated: Date.now() });
    },

    async saveReview(review) {
        await db.put('reviews', review);
    },

    async listReviews() {
        try { return await db.getAll('reviews'); } catch (e) { return []; }
    },

    async getReview(id) {
        try { return await db.get('reviews', id); } catch (e) { return null; }
    },

    async listActive() {
        const all = await this.getAll();
        return all.filter(s => s.enabled !== false);
    },

    async put(skill) {
        await db.put('skills', { ...skill, updated: Date.now() });
    }
};

// ===== 去AI味审查执行引擎 =====
const deAiEngine = {
    /**
     * 构建审查 System Prompt（嵌入完整 Skill 规则）
     */
    buildReviewSystemPrompt(skill) {
        return `你是资深中文小说编辑，精通"去AI味"写作技艺。你将使用以下完整技能规则，对用户提供的小说文本进行逐段审查。

===== 技能定义 =====
《${skill.name}》${skill.version}
${skill.content}
===== 技能结束 =====

【你的任务】
1. 通读全文，按照技能中的"AI味典型症状诊断清单"（8种症状）逐段诊断；
2. 找出文中所有存在AI味的段落/句子；
3. 对每一处问题，输出：问题原文摘录、属于哪种症状、为什么是AI味、具体如何修正（可给出改写示范）；
4. 最后对照"快速自检表"给全文打分评级。

【严格输出要求】
只输出 JSON 对象，不要输出任何其他文字、Markdown 代码块标记或注释，格式如下：
{
  "score": 0-100 的整数（AI味浓度，越高AI味越重）,
  "verdict": "评级：AI味基本清除 / 仍有轻微AI味 / 有明显AI味 / AI味很重，建议重写",
  "issues": [
    {
      "quote": "原文中问题句子的精确摘录（尽量逐字）",
      "symptom": "症状名称（如：标签化情感症）",
      "explain": "为什么这是AI味，简短说明",
      "fix": "具体修正建议",
      "rewrite": "改写示范（可选，一段直接可用的替换文字）"
    }
  ],
  "checklist": [{"item": "自检表条目", "pass": true或false}],
  "summary": "一段话总结全文AI味情况与修改优先级"
}`;
    },

    /**
     * 构建润色 System Prompt（直接改写全文）
     */
    buildPolishSystemPrompt(skill) {
        return `你是资深中文小说编辑，精通"去AI味"写作技艺。你将使用以下完整技能规则，对用户提供的小说文本进行全文润色改写。

===== 技能定义 =====
《${skill.name}》${skill.version}
${skill.content}
===== 技能结束 =====

【你的任务】
1. 严格对照技能中的8种症状诊断清单与指令A~F，把全文润色成"人类作者手笔"；
2. 保留原作的剧情、人物、情节走向，只改表达方式；
3. 重点消除：过度解释、标签化情感、节奏机械、描写同质化、信息倾泻、完美逻辑、感官缺失、人称僵硬；
4. 保持连贯的叙事与原有的分段结构。

【严格输出要求】
只输出润色后的完整正文（小说文本本身），不要输出任何解释、前言、点评、Markdown代码块标记或"以下为润色结果"之类的说明文字。`;
    },

    /** 从 AI 返回文本中容错提取 JSON */
    extractJSON(text) {
        if (!text) return null;
        // 去掉 markdown 代码块包裹
        let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        // 找第一个 { 和最后一个 }
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return null;
        cleaned = cleaned.slice(start, end + 1);
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            // 尝试修复常见问题：多余的尾逗号
            try {
                cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
                return JSON.parse(cleaned);
            } catch (e2) {
                return null;
            }
        }
    },

    /**
     * 执行审查
     * @param {string} skillId 技能ID
     * @param {string} text 待审查文本
     * @param {function} onProgress 进度回调 (msg)
     * @returns {Object} 审查结果
     */
    async review(skillId, text, onProgress) {
        const skill = await skillManager.get(skillId);
        if (!skill) throw new Error('技能不存在');

        // 长文本分段：一次最多 ~6000 字交给审查，超出截取首尾重点
        const MAX_LEN = 6000;
        let sample = text;
        if (text.length > MAX_LEN) {
            sample = text.slice(0, MAX_LEN) + '\n\n……（以下省略 ' + (text.length - MAX_LEN) + ' 字）';
        }

        if (onProgress) onProgress('正在通读全文并对照症状清单诊断...');
        const raw = await ai.chat([
            { role: 'system', content: this.buildReviewSystemPrompt(skill) },
            { role: 'user', content: '请审查以下小说文本：\n\n' + sample }
        ], null, 8000);

        let result = this.extractJSON(raw);
        if (!result) {
            // JSON 解析失败，退化为纯文本结果
            result = { score: null, verdict: '审查完成', issues: [], summary: raw, rawText: raw };
        }
        result.skillId = skillId;
        result.skillName = skill.name;
        result.raw = raw;
        result.created = Date.now();
        result.id = 'review_' + Date.now();
        result.textSample = sample;

        // 保存到历史
        try { await skillManager.saveReview(result); } catch (e) { /* ignore */ }
        return result;
    },

    /**
     * 执行润色（全文改写）
     */
    async polish(skillId, text, onProgress) {
        const skill = await skillManager.get(skillId);
        if (!skill) throw new Error('技能不存在');

        // 长文本分段润色，每段 4000 字，逐段输出
        const MAX_CHUNK = 4000;
        const chunks = [];
        for (let i = 0; i < text.length; i += MAX_CHUNK) {
            chunks.push(text.slice(i, i + MAX_CHUNK));
        }

        let result = '';
        let chunkIndex = 0;
        for (const chunk of chunks) {
            chunkIndex++;
            if (onProgress) onProgress(`正在润色第 ${chunkIndex}/${chunks.length} 段...`);
            const part = await ai.chat([
                { role: 'system', content: this.buildPolishSystemPrompt(skill) },
                { role: 'user', content: '请润色以下小说文本片段（这是全文第 ' + chunkIndex + '/' + chunks.length + ' 段）：\n\n' + chunk }
            ], null, 8000);
            result += (chunkIndex > 1 ? '\n\n' : '') + part;
        }

        return { id: 'polish_' + Date.now(), skillId, skillName: skill.name, input: text, output: result, created: Date.now() };
    },

    /** 高亮渲染：把问题摘录在原文中标出 */
    highlightIssues(originalText, issues) {
        if (!issues || !issues.length) return { html: escapeHtml(originalText), count: 0 };
        let html = escapeHtml(originalText);
        let count = 0;
        for (const issue of issues) {
            if (!issue.quote) continue;
            const q = escapeHtml(issue.quote.trim()).slice(0, 150);
            if (!q || q.length < 4) continue;
            // 在转义后的文本中查找并包裹高亮
            const idx = html.indexOf(q);
            if (idx !== -1) {
                html = html.slice(0, idx) +
                    `<mark class="ai-mark" title="${escapeHtml(issue.symptom || 'AI味问题')}">` +
                    html.slice(idx, idx + q.length) +
                    `</mark>` +
                    html.slice(idx + q.length);
                count++;
            }
        }
        return { html, count };
    }
};

// ===== Skill 页面渲染 =====

// 技能中心（列表）
async function renderSkillCenter(container) {
    ui.setPageTitle('技能中心');
    ui.setHeaderActions('<button class="header-btn" onclick="navigateTo(\'chat\')">返回</button>');

    const skills = await skillManager.getAll();

    container.innerHTML = `
        <div class="skill-hero">
            <div class="skill-hero-icon">🧪</div>
            <div class="skill-hero-text">
                <div class="skill-hero-title">写作技能库</div>
                <div class="skill-hero-desc">内置精选技能，一键审查与润色你的小说</div>
            </div>
        </div>

        <div class="skill-list">
            ${skills.map(s => `
                <div class="skill-card ${s.enabled ? '' : 'disabled'}" onclick="navigateTo('skillDetail', { skillId: '${s.id}' })">
                    <div class="skill-card-icon">${s.icon}</div>
                    <div class="skill-card-body">
                        <div class="skill-card-name">${s.name}</div>
                        <div class="skill-card-desc">${s.description}</div>
                        <div class="skill-card-meta">${s.category} · ${s.version}</div>
                    </div>
                    <div class="skill-card-side" onclick="event.stopPropagation()">
                        <label class="switch">
                            <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSkill('${s.id}', this.checked)">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
            `).join('')}
        </div>

        <div class="card" style="margin-top: 16px;" onclick="navigateTo('skillHistory')">
            <div style="display:flex;align-items:center;gap:12px;">
                <div style="font-size:22px;">📜</div>
                <div style="flex:1;">
                    <div style="font-weight:600;">审查历史</div>
                    <div style="font-size:13px;color:var(--text-secondary);">查看之前的审查报告</div>
                </div>
                <span style="color:var(--text-secondary);font-size:20px;">›</span>
            </div>
        </div>
    `;
}

async function toggleSkill(skillId, enabled) {
    try {
        await skillManager.setEnabled(skillId, enabled);
        ui.showToast(enabled ? '技能已启用' : '技能已停用');
    } catch (err) {
        ui.showToast('操作失败: ' + err.message);
    }
}

// 技能详情
async function renderSkillDetail(container, skillId) {
    const skill = await skillManager.get(skillId);
    if (!skill) { ui.showToast('技能不存在'); navigateTo('skillCenter'); return; }

    ui.setPageTitle(skill.name);
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('skillCenter')">返回</button>
    `);

    container.innerHTML = `
        <div class="skill-detail-header">
            <div class="skill-detail-icon">${skill.icon}</div>
            <div class="skill-detail-info">
                <div class="skill-detail-name">${skill.name}</div>
                <div class="skill-detail-meta">${skill.category} · ${skill.version}${skill.enabled ? ' · 已启用' : ' · 已停用'}</div>
            </div>
        </div>

        <div class="action-buttons-row">
            <button class="btn btn-primary" onclick="navigateTo('skillUse', { skillId: '${skill.id}', mode: 'review' })">🔍 审查文本</button>
            <button class="btn btn-secondary" onclick="navigateTo('skillUse', { skillId: '${skill.id}', mode: 'polish' })">✨ 全文润色</button>
        </div>

        <div class="card">
            <div class="card-title">技能说明</div>
            <div class="skill-description">${skill.description}</div>
        </div>

        <div class="card">
            <div class="card-title">技能内容</div>
            <div class="skill-content" id="skill-content-body"></div>
        </div>
    `;

    // 渲染 markdown（简易渲染）
    renderSimpleMarkdown(document.getElementById('skill-content-body'), skill.content);
}

// 技能使用页（审查 / 润色）
async function renderSkillUse(container, skillId, mode) {
    const skill = await skillManager.get(skillId);
    if (!skill) { ui.showToast('技能不存在'); navigateTo('skillCenter'); return; }

    const isReview = mode !== 'polish';
    ui.setPageTitle(isReview ? '审查文本' : '全文润色');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('skillDetail', { skillId: '${skill.id}' })">返回</button>
    `);

    container.innerHTML = `
        <div class="card" style="margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
                <span>${skill.icon}</span>
                <span style="font-weight:600;">${skill.name}</span>
                <span class="mode-badge">${isReview ? '智能审查' : '全文润色'}</span>
            </div>
            <textarea class="textarea skill-input" id="skill-input" placeholder="${isReview ? '粘贴要审查的小说文本（建议不超过 6000 字，超出部分自动截取重点）...' : '粘贴要润色的小说文本（支持长篇，自动分段处理）...'}" style="min-height: 220px;"></textarea>
            ${!isReview ? '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">📌 润色会保留情节与人设，仅改写表达方式；长文自动分段逐段处理。</div>' : ''}
            <button class="btn btn-primary btn-block" style="margin-top:12px;" onclick="${isReview ? `runReview('${skill.id}')` : `runPolish('${skill.id}')`}">
                ${isReview ? '🔍 开始审查' : '✨ 开始润色'}
            </button>
        </div>

        <div id="skill-result-area">
            <div class="card">
                <div class="card-title">${isReview ? '如何看审查结果' : '如何看润色结果'}</div>
                <div style="font-size:13px;color:var(--text-secondary);line-height:1.8;">
                    ${isReview ? '审查完成后会给出 AI 味浓度评分、逐条问题清单（含症状归类与改写示范）以及原文高亮标记，对照"快速自检表"一目了然。' : '润色完成后会直接输出改写后的全文，你可以复制回编辑器使用。'}
                </div>
            </div>
        </div>
    `;
}

// 执行审查
async function runReview(skillId) {
    const text = document.getElementById('skill-input').value.trim();
    if (!text) { ui.showToast('请先粘贴要审查的文本'); return; }
    if (text.length < 50) { ui.showToast('文本太短，至少需要 50 字'); return; }

    const resultArea = document.getElementById('skill-result-area');
    resultArea.innerHTML = `
        <div class="card">
            <div class="ai-working">
                <div class="ai-working-dots"><span></span><span></span><span></span></div>
                <span id="skill-progress">准备审查...</span>
            </div>
        </div>`;

    try {
        const result = await deAiEngine.review(skillId, text, (msg) => {
            const el = document.getElementById('skill-progress');
            if (el) el.textContent = msg;
        });

        resultArea.innerHTML = renderReviewResult(result, text);
    } catch (err) {
        resultArea.innerHTML = `
            <div class="card">
                <div class="error-box">⚠️ 审查失败：${escapeHtml(err.message)}<br><br>请检查「设置 → 模型配置」中的 API Key 是否正确。</div>
            </div>`;
    }
}

function renderReviewResult(result, originalText) {
    const issues = Array.isArray(result.issues) ? result.issues : [];
    const highlight = deAiEngine.highlightIssues(originalText, issues);

    // 评分条
    let scoreBar = '';
    if (result.score !== null && result.score !== undefined) {
        const pct = Math.max(0, Math.min(100, result.score));
        const color = pct < 30 ? 'var(--success)' : pct < 60 ? 'var(--warning)' : 'var(--danger)';
        scoreBar = `
            <div class="score-block">
                <div class="score-row">
                    <span class="score-label">AI味浓度</span>
                    <span class="score-value" style="color:${color};">${pct}%</span>
                </div>
                <div class="score-bar"><div class="score-bar-fill" style="width:${pct}%;background:${color};"></div></div>
                <div class="score-verdict">${escapeHtml(result.verdict || '')}</div>
            </div>`;
    }

    // 问题清单
    const issuesHtml = issues.length ? issues.map((iss, i) => `
        <div class="issue-item">
            <div class="issue-head">
                <span class="issue-index">${i + 1}</span>
                <span class="issue-symptom">${escapeHtml(iss.symptom || 'AI味问题')}</span>
            </div>
            ${iss.quote ? `<div class="issue-quote">"${escapeHtml(iss.quote)}"</div>` : ''}
            ${iss.explain ? `<div class="issue-explain">${escapeHtml(iss.explain)}</div>` : ''}
            ${iss.fix ? `<div class="issue-fix"><span class="tag-fix">修正</span> ${escapeHtml(iss.fix)}</div>` : ''}
            ${iss.rewrite ? `<div class="issue-rewrite"><span class="tag-rewrite">示范</span> ${escapeHtml(iss.rewrite)}</div>` : ''}
        </div>
    `).join('') : `<div class="no-issue">✅ 未发现明显 AI 味问题，或问题较轻微。</div>`;

    // 自检表
    const checklist = Array.isArray(result.checklist) ? result.checklist : [];
    const checklistHtml = checklist.length ? `
        <div class="card">
            <div class="card-title">📋 快速自检表</div>
            <div class="checklist">
                ${checklist.map(c => `
                    <div class="check-item ${c.pass ? 'pass' : 'fail'}">
                        <span class="check-icon">${c.pass ? '✅' : '❌'}</span>
                        <span>${escapeHtml(c.item || '')}</span>
                    </div>`).join('')}
            </div>
        </div>` : '';

    return `
        <div class="card">
            <div class="card-title">审查报告</div>
            ${scoreBar}
            <div class="summary-text">${escapeHtml(result.summary || '')}</div>
            <div style="margin-top:10px;font-size:12px;color:var(--text-secondary);">报告已保存，可在「审查历史」中重新查看。</div>
        </div>

        <div class="card">
            <div class="card-title">🔍 逐条问题清单（${issues.length} 处）</div>
            <div class="issue-list">${issuesHtml}</div>
        </div>

        <div class="card">
            <div class="card-title">📄 原文标记（命中 ${highlight.count} 处）</div>
            <div class="highlight-box">${highlight.html}</div>
            <div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">黄色高亮 = 疑似 AI 味片段</div>
        </div>

        ${checklistHtml}

        <div class="action-buttons-row">
            <button class="btn btn-secondary" onclick="window.scrollTo(0,0)">⬆️ 返回顶部</button>
            <button class="btn btn-primary" onclick="reuseReviewText()">✍️ 继续调整</button>
        </div>
    `;
}

function reuseReviewText() {
    const el = document.getElementById('skill-input');
    if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
        el.focus();
    }
}

// 执行润色
async function runPolish(skillId) {
    const text = document.getElementById('skill-input').value.trim();
    if (!text) { ui.showToast('请先粘贴要润色的文本'); return; }
    if (text.length < 50) { ui.showToast('文本太短，至少需要 50 字'); return; }

    const resultArea = document.getElementById('skill-result-area');
    resultArea.innerHTML = `
        <div class="card">
            <div class="ai-working">
                <div class="ai-working-dots"><span></span><span></span><span></span></div>
                <span id="skill-progress">准备润色...</span>
            </div>
        </div>`;

    try {
        const result = await deAiEngine.polish(skillId, text, (msg) => {
            const el = document.getElementById('skill-progress');
            if (el) el.textContent = msg;
        });

        resultArea.innerHTML = `
            <div class="card">
                <div class="card-title">✨ 润色完成</div>
                <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">已按《${escapeHtml(result.skillName)}》规则改写全文，保留情节与人设。</div>
                <div class="polish-output" id="polish-output">${escapeHtml(result.output)}</div>
                <div class="action-buttons-row" style="margin-top:12px;">
                    <button class="btn btn-secondary" onclick="copyPolishResult()">📋 复制结果</button>
                    <button class="btn btn-primary" onclick="savePolishToNovel('${result.id}')">📚 存入作品</button>
                </div>
            </div>`;

        // 存最近一次润色结果
        store.lastPolish = result;
    } catch (err) {
        resultArea.innerHTML = `
            <div class="card">
                <div class="error-box">⚠️ 润色失败：${escapeHtml(err.message)}<br><br>请检查「设置 → 模型配置」中的 API Key 是否正确。</div>
            </div>`;
    }
}

function copyPolishResult() {
    if (!store.lastPolish) return;
    const text = store.lastPolish.output;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => ui.showToast('已复制到剪贴板'), () => { fallbackCopy(text); });
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); ui.showToast('已复制到剪贴板'); } catch (e) { ui.showToast('复制失败，请手动长按复制'); }
    document.body.removeChild(ta);
}

async function savePolishToNovel(id) {
    if (!store.lastPolish) { ui.showToast('没有可保存的内容'); return; }
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
            <input type="text" class="input" id="save-polish-title" placeholder="如：第一章（润色版）"></div>
            <button class="btn btn-primary btn-block" onclick="confirmSavePolish('${id}')">保存</button>
        </div>`);
    modal.show();
}

async function confirmSavePolish(id) {
    if (!store.lastPolish) return;
    const novelId = document.getElementById('save-novel-select').value;
    const title = document.getElementById('save-polish-title').value.trim() || '润色稿';
    if (!novelId) { ui.showToast('请选择作品'); return; }

    try {
        const chapters = await novelManager.listChapters(novelId);
        const nextNum = chapters.length > 0 ? Math.max(...chapters.map(c => c.number)) + 1 : 1;
        await novelManager.saveChapter(novelId, nextNum, title, store.lastPolish.output);
        ui.showToast(`已保存到《${title}》（第${nextNum}章）`);
        closeModal();
    } catch (err) {
        ui.showToast('保存失败: ' + err.message);
    }
}

// 审查历史
async function renderSkillHistory(container) {
    ui.setPageTitle('审查历史');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('skillCenter')">返回</button>`);

    const reviews = await skillManager.listReviews();
    // 只显示审查类记录
    const reviewList = reviews.filter(r => r.id && r.id.startsWith('review_')).sort((a, b) => (b.created || 0) - (a.created || 0));

    if (!reviewList.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📜</div>
                <div class="empty-title">暂无审查记录</div>
                <div class="empty-desc">使用技能审查文本后，报告会保存在这里</div>
                <button class="btn btn-primary" onclick="navigateTo('skillCenter')">去试试</button>
            </div>`;
        return;
    }

    container.innerHTML = `
        <div class="history-list">
            ${reviewList.map(r => `
                <div class="history-item" onclick="showHistoryDetail('${r.id}')">
                    <div class="history-icon">🧪</div>
                    <div class="history-body">
                        <div class="history-title">${escapeHtml(r.skillName || '去AI味')} · ${r.score !== null && r.score !== undefined ? r.score + '%' : '查看'}</div>
                        <div class="history-meta">${formatDate(r.created)} · ${(r.textSample || '').length}字片段</div>
                    </div>
                    <span style="color:var(--text-secondary);">›</span>
                </div>
            `).join('')}
        </div>`;
}

async function showHistoryDetail(id) {
    const review = await skillManager.getReview(id);
    if (!review) { ui.showToast('记录不存在'); return; }
    const modal = createModal('审查报告详情', `
        <div style="max-height:65vh;overflow-y:auto;">
            ${renderReviewResult(review, review.textSample || '')}
        </div>`);
    modal.show();
}

// ===== 简易 Markdown 渲染 =====
function renderSimpleMarkdown(container, markdown) {
    let html = '';
    const lines = markdown.split('\n');
    let inList = false;
    let inCode = false;
    let codeBuf = [];

    for (let line of lines) {
        // 代码块
        if (line.trim().startsWith('```')) {
            if (!inCode) {
                inCode = true; codeBuf = [];
                if (inList) { html += '</ul>'; inList = false; }
                continue;
            } else {
                inCode = false;
                html += '<pre class="md-code">' + escapeHtml(codeBuf.join('\n')) + '</pre>';
                continue;
            }
        }
        if (inCode) { codeBuf.push(line); continue; }

        // 标题
        const hMatch = line.match(/^(#{1,4})\s+(.*)/);
        if (hMatch) {
            if (inList) { html += '</ul>'; inList = false; }
            const level = hMatch[1].length;
            const cls = level <= 2 ? 'md-h2' : 'md-h3';
            html += `<div class="${cls}">${escapeHtml(hMatch[2])}</div>`;
            continue;
        }
        // 分隔线
        if (/^---+\s*$/.test(line.trim())) {
            if (inList) { html += '</ul>'; inList = false; }
            html += '<hr class="md-hr">';
            continue;
        }
        // 列表
        const listMatch = line.match(/^[-*]\s+(.*)/);
        if (listMatch) {
            if (!inList) { html += '<ul class="md-list">'; inList = true; }
            html += `<li>${renderInline(listMatch[1])}</li>`;
            continue;
        }
        // 数字列表
        const numMatch = line.match(/^\d+[.、]\s+(.*)/);
        if (numMatch) {
            if (!inList) { html += '<ol class="md-list">'; inList = true; }
            html += `<li>${renderInline(numMatch[1])}</li>`;
            continue;
        }
        // 表格
        const tableMatch = line.match(/^\|.+\|$/);
        if (tableMatch) {
            if (inList) { html += '</ul>'; inList = false; }
            const cells = line.split('|').filter(c => c.trim() !== '');
            html += `<div class="md-table-row">${cells.map(c => `<span class="md-table-cell">${renderInline(c)}</span>`).join('')}</div>`;
            continue;
        }
        // 空行
        if (!line.trim()) {
            if (inList) { html += '</ul>'; inList = false; }
            continue;
        }
        // 普通段落
        if (inList) { html += '</ul>'; inList = false; }
        html += `<p class="md-p">${renderInline(line)}</p>`;
    }
    if (inCode) html += '<pre class="md-code">' + escapeHtml(codeBuf.join('\n')) + '</pre>';
    if (inList) html += '</ul>';

    container.innerHTML = html;
}

function renderInline(text) {
    let t = escapeHtml(text);
    // 加粗 **text**
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 行内代码 `code`
    t = t.replace(/`(.+?)`/g, '<code>$1</code>');
    return t;
}