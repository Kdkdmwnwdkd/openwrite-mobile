/**
 * OpenWrite Mobile - 多设备同步（sync.js）
 * ------------------------------------------------------------------
 * 用 WebDAV 做整库快照同步：坚果云、群晖、Nextcloud、InfiniCLOUD 都能用。
 * 不引入自建服务器——作者自己填个网盘地址就能在手机/平板/电脑之间搬稿子。
 *
 * 三条原则：
 *   1) 不做后台自动覆盖。上传/下载都要么用户按的，要么确认过。
 *   2) 下载前先在本机留一份回滚点，同步错了能退回去。
 *   3) 快照里永远不含 API Key 与 WebDAV 密码（db.exportAll 已脱敏）。
 *
 * 跨域：WebDAV 服务器基本不发 CORS 头，网页里 fetch 会被拦。
 * 所以优先走 CapacitorHttp（原生请求，没有同源限制），网页环境退回 fetch。
 */

const SYNC_DEFAULT = { url: '', user: '', pass: '', file: 'openwrite-sync.json', autoCheck: false };

async function getSyncConfig() {
    const saved = await settings.get('syncConfig', null);
    return Object.assign({}, SYNC_DEFAULT, saved || {});
}

async function setSyncConfig(cfg) {
    await settings.set('syncConfig', Object.assign({}, SYNC_DEFAULT, cfg));
}

function syncConfigured(cfg) {
    return !!(cfg && cfg.url && cfg.user && cfg.pass);
}

function syncUrl(cfg) {
    const base = String(cfg.url || '').trim().replace(/\/+$/, '');
    const file = String(cfg.file || 'openwrite-sync.json').trim().replace(/^\/+/, '');
    return `${base}/${encodeURI(file)}`;
}

function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// 原生 HTTP：Capacitor 自带，能绕过 CORS。网页环境返回 null。
function nativeHttp() {
    const C = window.Capacitor;
    if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return null;
    return (C.Plugins && C.Plugins.CapacitorHttp) || null;
}

async function davRequest(cfg, method, payload) {
    const url = syncUrl(cfg);
    const headers = { Authorization: 'Basic ' + b64utf8(`${cfg.user}:${cfg.pass}`) };
    if (payload) headers['Content-Type'] = 'application/json; charset=utf-8';

    const Http = nativeHttp();
    if (Http) {
        const res = await Http.request({
            url,
            method,
            headers,
            data: payload || undefined,
            responseType: 'text',
            connectTimeout: 15000,
            readTimeout: 30000
        });
        return { status: res.status, ok: res.status >= 200 && res.status < 300, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) };
    }

    const res = await fetch(url, {
        method,
        headers,
        body: payload ? JSON.stringify(payload) : undefined
    });
    return { status: res.status, ok: res.ok, text: await res.text() };
}

function syncErrorText(status) {
    if (status === 401) return '账号或密码不对（坚果云要用「应用密码」，不是登录密码）';
    if (status === 403) return '没有权限，检查目录是否可写';
    if (status === 404) return '路径不存在，检查地址是否指向一个已存在的文件夹';
    if (status === 405) return '服务器不允许这个方法（PUT/GET）';
    if (status >= 500) return '服务器出错（' + status + '）';
    return '同步失败（HTTP ' + status + '）';
}

// ===== 快照 =====
async function syncDeviceId() {
    let id = await settings.get('deviceId', null);
    if (!id) { id = makeId('dev'); await settings.set('deviceId', id); }
    return id;
}

async function syncBuildSnapshot() {
    const data = await db.exportAll();     // 已脱敏：不含 Key 与密码
    // 同步文件是给别的设备用的，本机的 WebDAV 配置不该跟着上传
    data.stores.settings = (data.stores.settings || []).filter(r => r && r.key !== 'syncConfig');
    return {
        app: 'OpenWrite Mobile',
        kind: 'sync-snapshot',
        schema: 1,
        rev: Date.now(),
        createdAt: new Date().toISOString(),
        device: await syncDeviceId(),
        stores: data.stores
    };
}

