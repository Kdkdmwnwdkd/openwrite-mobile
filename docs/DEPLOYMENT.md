# OpenWrite Mobile Deployment Guide

## 部署方式

### 方式一：本地开发服务器（推荐开发使用）

```bash
# 1. 安装依赖
npm install
cd backend && pip install -r requirements.txt && cd ..

# 2. 启动后端
python backend/main.py

# 3. 访问 http://localhost:4567
```

### 方式二：PWA 安装到手机

1. 用 Chrome/Edge 访问后端地址
2. 点击地址栏"添加到主屏幕"
3. 像原生 App 一样使用

### 方式三：打包 APK（完整原生体验）

#### 在 GitHub Actions 自动构建

项目已配置 GitHub Actions 工作流，每次 push 到 main 分支会自动构建 APK：

1. 推送代码到 GitHub
2. 进入 Actions 页面
3. 下载构建产物

#### 本地构建

```bash
# 需要 Node.js >= 22.0.0 和 Android SDK
./scripts/build-android.sh
```

### 方式四：Docker 部署

```dockerfile
# Dockerfile
FROM node:22-alpine

WORKDIR /app
COPY . .

RUN npm install
RUN cd backend && pip install -r requirements.txt

EXPOSE 4567

CMD ["python", "backend/main.py"]
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENWRITE_ROOT` | OpenWrite 核心代码路径 | `../Openwrite` |
| `LLM_API_KEY` | AI 模型 API Key | 无 |
| `LLM_BASE_URL` | 模型 API 地址 | `https://api.deepseek.com` |
| `LLM_MODEL` | 默认模型 | `deepseek-chat` |

## 常见问题

### Q: 后端启动失败？
确保 OpenWrite 核心已安装：
```bash
cd /path/to/Openwrite
pip install -e .
```

### Q: 前端无法连接后端？
检查 CORS 配置，确保前端地址在允许列表中。

### Q: Capacitor 需要 Node.js 22？
升级 Node.js：
```bash
# 使用 nvm
nvm install 22
nvm use 22

# 或下载安装包
# https://nodejs.org/
```

## 生产环境注意事项

1. **API Key 安全**：不要在代码中硬编码 API Key，使用环境变量
2. **HTTPS**：生产环境必须使用 HTTPS
3. **数据备份**：定期备份 `data/` 目录
4. **模型计费**：注意控制 API 调用频率，避免高额费用
