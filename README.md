# OpenWrite Mobile

基于 [OpenWrite](https://github.com/LiPu-jpg/Openwrite) 开源项目构建的移动端 AI 小说写作助手。

## 功能特性

- 📚 **书架管理**：查看和管理你的所有作品
- ✍️ **智能写作**：AI 辅助生成章节内容
- 🔍 **AI 审稿**：自动检查章节质量
- ⚙️ **模型配置**：支持 DeepSeek、OpenAI、Claude 等多种模型
- 💾 **本地优先**：所有数据保存在本地，隐私安全
- 📱 **PWA 支持**：可安装到手机桌面，离线可用

## 技术架构

```
OpenWrite-Mobile/
├── backend/          # FastAPI 后端桥接层
│   ├── main.py      # API 路由和逻辑
│   └── requirements.txt
├── frontend/         # PWA 前端
│   ├── index.html    # 主页面
│   ├── css/
│   │   └── style.css # 移动端适配样式
│   ├── js/
│   │   └── app.js    # 核心应用逻辑
│   ├── sw.js         # Service Worker (离线支持)
│   └── manifest.json # PWA 配置
├── scripts/          # 构建和部署脚本
└── docs/             # 文档
```

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/Kdkdmwnwdkd/openwrite-mobile.git
cd openwrite-mobile
```

### 2. 安装依赖

```bash
# 安装 Node.js 依赖
npm install

# 安装 Python 依赖
cd backend
pip install -r requirements.txt
```

### 3. 配置 OpenWrite 核心

确保 OpenWrite 核心已安装：

```bash
# 在 OpenWrite 核心目录
cd ../Openwrite  # 或你的 OpenWrite 安装路径
pip install -e .
```

### 4. 启动后端服务

```bash
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 4567
```

### 5. 访问应用

打开浏览器访问 `http://localhost:4567` 或前端开发服务器地址。

## 打包为 Android APK

### 前提条件

- Node.js >= 22.0.0
- Android Studio
- Android SDK

### 打包步骤

```bash
# 1. 安装 Capacitor 平台
npm run add:android

# 2. 同步前端资源到原生项目
npm run build:capacitor

# 3. 构建 APK
npm run build:android

# 4. 或用 Android Studio 打开调试
npm run open:android
```

## 打包为 iOS App

```bash
# 1. 安装 Capacitor iOS 平台
npm run add:ios

# 2. 同步资源
npm run build:capacitor

# 3. 用 Xcode 打开
npm run open:ios
```

## 配置 AI 模型

在应用设置中配置你的 API Key：

1. 打开应用 → 设置 → 模型配置
2. 输入你的 API Key
3. 选择模型（DeepSeek Chat / GPT-4 / Claude 等）
4. 可选：自定义 Base URL

支持的模型提供商：
- DeepSeek
- OpenAI
- Anthropic (Claude)
- 智谱 AI (GLM)
- 任何兼容 OpenAI API 格式的服务

## 开发指南

### 目录结构说明

- `backend/main.py`: FastAPI 后端，封装 OpenWrite CLI 命令
- `frontend/js/app.js`: 前端核心逻辑，页面路由和数据管理
- `frontend/css/style.css`: 移动端适配的 CSS 样式

### 添加新页面

1. 在 `frontend/js/app.js` 的 `renderers` 对象中添加渲染函数
2. 在 `navigateTo` 函数中添加路由映射
3. 在 HTML/CSS 中添加对应样式

### 扩展 API

1. 在 `backend/main.py` 中添加新的 FastAPI 路由
2. 使用 `run_openwrite()` 函数调用 OpenWrite CLI
3. 在前端 `api` 对象中添加对应方法

## 与原版 OpenWrite 的关系

本项目是 OpenWrite 的**移动端封装**，而非替代品：

- 后端复用 OpenWrite 核心逻辑（大纲、写作、审稿、伏笔管理等）
- 前端提供移动端友好的界面
- 数据格式与 OpenWrite 兼容（Markdown 文件）
- 可以与本地的 OpenWrite CLI 共同使用

## 许可证

Apache-2.0 License

基于 [OpenWrite](https://github.com/LiPu-jpg/Openwrite) 开源项目构建。

## 社区

- OpenWrite AI 写作交流群：1106407987
- GitHub Issues: https://github.com/Kdkdmwnwdkd/openwrite-mobile/issues

## 版本历史

### v2.0.1 (当前)
- 初始移动端版本
- 支持书架、写作、设置三大模块
- 集成 AI 写作和审稿功能
- PWA 离线支持

---

**注意**：本项目仍在开发中，部分功能尚未完全实现。欢迎提交 Issue 和 PR。