async function syncApplySnapshot(snap) {
    if (!snap || snap.kind !== 'sync-snapshot' || !snap.stores) {
        throw new Error('这不是 OpenWrite 的同步文件');
    }
    // 先留回滚点：同步错了还能退回来
    const before = await db.exportAll();
    await settings.set('preSyncBackup', { at: Date.now(), data: before });
    const r = await db.importAll({ stores: snap.stores });
    return r;
}

async function syncLocalUpdated() {
    let max = 0;
    const novels = await novelManager.list();
    for (const n of novels) max = Math.max(max, n.updated || 0);
    const chapters = await db.getAll('chapters');
    for (const c of chapters) max = Math.max(max, c.updated || 0);
    return max;
}

// ===== 同步动作 =====
async function syncUpload(cfg) {
    const snap = await syncBuildSnapshot();
    const res = await davRequest(cfg, 'PUT', snap);
    if (!res.ok) throw new Error(syncErrorText(res.status));
    await settings.set('syncMeta', { lastSyncAt: snap.rev, remoteRev: snap.rev, at: Date.now() });
    return snap.rev;
}

async function syncDownload(cfg) {
    const res = await davRequest(cfg, 'GET');
    if (!res.ok) throw new Error(syncErrorText(res.status));
    let snap;
    try { snap = JSON.parse(res.text); } catch (e) { throw new Error('云端文件不是合法 JSON'); }
    const r = await syncApplySnapshot(snap);
    await settings.set('syncMeta', { lastSyncAt: snap.rev || Date.now(), remoteRev: snap.rev || Date.now(), at: Date.now() });
    return { snap, r };
}

async function syncCheck(cfg) {
    const meta = await settings.get('syncMeta', { lastSyncAt: 0 });
    const localAt = await syncLocalUpdated();
    const res = await davRequest(cfg, 'GET');

    if (res.status === 404) return { remote: null, meta, localAt };
    if (!res.ok) throw new Error(syncErrorText(res.status));

    let remote = null;
    try { remote = JSON.parse(res.text); } catch (e) { throw new Error('云端文件不是合法 JSON'); }
    return { remote, meta, localAt };
}

// 主入口：先判断该往哪边走，再决定
async function runSync(force) {
    const cfg = await getSyncConfig();
    if (!syncConfigured(cfg)) {
        ui.showToast('先把同步配置填完');
        if (store.currentPage === 'sync') {
            const el = document.getElementById('sc-url');
            if (el) el.focus();
        } else {
            navigateTo('sync', {}, true);
        }
        return;
    }

    ui.showToast('正在检查云端…');
    let state;
    try { state = await syncCheck(cfg); }
    catch (e) { ui.showToast(e.message, 4000); return; }

    const { remote, meta, localAt } = state;
    const lastSyncAt = meta.lastSyncAt || 0;

    if (!remote) {
        if (!confirm('云端还没有同步文件，要把本机的书上传上去吗？')) return;
        return doUpload(cfg);
    }

    const remoteRev = remote.rev || 0;
    const localChanged = localAt > lastSyncAt;
    const remoteChanged = remoteRev > lastSyncAt;

    if (force === 'up') return doUpload(cfg);
    if (force === 'down') return doDownload(cfg);

    if (!localChanged && !remoteChanged) { ui.showToast('已是最新'); return; }
    if (localChanged && !remoteChanged) return doUpload(cfg);
    if (!localChanged && remoteChanged) return askDownload(cfg, remote);
    return askConflict(cfg, remote, localAt);
}

async function doUpload(cfg) {
    try {
        ui.showToast('正在上传…');
        await syncUpload(cfg);
        ui.showToast('已上传到云端');
        renderSyncRefresh();
    } catch (e) { ui.showToast(e.message, 4000); }
}

function askDownload(cfg, remote) {
    const when = remote.createdAt ? new Date(remote.createdAt).toLocaleString('zh-CN') : '未知时间';
    const modal = createModal('云端有新版本', `
        <div class="sync-note">云端更新于 <b>${escapeHtml(when)}</b>。<br>
        下载会覆盖本机全部作品，同步前的数据会自动留一份回滚点。</div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="confirmDownload()">下载并覆盖本机</button>
        </div>`);
    modal.show();
}

