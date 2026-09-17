/**
 * OpenWrite Mobile - Export & Distribution (v2.7.0)
 * 导出 .md / .epub / 网络连载.txt，原生 ZIP(STORE)+CRC32 实现，无外部依赖。
 */

// ===== 最小 ZIP 实现（STORE 无压缩 + CRC32） =====
const ZIP_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function zipCrc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = ZIP_CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 将文件列表打包为 ZIP Blob
 * @param {Array<{name:string, data:Uint8Array}>} files
 * @returns {Blob}
 */
function zipStoreFiles(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const data = file.data;
        const crc = zipCrc32(data);
        const localLen = 30 + nameBytes.length;
        const local = new Uint8Array(localLen);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);        // local file header signature
        dv.setUint16(4, 20, true);                // version needed to extract
        dv.setUint16(6, 0x0800, true);            // general purpose bit flag (UTF-8)
        dv.setUint16(8, 0, true);                 // compression method: STORE
        dv.setUint16(10, 0, true);                // mod time
        dv.setUint16(12, 0x21, true);             // mod date
        dv.setUint32(14, crc, true);              // CRC-32
        dv.setUint32(18, data.length, true);      // compressed size
        dv.setUint32(22, data.length, true);      // uncompressed size
        dv.setUint16(26, nameBytes.length, true); // file name length
        dv.setUint16(28, 0, true);                // extra field length
        local.set(nameBytes, 30);
        chunks.push(local, data);

        central.push({
            nameBytes,
            crc,
            size: data.length,
            offset
        });
        offset += localLen + data.length;
    }

    const centralStart = offset;
    const centralChunks = [];
    for (const entry of central) {
        const len = 46 + entry.nameBytes.length;
        const cd = new Uint8Array(len);
        const dv = new DataView(cd.buffer);
        dv.setUint32(0, 0x02014b50, true);        // central directory signature
        dv.setUint16(4, 20, true);                // version made by
        dv.setUint16(6, 20, true);                // version needed
        dv.setUint16(8, 0x0800, true);            // flags
        dv.setUint16(10, 0, true);                // method STORE
        dv.setUint16(12, 0, true);                // mod time
        dv.setUint16(14, 0x21, true);             // mod date
        dv.setUint32(16, entry.crc, true);
        dv.setUint32(20, entry.size, true);
        dv.setUint32(24, entry.size, true);
        dv.setUint16(28, entry.nameBytes.length, true);
        dv.setUint16(30, 0, true);                // extra len
        dv.setUint16(32, 0, true);                // comment len
        dv.setUint16(34, 0, true);                // disk number
        dv.setUint16(36, 0, true);                // internal attrs
        dv.setUint32(38, 0, true);                // external attrs
        dv.setUint32(42, entry.offset, true);     // local header offset
        cd.set(entry.nameBytes, 46);
        centralChunks.push(cd);
    }
    const centralSize = centralChunks.reduce((s, c) => s + c.length, 0);

    const eocdLen = 22;
    const eocd = new Uint8Array(eocdLen);
    const eocdDv = new DataView(eocd.buffer);
    eocdDv.setUint32(0, 0x06054b50, true);        // end of central directory signature
    eocdDv.setUint16(4, 0, true);                 // disk number
    eocdDv.setUint16(6, 0, true);                 // disk with central dir
    eocdDv.setUint16(8, files.length, true);      // entries on this disk
    eocdDv.setUint16(10, files.length, true);     // total entries
    eocdDv.setUint32(12, centralSize, true);      // central dir size
    eocdDv.setUint32(16, centralStart, true);     // central dir offset
    eocdDv.setUint16(20, 0, true);                // comment len

    const all = [...chunks, ...centralChunks, eocd];
    return new Blob(all, { type: 'application/zip' });
}

// ===== 通用下载 =====
function exportDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 800);
}

