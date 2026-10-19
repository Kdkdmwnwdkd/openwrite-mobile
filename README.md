# OpenWrite Mobile

基于 [OpenWrite](https://github.com/LiPu-jpg/Openwrite)（Apache-2.0）开源项目二次开发的**移动端 AI 小说写作助手**。

纯前端架构：所有逻辑运行在浏览器 / WebView 中，作品数据全部保存在本机 IndexedDB，**不上传任何服务器**；AI 请求由前端直连模型供应商，仅在调用模型时联网。

## 最新版本下载

**一条链接，永远指向最新版，国内约 2 秒下完：**

```
https://gh-proxy.com/https://github.com/Kdkdmwnwdkd/openwrite-mobile/releases/latest/download/app-debug.apk
```

`releases/latest` 由 GitHub 保证指向最新 release，前面拼镜像域名即走加速。发版后**不用改链接**。

| 通道 | 地址 | 国内实测 |
|------|------|----------|
| **镜像 + latest（推荐）** | 见上面代码块 | 1.87 MB/s · 2.2s |
| 备用镜像 | `https://ghfast.top/https://github.com/Kdkdmwnwdkd/openwrite-mobile/releases/latest/download/app-debug.apk` | 968 KB/s · 4.2s |
| CDN（版本化） | `https://testingcf.jsdelivr.net/gh/Kdkdmwnwdkd/openwrite-mobile@dist/apk/app-2.14.0.apk` | 1.05 MB/s |
| 原始（GitHub） | [app-debug.apk](https://github.com/Kdkdmwnwdkd/openwrite-mobile/releases/latest/download/app-debug.apk) | 18 KB/s |

> 这是**自有签名**的测试包（`CN=OpenWrite Mobile`），签名从此固定。
> 证书 SHA-1：`8D:3B:FC:52:A9:99:2A:5C:A2:D4:F5:BF:23:4F:61:82:F0:FF:CF:BC`
>
> **v2.18.0 换了签名，必须先卸载旧版再装**，否则会报「签名不一致 / 应用未安装」。
> 卸载前记得先导出备份（设置 → 数据管理），装好后再导入。从这一版起不用再卸载了。

### 这两条通道怎么来的

GitHub Release 在国内直连只有十几 KB/s，4 MB 的包要等三分钟，手机上基本没法装。做了两件事：

1. **固定指向最新版**：用 `releases/latest/download/` 而不是 `releases/download/<tag>/`，镜像前缀后面接上即可，发版不改地址。
2. **CDN 兜底**：构建完成后自动把 APK 推到 `dist` 分支（单提交、强制覆盖，仓库不会随版本膨胀），jsDelivr 把仓库当 CDN 用，比 GitHub 快一个数量级。

> 注意：CDN 那条要写带版本号的路径（`app-2.14.0.apk`）。实测 jsDelivr 对固定路径 `apk/app-debug.apk` 有源站级缓存，`purge` 也清不掉，发版后仍会返回上一版——宁可链接长一点，也不能让人装到旧包。同一版本号重复构建时它也会滞后，要绝对准确就用上面那条 `latest`。

## 功能特性

**写作主线**

- 书架管理：作品、章节、字数统计；今日进度条（每日目标可改）
- 导入旧稿：txt/md 按「第N章」自动拆章，可新建一本或追加到已有作品
- 专注模式：编辑器一键隐去顶栏、导航和工具栏，只留正文
- 分卷与排序：长篇小说按卷分组，拖动或上下移调整章节顺序；重排会一并重编号（伏笔、节拍、版本历史同步跟着走）
- 听稿校对：系统 TTS 逐句朗读，读一句亮一句；点句子可跳读，可调语速、连播下一章；疑似重复用字用虚线标出
- 多设备同步：WebDAV 整库快照（坚果云 / 群晖 / Nextcloud），换机不丢稿；两端都改过会先问，下载前自动留回滚点
- 聊天联网：输入框上方一键开启。**通义 / 智谱 / DeepSeek-v4-flash 无需任何额外配置**，用现有模型 Key 即可（DeepSeek 只有 v4-flash 带服务端搜索，配 chat / reasoner 时应用会明确提示切换，不会偷偷换模型；DeepSeek 搜索按次计费 5 元/千次，2026-11-01 起收费，首次开启会弹窗说明，按钮上实时显示本次已检索次数）；其他模型可填搜索 API。**支持两级备用搜索**：主搜索超时、报错或没结果时按顺序自动切换（内置 ↔ API 之间也能互相兜底，单次请求 10 秒超时），一家挂了联网照样能用。检索结果作为事实依据注入，并在回复下标注来源
- 章末钩子检查：只看每章最后 280 字，判「能不能让人点下一章」，给分数、类型、问题和具体改法；支持最近 30 章批量扫描并按低分排序（编辑视角评估，非平台追读数据）
- 对话式建书：几轮问答生成书名、设定与大纲
- 章节编辑器：段落级编辑、自动保存、AI 续写 / 扩写
- AI 审稿：打分 + 具体问题定位与修改建议
- AI 读者模拟：以资深读者视角给出评分、情绪曲线、爽点与问题清单（v2.7 新增）
- 多 Agent 协作：规划 / 写作 / 审稿角色协同（v2.7 新增）

**设定与结构**

- 世界观库、角色卡、人物关系
- 大纲编辑器 / 演进系统、情节推演、节拍控制
- 伏笔追踪、一致性检查（支持一键替换全文）
- 备忘录系统

**AI 工具箱**

- 模型配置：DeepSeek / OpenAI / Claude / GLM 等任何 OpenAI 兼容接口
- 参数配置：温度、上下文窗口、系统提示词、自动压缩
- 技能中心 / Skill 广场：内置「去 AI 味润色」等技能，支持导入自定义技能
- 文风蒸馏：从参考文本蒸馏可执行写作约束
- AI 起名：按题材、身份、性别批量生成人名
- 拆书：粘贴/导入原文，AI 拆解题材卖点、开篇钩子、结构节奏、可借鉴技巧，可转成自己的大纲笔记
- 数据管理：全量备份 / 恢复、导入导出
- 导出：Markdown / EPUB / 网络连载 TXT
- **查资料**：写历史、职业、地理时联网检索，结果带来源链接，可勾选存入作品「参考资料」，写作时按关键词自动注入上下文。两种模式：模型内置联网（通义 / 智谱 / DeepSeek-v4-flash，无需另配 Key）、搜索 API（博查 / Serper / Tavily，自带 Key，结果可沉淀）

**写作质量相关（v2.9.0）**

- **AI 主写手**：默认由 AI 流式直接成文，写完一键撤回；版本历史随时可回滚。「草稿模式」降级为可选开关
- **对话式补设定**：聊天可关联作品，AI 自动带上该书角色/设定/进度；对话中补充的世界观、主角性格可一键沉淀为角色卡/世界观设定，写入后 AI 正文自动遵守
- 场景卡片：每章可填「视角人物/目标/冲突/结果」，注入写作上下文（对标 yWriter）
- 读者体检：资深读者视角通读全书，四维打分（钩子/爽点/期待感/文笔）+ 追读债务清单（未兑现爽点、逾期伏笔、人设松动、节奏拖沓），报告留档可对比
- 分层上下文：上一章给全文、更早章节用摘要，角色卡/世界观按关键词命中注入，避免长篇失忆与设定漂移
- 伏笔债务提醒：未回收伏笔按远近排序注入上下文，逾期的优先提示
- 章节摘要：一键生成结构化摘要，供后续章节回顾
- 章节版本历史：每次保存/覆盖自动存档，支持查看与回滚
- 备份提醒：超过 7 天未备份时主动提示

**已知限制（占位实现，点击会提示「开发中」）**：扫榜、联网搜索、文件 attach 等。完整能力见代码内相关标记。

## 快速开始

```bash
# 本地静态托管 frontend/ 即可运行，无需后端
python3 -m http.server 8080 --directory frontend
# 打开 http://localhost:8080
```

首次使用：

1. 「设置 → 模型配置」填入 API Key 与模型名
2. 「设置 → 参数配置」按需调整生成参数
3. 「设置 → 数据管理」先做一次全量备份（换机 / 清缓存前务必再备份）
4. 详细部署方式见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## 打包为移动应用

```bash
npm install
npx cap add android        # 或 ios
npx cap sync
npx cap open android        # Android Studio 构建
```

GitHub Actions 已内置 Android 构建流水线，详见 `.github/workflows/build.yml`。

## 目录结构

```
openwrite-mobile/
├── frontend/          # 纯前端应用（PWA + Capacitor webDir）
│   ├── index.html     # 入口
│   ├── css/style.css
│   ├── js/app.js      # 核心逻辑、路由、页面渲染
│   ├── js/skills.js   # 技能定义
│   ├── js/distill.js  # 文风蒸馏
│   ├── js/export.js   # 导出（markdown / zip 打包）
│   ├── js/research.js # 查资料（联网检索 → 资料库 → 上下文注入）
│   ├── images/        # PWA 图标
│   ├── sw.js          # Service Worker（离线缓存）
│   └── manifest.json
├── docs/DEPLOYMENT.md
├── scripts/           # 构建脚本
├── package.json       # 版本号与 Capacitor 配置
└── LICENSE            # Apache-2.0
```

`backend/` 目录为早期 FastAPI 桥接层的历史遗留，当前版本前端不依赖它，不再维护。

## 与原版 OpenWrite 的关系

本项目是 OpenWrite 的**移动端重写**（v2.x 起为纯前端本地优先形态），沿用其创作方法论与部分提示词设计。上游版权归 [LiPu-jpg/Openwrite](https://github.com/LiPu-jpg/Openwrite) 所有，本项目以 Apache-2.0 许可分发。

## 开发

- 页面路由统一在 `frontend/js/app.js` 的 `navigateTo()` / `renderers` 中注册
- 数据层为 IndexedDB（`db` 对象），备份走 `db.exportAll()`（API Key 自动脱敏）/ `db.importAll()`
- AI 调用统一走 `ai.chat()`，自动应用「参数配置」的温度 / 上下文 / 系统提示词
- 提交前请通过 `node --check frontend/js/*.js` 校验语法

## 开源许可

[Apache-2.0](LICENSE)
