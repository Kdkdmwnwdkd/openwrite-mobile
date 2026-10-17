# OpenWrite Mobile 部署指南

> OpenWrite Mobile 是**纯前端架构**：所有逻辑运行在浏览器 / WebView 中，数据存 IndexedDB，AI 请求由前端直连模型供应商接口。不需要后端服务，也不存在服务端数据目录。

## 方式一：本地静态托管（开发/自用）

```bash
# 任选其一静态托管 frontend/ 目录
python3 -m http.server 8080 --directory frontend
# 或 npx serve frontend
```

访问 `http://localhost:8080` 即可。直接双击 `frontend/index.html`（file:// 协议）时部分浏览器会限制 IndexedDB / Service Worker，推荐用上面的方式。

## 方式二：PWA 安装到手机

1. 把 `frontend/` 部署到任意静态托管（GitHub Pages、Vercel、Netlify、对象存储均可）
2. 手机 Chrome 访问后点「添加到主屏幕」
3. 图标、离线缓存已配置（`frontend/sw.js`）

## 方式三：打包 Android APK

GitHub Actions 会在每次 push 到 `master` / `main` 后自动构建 debug APK 并更新 `nightly-debug` Release，也可手动触发（workflow_dispatch）。

本地构建：

```bash
# 需要 Node.js >= 22、Android SDK
./scripts/build-android.sh
```

注意：当前 CI 使用仓库内的 `keystore/debug.keystore`（debug 签名）。若要正式分发，请改用 release keystore 并通过 GitHub Secrets 注入，不要把签名文件提交进仓库。

## 方式四：Docker（静态托管）

```dockerfile
FROM nginx:alpine
COPY frontend/ /usr/share/nginx/html/
EXPOSE 80
```

## 常见问题

**Q: 首次使用要做什么？**
进入「设置 → 模型配置」填入模型 API Key（默认 DeepSeek，任何 OpenAI 兼容接口均可），然后建议立刻到「设置 → 数据管理」做一次全量备份。

**Q: 数据存在哪里？会丢吗？**
全部在本机 IndexedDB，不上传任何服务器。清理浏览器数据 / 卸载 App 会清空内容，请依赖「数据管理」里的导出备份功能定期备份。

**Q: 换机怎么迁移？**
旧设备导出备份 JSON，新设备在「数据管理」里导入。备份文件**不包含** API Key（导出时自动脱敏），换机后需重新填写 Key。

**Q: Capacitor 需要 Node.js 22？**
是，建议 `nvm install 22` 后使用。

## 生产环境注意事项

1. **API Key 安全**：Key 仅保存在本机 IndexedDB，导出备份会自动脱敏；不要在代码或截图中暴露 Key
2. **HTTPS**：PWA 与 Service Worker 要求 HTTPS 环境（localhost 除外）
3. **数据备份**：提醒用户定期使用「数据管理」导出
4. **模型计费**：AI 续写 / 审稿按调用计费，注意控制频率