function askConflict(cfg, remote, localAt) {
    const when = remote.createdAt ? new Date(remote.createdAt).toLocaleString('zh-CN') : '未知';
    const localWhen = localAt ? new Date(localAt).toLocaleString('zh-CN') : '未知';
    createModal('两端都改过', `
        <div class="sync-note">
            云端更新于 <b>${escapeHtml(when)}</b><br>
            本机更新于 <b>${escapeHtml(localWhen)}</b><br><br>
            整库快照没法自动合并，选一边覆盖。被覆盖的那边会留回滚点。
        </div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeModal()">取消</button>
            <button class="btn btn-outline" onclick="closeModal(); forceDownload()">用云端的</button>
            <button class="btn btn-primary" onclick="closeModal(); forceUpload()">用本机的</button>
        </div>`).show();
}

async function confirmDownload() {
    closeModal();
    const cfg = await getSyncConfig();
    return doDownload(cfg);
}

async function doDownload(cfg) {
    try {
        ui.showToast('正在下载…');
        const { r } = await syncDownload(cfg);
        ui.showToast(`已从云端恢复 ${r.imported} 条`, 3500);
        renderSyncRefresh();
    } catch (e) { ui.showToast(e.message, 4000); }
}

async function forceUpload() { const cfg = await getSyncConfig(); return doUpload(cfg); }
async function forceDownload() { const cfg = await getSyncConfig(); return doDownload(cfg); }

// 回滚：把下载前的本机数据还回去
async function restorePreSync() {
    const bak = await settings.get('preSyncBackup', null);
    if (!bak || !bak.data) { ui.showToast('没有可回滚的数据'); return; }
    if (!confirm('把本机数据恢复到上次同步之前？当前内容会被覆盖。')) return;
    try {
        await db.importAll({ stores: bak.data.stores });
        ui.showToast('已恢复到同步前');
        renderSyncRefresh();
    } catch (e) { ui.showToast('恢复失败：' + e.message); }
}

// ===== 页面 =====
function renderSyncRefresh() {
    if (store.currentPage === 'sync') navigateTo('sync', {}, true);
}

async function renderSync(container) {
    ui.setPageTitle('多设备同步');
    ui.setHeaderActions(`<button class="header-btn" onclick="navigateTo('settings')">返回</button>`);

    const cfg = await getSyncConfig();
    const meta = await settings.get('syncMeta', { lastSyncAt: 0 });
    const bak = await settings.get('preSyncBackup', null);

    const lastSync = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('zh-CN') : '还没同步过';
    const bakAt = bak && bak.at ? new Date(bak.at).toLocaleString('zh-CN') : '';

    container.innerHTML = `
        <div class="sync-wrap">
            <div class="sync-card">
                <div class="sync-card-title">WebDAV 配置</div>
                <div class="form-group">
                    <label class="form-label">地址（指向一个已存在的文件夹）</label>
                    <input class="input" id="sc-url" placeholder="https://dav.jianguoyun.com/dav/我的小说" value="${escapeAttr(cfg.url || '')}">
                </div>
                <div class="form-group">
                    <label class="form-label">账号</label>
                    <input class="input" id="sc-user" autocomplete="username" value="${escapeAttr(cfg.user || '')}">
                </div>
                <div class="form-group">
                    <label class="form-label">密码 / 应用密码</label>
                    <input class="input" id="sc-pass" type="password" autocomplete="current-password" value="${escapeAttr(cfg.pass || '')}">
                </div>
                <div class="form-group">
                    <label class="form-label">文件名</label>
                    <input class="input" id="sc-file" value="${escapeAttr(cfg.file || 'openwrite-sync.json')}">
                </div>
                <div class="sync-hint">
                    坚果云要在「账户信息 → 安全选项 → 应用密码」里单独生成一个，别用登录密码。
                    密码只存在本机，导出的备份里会被清空。
                </div>
                <div class="sync-actions">
                    <button class="btn btn-outline" onclick="testSyncConnection()">测试连接</button>
                    <button class="btn btn-primary" onclick="saveSyncConfigAndStay()">保存</button>
                </div>
            </div>

            <div class="sync-card">
                <div class="sync-card-title">同步</div>
                <div class="sync-status">
                    <div><span>上次同步</span><b>${escapeHtml(lastSync)}</b></div>
                    ${bakAt ? `<div><span>回滚点</span><b>${escapeHtml(bakAt)}</b></div>` : ''}
                </div>
                <div class="sync-actions sync-actions-col">
                    <button class="btn btn-primary btn-block" onclick="runSync()">立即同步</button>
                    <div class="sync-split">
                        <button class="btn btn-outline" onclick="runSync('up')">仅上传</button>
                        <button class="btn btn-outline" onclick="runSync('down')">仅下载</button>
                    </div>
                    ${bakAt ? `<button class="btn btn-outline btn-block" onclick="restorePreSync()">恢复到同步前</button>` : ''}
                </div>
                <div class="sync-hint">
                    整库快照：以较新的一端为准。两端都改过时会问你，不会静默覆盖。
                </div>
            </div>
        </div>`;
}

