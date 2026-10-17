# OpenWrite Mobile

基于 [OpenWrite](https://github.com/LiPu-jpg/Openwrite)（Apache-2.0）开源项目二次开发的**移动端 AI 小说写作助手**。

纯前端架构：所有逻辑运行在浏览器 / WebView 中，作品数据全部保存在本机 IndexedDB，**不上传任何服务器**；AI 请求由前端直连模型供应商，仅在调用模型时联网。

## 最新版本下载

每次 push 到 `master`，GitHub Actions 会自动构建并更新以下 Release：

| 版本 | 更新日期 | 大小 | 下载链接 |
|------|----------|------|----------|
| **nightly-debug** | 2026-09-18 | 3.69 MB | [app-debug.apk](https://github.com/Kdkdmwnwdkd/openwrite-mobile/releases/download/nightly-debug/app-debug.apk) |

> 这是 debug 签名包（仅供测试，不适合正式分发）。当前版本号见 `package.json` / 应用「设置 → 关于」。

## 功能特性

**写作主线**

- 书架管理：作品、章节、字数统计
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
- 数据管理：全量备份 / 恢复、导入导出
- 导出：Markdown / TXT 等格式（EPUB 规划中）

**已知限制（占位实现，点击会提示「开发中」）**：拆解、扫榜、联网搜索等。完整能力见代码内相关标记。

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