function exportSafeName(name) {
    return String(name || 'novel').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

// ===== 排版预览 =====
async function renderNovelExport(container, novelId) {
    const novel = await novelManager.get(novelId);
    if (!novel) { ui.showToast('作品不存在'); navigateTo('bookshelf'); return; }
    store.currentNovel = novel;
    ui.setPageTitle('📤 导出与分发');
    ui.setHeaderActions(`
        <button class="header-btn" onclick="navigateTo('novelDetail', { novelId: '${novelId}' })">返回</button>
    `);
    ui.showLoading(container);

    try {
        const chapters = await novelManager.listChapters(novelId);
        chapters.sort((a, b) => a.number - b.number);
        const wordCount = chapters.reduce((s, c) => s + (c.wordCount || c.content?.length || 0), 0);

        container.innerHTML = `
            <div class="export-wrap">
                <div class="export-book-card">
                    <div class="export-cover">${escapeHtml((novel.title || '?').charAt(0))}</div>
                    <div class="export-book-info">
                        <div class="export-book-title">${escapeHtml(novel.title || '未命名')}</div>
                        <div class="export-book-meta">${chapters.length}章 · ${wordCount.toLocaleString()}字</div>
                        <div class="export-book-desc">${escapeHtml(novel.description || '暂无简介')}</div>
                    </div>
                </div>

                <div class="export-format-buttons">
                    <button class="btn btn-primary btn-block" onclick="exportNovelMarkdown('${novelId}')">📄 导出 Markdown (.md)</button>
                    <button class="btn btn-secondary btn-block" onclick="exportNovelEpub('${novelId}')" style="margin-top:8px;">📖 导出 EPUB 电子书 (.epub)</button>
                    <button class="btn btn-outline btn-block" onclick="exportNovelSerial('${novelId}')" style="margin-top:8px;">✒️ 网络连载格式 (.txt)</button>
                </div>

                <div class="export-section-title">👁 排版预览（章节正文）</div>
                <div class="export-chapter-list" id="export-chapter-list">
                    ${chapters.length === 0
                        ? '<div class="export-empty">暂无章节内容可预览</div>'
                        : chapters.map(c => `
                            <div class="export-chapter-item" data-num="${c.number}" onclick="exportPreviewChapter('${novelId}', ${c.number})">
                                <span>第${c.number}章 ${escapeHtml(c.title || '')}</span>
                                <span class="export-chapter-word">${(c.wordCount || c.content?.length || 0).toLocaleString()}字</span>
                            </div>`).join('')}
                </div>
                ${chapters.length > 0 ? `
                <div class="export-preview" id="export-preview">
                    <div class="export-preview-title" id="export-preview-title"></div>
                    <div class="export-preview-body" id="export-preview-body"></div>
                </div>` : ''}
            </div>`;
    } catch (err) {
        ui.showEmptyState(container, { icon: '⚠️', title: '加载失败', desc: err.message });
    }
}

async function exportPreviewChapter(novelId, chapterNum) {
    const chapter = await novelManager.getChapter(novelId, chapterNum);
    if (!chapter) return;
    const title = `第${chapter.number}章 ${chapter.title || ''}`;
    const body = (chapter.content || '').split('\n').map(p => `<p>${escapeHtml(p)}</p>`).join('');
    const titleEl = document.getElementById('export-preview-title');
    const bodyEl = document.getElementById('export-preview-body');
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.innerHTML = body;
    document.querySelectorAll('.export-chapter-item').forEach(el => {
        el.classList.toggle('active', Number(el.dataset.num) === chapterNum);
    });
}

// ===== 导出 Markdown =====
async function exportNovelMarkdown(novelId) {
    try {
        const novel = await novelManager.get(novelId);
        const chapters = await novelManager.listChapters(novelId);
        chapters.sort((a, b) => a.number - b.number);
        if (chapters.length === 0) { ui.showToast('暂无可导出的章节'); return; }

        const lines = [];
        lines.push(`# ${novel.title || '未命名'}`);
        lines.push('');
        if (novel.description) { lines.push(novel.description.trim()); lines.push(''); }
        lines.push(`> ${chapters.length}章 · ${chapters.reduce((s, c) => s + (c.wordCount || 0), 0).toLocaleString()}字`);
        lines.push('');
        lines.push('---');
        lines.push('');

        chapters.forEach(ch => {
            lines.push(`## 第${ch.number}章 ${ch.title || ''}`);
            lines.push('');
            lines.push((ch.content || '').trim());
            lines.push('');
        });

        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
        exportDownloadBlob(blob, `${exportSafeName(novel.title)}.md`);
        ui.showToast('Markdown 已导出');
    } catch (e) {
        ui.showToast('导出失败: ' + e.message);
    }
}

// ===== 导出网络连载格式 txt =====
async function exportNovelSerial(novelId) {
    try {
        const novel = await novelManager.get(novelId);
        const chapters = await novelManager.listChapters(novelId);
        chapters.sort((a, b) => a.number - b.number);
        if (chapters.length === 0) { ui.showToast('暂无可导出的章节'); return; }

        const lines = [];
        lines.push(novel.title || '未命名');
        lines.push('');
        lines.push(`${chapters.length}章 · ${chapters.reduce((s, c) => s + (c.wordCount || 0), 0).toLocaleString()}字`);
        lines.push('');
        if (novel.description) { lines.push(novel.description.trim()); lines.push(''); }
        lines.push('------------');
        lines.push('');

        chapters.forEach(ch => {
            lines.push(`第${ch.number}章 ${ch.title || ''}`);
            lines.push('');
            lines.push((ch.content || '').trim());
            lines.push('');
            lines.push('');
        });

        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        exportDownloadBlob(blob, `${exportSafeName(novel.title)}_连载.txt`);
        ui.showToast('连载格式已导出');
    } catch (e) {
        ui.showToast('导出失败: ' + e.message);
    }
}

// ===== 导出 EPUB =====
function exportXmlEscape(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function exportUuid() {
    try {
        if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

async function exportNovelEpub(novelId) {
    try {
        const novel = await novelManager.get(novelId);
        const chapters = await novelManager.listChapters(novelId);
        chapters.sort((a, b) => a.number - b.number);
        if (chapters.length === 0) { ui.showToast('暂无可导出的章节'); return; }

        const title = novel.title || '未命名';
        const author = (novel.author || novel.genre || 'OpenWrite').trim() || 'OpenWrite';
        const uuid = exportUuid();
        const enc = (s) => new TextEncoder().encode(s);
        const files = [];

        // 1) mimetype 必须第一个且 STORE
        files.push({ name: 'mimetype', data: enc('application/epub+zip') });

        // 2) container.xml
        files.push({
            name: 'META-INF/container.xml',
            data: enc(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
        });

        // 3) 章节 xhtml
        const spineIds = [];
        chapters.forEach((ch, i) => {
            const id = `ch${i + 1}`;
            spineIds.push(id);
            const paragraphs = (ch.content || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => `<p>${exportXmlEscape(p.trim())}</p>`).join('');
            files.push({
                name: `OEBPS/chapter-${i + 1}.xhtml`,
                data: enc(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <title>第${ch.number}章 ${exportXmlEscape(ch.title || '')}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h2>第${ch.number}章 ${exportXmlEscape(ch.title || '')}</h2>
  ${paragraphs}
</body>
</html>`)
            });
        });

        // 4) nav 目录 (EPUB3)
        const navItems = chapters.map((ch, i) =>
            `<li><a href="chapter-${i + 1}.xhtml">第${ch.number}章 ${exportXmlEscape(ch.title || '')}</a></li>`).join('');
        files.push({
            name: 'OEBPS/nav.xhtml',
            data: enc(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>${navItems}</ol>
  </nav>
</body>
</html>`)
        });

        // 5) content.opf
        const manifests = [
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
            ...spineIds.map((id, i) => `<item id="${id}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`),
            '<item id="css" href="style.css" media-type="text/css"/>'
        ].join('\n    ');
        const spineRefs = spineIds.map(id => `<itemref idref="${id}"/>`).join('\n    ');
        files.push({
            name: 'OEBPS/content.opf',
            data: enc(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${exportXmlEscape(title)}</dc:title>
    <dc:creator>${exportXmlEscape(author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    ${manifests}
  </manifest>
  <spine>
    ${spineRefs}
  </spine>
</package>`)
        });

        // 6) 样式
        files.push({
            name: 'OEBPS/style.css',
            data: enc(`body { font-family: serif; line-height: 1.8; margin: 5% 8%; }
h2 { font-size: 1.4em; margin-bottom: 1em; }
p { text-indent: 2em; margin: 0.6em 0; }
`)
        });

        const zipBlob = zipStoreFiles(files);
        const epubBlob = new Blob([zipBlob], { type: 'application/epub+zip' });
        exportDownloadBlob(epubBlob, `${exportSafeName(title)}.epub`);
        ui.showToast('EPUB 已导出');
    } catch (e) {
        ui.showToast('EPUB 导出失败: ' + e.message);
    }
}