function collectSyncForm() {
    return {
        url: (document.getElementById('sc-url') || {}).value || '',
        user: (document.getElementById('sc-user') || {}).value || '',
        pass: (document.getElementById('sc-pass') || {}).value || '',
        file: (document.getElementById('sc-file') || {}).value || 'openwrite-sync.json'
    };
}

async function saveSyncForm() {
    const cfg = collectSyncForm();
    cfg.url = cfg.url.trim();
    cfg.user = cfg.user.trim();
    cfg.file = cfg.file.trim() || 'openwrite-sync.json';
    if (cfg.url && !/^https?:\/\//i.test(cfg.url)) {
        ui.showToast('地址要以 http:// 或 https:// 开头');
        return null;
    }
    await setSyncConfig(cfg);
    return cfg;
}

async function saveSyncConfigAndStay() {
    const cfg = await saveSyncForm();
    if (!cfg) return;
    ui.showToast('已保存');
    renderSyncRefresh();
}

async function testSyncConnection() {
    const cfg = await saveSyncForm();
    if (!cfg) return;
    if (!syncConfigured(cfg)) { ui.showToast('地址、账号、密码都要填'); return; }

    ui.showToast('正在连接…');
    try {
        const res = await davRequest(cfg, 'GET');
        if (res.status === 404) {
            // 文件不存在但能读到 404，说明认证和路径都通了
            ui.showToast('连接成功（云端还没有同步文件）', 3500);
        } else if (res.ok) {
            ui.showToast('连接成功', 3000);
        } else {
            ui.showToast(syncErrorText(res.status), 4000);
        }
    } catch (e) {
        ui.showToast('连不上：' + e.message, 4000);
    }
}

// 启动时静默检查一次（只在配置过的情况下）
async function maybeAutoCheckSync() {
    try {
        const cfg = await getSyncConfig();
        if (!syncConfigured(cfg)) return;
        const { remote, meta } = await syncCheck(cfg);
        if (remote && (remote.rev || 0) > (meta.lastSyncAt || 0)) {
            ui.showToast('云端有更新，去「设置 → 多设备同步」查看', 4000);
        }
    } catch (e) { /* 网络问题不打扰用户 */ }
}

// ===== 样式 =====
(function injectSyncStyle() {
    if (document.getElementById('sc-style')) return;
    const s = document.createElement('style');
    s.id = 'sc-style';
    s.textContent = `
    .sync-wrap{padding:12px 16px 64px;display:flex;flex-direction:column;gap:14px}
    .sync-card{background:#fff;border:1px solid #eee;border-radius:12px;padding:16px}
    .sync-card-title{font-size:14px;font-weight:600;margin-bottom:12px}
    .sync-hint{font-size:11.5px;color:#9a9a9a;line-height:1.7;margin-top:8px}
    .sync-actions{display:flex;gap:10px;margin-top:14px}
    .sync-actions .btn{flex:1}
    .sync-actions-col{flex-direction:column}
    .sync-split{display:flex;gap:10px}
    .sync-split .btn{flex:1}
    .sync-status{font-size:13px;color:#666;line-height:2}
    .sync-status span{color:#9a9a9a;margin-right:10px}
    .sync-status b{font-weight:600;color:#333}
    .sync-note{font-size:13.5px;line-height:1.9;color:#555}
    `;
    document.head.appendChild(s);
})();
