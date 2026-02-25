// content.js — DexManager Log Analyzer AI (Standalone Modal)
// This script does NOT modify DexManager's DOM. It reads log text and renders
// everything in its own overlay modal on document.body.

console.log("🚀 DexManager Log Analyzer AI Started!");

// ─── Shadow DOM Traversal ────────────────────────────────────────────────────
function findElementDeep(root, selector) {
    let el = root.querySelector(selector);
    if (el) return el;
    const children = root.querySelectorAll('*');
    for (let child of children) {
        if (child.shadowRoot) {
            const found = findElementDeep(child.shadowRoot, selector);
            if (found) return found;
        }
    }
    return null;
}

// ─── State ───────────────────────────────────────────────────────────────────
let contextFileText = "";
let lastLogText = "";
let analyzerDismissed = false;

try {
    fetch(chrome.runtime.getURL('resume.txt'))
        .then(r => r.text())
        .then(t => { contextFileText = t; })
        .catch(() => { });
} catch (e) { /* chrome.runtime not available in this frame */ }

// ─── Detection Loop ──────────────────────────────────────────────────────────
// Polymer keeps paper-dialog in the DOM always — check `opened` attribute to
// know if the dialog is actually visible.
setInterval(() => {
    const dialog = findElementDeep(document, 'paper-dialog#previewLogDialog');
    const isOpen = dialog && (dialog.hasAttribute('opened') || dialog.style.display !== 'none');

    if (!isOpen) {
        // Dialog closed — reset state so next open triggers the analyzer
        lastLogText = "";
        analyzerDismissed = false;
        return;
    }

    const logContent = dialog.querySelector('.content-body');
    if (!logContent) return;

    const raw = logContent.textContent.trim();
    if (raw.length < 50) return;

    // User closed the analyzer manually — don't reopen for the same content
    if (analyzerDismissed && raw === lastLogText) return;

    if (raw === lastLogText) return;
    lastLogText = raw;
    analyzerDismissed = false;

    openAnalyzerModal(raw);
}, 1500);

// ─── Extra Parsing Regexes ───────────────────────────────────────────────────
const cpuRamRegex = /CPU:\s*([\d.]+)%.*?Used RAM:\s*([\d.]+)\s*Mb/;
const syncDriftRegex = /ElapsedMasterToSlave\s+(\d+)ms\|IntervalTimeSetted\s+(\d+)ms\|Now:(\d+)\|Received:(\d+)/;
const mediaPlayRegex = /PLAY Command received\.\s*Media\s*"([^"]+)"/;
const rebootRegex = /Device will reboot in (\d+) minutes/;
const groupMembersRegex = /Members:\s*(.+)/;
const metadataRegex = /Metadata changed from .+ to (\{.+\})/;
const platformRegex = /OffsetsManager PLATFORM:\s*(.+)/;
const useragentRegex = /OffsetsManager USERAGENT:\s*(.+)/;
const playerVersionRegex = /^Player Version:\s*(.+)/;
const firmwareVersionRegex = /^Firmware Version:\s*(.+)/;
const heartbeatSuccessRegex = /Heartbeat received from server/;
const heartbeatFailRegex = /Heartbeat Sync failed.*?Status:\s*(.+)/;
const dexStoreFetchRegex = /Fetch DexStore:\s*(\w+)/;
const dexStoreErrorRegex = /Fetch DexStore.*?(Error.*)/;
const screenshotUploadRegex = /Screenshot Uploaded to\s+(.+)/;
const screenshotFailRegex = /Screenshot.*(?:fail|error)/i;
const xmlFetchRegex = /Fetch xml:\s*(.+)/;
const disconnectedRegex = /Disconnected from Dex Sync/;
const reconnectedRegex = /Reconnected/;
const connectedRegex = /Connected to server/;
const networkErrorRegex = /(?:Network Error|status code (\d+))/;
const multicastRegex = /Multicast Group Name:\s*"([^"]+)".*IP:\s*([\d.]+)/;
const duidRegex = /Getting System DUID/;
const dexConfigRegex = /Found dex_config\.xml/;
const integrityFailRegex = /Missing Content:\s*(\d+)\s*files?\.\s*Media:\s*(.+)/;
const downloadStartRegex = /Downloading (true|false)/;
const downloadCompleteRegex = /Download.*?(?:complete|finished|success)/i;
const downloadErrorRegex = /Download.*?(?:error|fail|timeout)/i;

// ─── Modal ───────────────────────────────────────────────────────────────────
function openAnalyzerModal(rawText) {
    const prev = document.getElementById('ai-log-analyzer-overlay');
    if (prev) prev.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ai-log-analyzer-overlay';

    // Parse lines
    const lines = rawText.split('\n');
    const regex = /^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2}\.\d+)\s([A-Z]+)\s(?:(\[[^\]]+\])\s)?(.*)$/;
    const components = new Set();
    const parsed = [];

    let minTime = '23:59', maxTime = '00:00';

    // Extended data structures
    const healthData = [];
    const syncData = [];
    let syncGroupInfo = null;
    const mediaTimeline = [];
    const deviceInfo = {};
    const rebootData = [];
    const apiHealth = [];
    const syncEvents = [];
    const downloadData = [];

    lines.forEach((line, index) => {
        if (!line.trim()) return;
        const match = line.match(regex);
        if (match) {
            const [, date, time, level, component, message] = match;
            const comp = component || '[General]';
            const hm = time.substring(0, 5);
            components.add(comp);
            if (hm < minTime) minTime = hm;
            if (hm > maxTime) maxTime = hm;
            parsed.push({ date, time, hm, level, comp, message, raw: line, index });

            const fullMsg = (comp + ' ' + message);

            // CPU / RAM
            const cpuMatch = message.match(cpuRamRegex);
            if (cpuMatch) {
                healthData.push({ time: hm, timeFull: time, cpu: parseFloat(cpuMatch[1]), ram: parseFloat(cpuMatch[2]) });
            }

            // Sync drift
            const syncMatch = message.match(syncDriftRegex);
            if (syncMatch) {
                const now = parseInt(syncMatch[3]);
                const received = parseInt(syncMatch[4]);
                syncData.push({
                    time: hm, timeFull: time,
                    elapsed: parseInt(syncMatch[1]),
                    interval: parseInt(syncMatch[2]),
                    now, received,
                    drift: Math.abs(now - received)
                });
            }

            // Sync group members
            const groupMatch = fullMsg.match(groupMembersRegex);
            if (groupMatch) {
                const membersStr = groupMatch[1].trim();
                const members = [];
                const memberParts = membersStr.split(/\s+/);
                for (let i = 0; i < memberParts.length; i++) {
                    const part = memberParts[i];
                    if (/^\d+\.\d+\.\d+\.\d+$/.test(part)) {
                        const role = (memberParts[i + 1] === '[Master]') ? 'Master' : 'Slave';
                        members.push({ ip: part, role });
                        if (role === 'Master') i++;
                    }
                }
                // Extract group name from the full line
                const grpNameMatch = fullMsg.match(/Group:\s*([^\s-]+(?:-[^\s-]+)*)\s*-\s*Members/);
                const versionMatch = fullMsg.match(/Version:\s*([\d.]+)/);
                syncGroupInfo = {
                    version: versionMatch ? versionMatch[1] : '',
                    group: grpNameMatch ? grpNameMatch[1] : '',
                    members
                };
            }

            // Multicast group
            const multiMatch = message.match(multicastRegex);
            if (multiMatch && !syncGroupInfo) {
                syncGroupInfo = syncGroupInfo || {};
                syncGroupInfo.multicastGroup = multiMatch[1];
                syncGroupInfo.multicastIP = multiMatch[2];
            }

            // Media play
            const playMatch = message.match(mediaPlayRegex);
            if (playMatch) {
                mediaTimeline.push({ time: hm, timeFull: time, date, media: playMatch[1], type: 'play' });
            }

            // Template unmount
            if (message.includes('Unmounting')) {
                mediaTimeline.push({ time: hm, timeFull: time, date, media: '', type: 'unmount' });
            }

            // Reboot countdown
            const rebootMatch = message.match(rebootRegex);
            if (rebootMatch) {
                rebootData.push({ time: hm, timeFull: time, minutesLeft: parseInt(rebootMatch[1]) });
            }

            // Device info
            const metaMatch = message.match(metadataRegex);
            if (metaMatch) {
                try {
                    const meta = JSON.parse(metaMatch[1]);
                    if (meta.Server) deviceInfo.server = meta.Server;
                    if (meta.StoreId) deviceInfo.storeId = meta.StoreId;
                    if (meta.CustomerId) deviceInfo.customerId = meta.CustomerId;
                    if (meta.Id) deviceInfo.playerId = meta.Id;
                    if (meta.Tags) deviceInfo.tags = meta.Tags;
                    if (meta.DisplayType) deviceInfo.displayType = meta.DisplayType;
                    if (meta.TimeZone !== undefined) deviceInfo.timeZone = meta.TimeZone;
                } catch (e) { /* ignore malformed JSON */ }
            }
            const platMatch = message.match(platformRegex);
            if (platMatch) deviceInfo.platform = platMatch[1].trim();
            const uaMatch = message.match(useragentRegex);
            if (uaMatch) deviceInfo.userAgent = uaMatch[1].trim();
            const pvMatch = message.match(playerVersionRegex);
            if (pvMatch) deviceInfo.playerVersion = pvMatch[1].trim();
            const fvMatch = message.match(firmwareVersionRegex);
            if (fvMatch) deviceInfo.firmwareVersion = fvMatch[1].trim();

            // API health tracking
            if (heartbeatSuccessRegex.test(message)) {
                apiHealth.push({ time: hm, timeFull: time, api: 'Heartbeat', success: true });
            }
            const hbFail = message.match(heartbeatFailRegex);
            if (hbFail) {
                apiHealth.push({ time: hm, timeFull: time, api: 'Heartbeat', success: false, error: hbFail[1] });
            }
            const dsMatch = message.match(dexStoreFetchRegex);
            if (dsMatch) {
                apiHealth.push({ time: hm, timeFull: time, api: 'DexStore', success: dsMatch[1] === 'Success' });
            }
            const dsErr = message.match(dexStoreErrorRegex);
            if (dsErr) {
                apiHealth.push({ time: hm, timeFull: time, api: 'DexStore', success: false, error: dsErr[1] });
            }
            if (screenshotUploadRegex.test(message)) {
                apiHealth.push({ time: hm, timeFull: time, api: 'Screenshot', success: true });
            }
            if (screenshotFailRegex.test(message)) {
                apiHealth.push({ time: hm, timeFull: time, api: 'Screenshot', success: false });
            }
            const xmlMatch = message.match(xmlFetchRegex);
            if (xmlMatch) {
                apiHealth.push({ time: hm, timeFull: time, api: 'XML Pricing', success: !xmlMatch[1].toLowerCase().includes('error') });
            }

            // Network / sync events
            if (disconnectedRegex.test(message)) {
                syncEvents.push({ time: hm, timeFull: time, event: 'Disconnected', detail: message });
            }
            if (reconnectedRegex.test(message)) {
                syncEvents.push({ time: hm, timeFull: time, event: 'Reconnected', detail: message });
            }
            if (connectedRegex.test(message)) {
                syncEvents.push({ time: hm, timeFull: time, event: 'Connected', detail: message });
            }
            const netErr = message.match(networkErrorRegex);
            if (netErr && level === 'ERROR') {
                syncEvents.push({ time: hm, timeFull: time, event: 'Network Error', detail: message });
            }
            const intFail = message.match(integrityFailRegex);
            if (intFail) {
                syncEvents.push({ time: hm, timeFull: time, event: 'Integrity Fail', detail: `${intFail[1]} files missing: ${intFail[2]}` });
            }

            // Download events (F13)
            if (comp === '[Download Manager]' || comp === '[Screenshots Manager]') {
                const dlStart = message.match(downloadStartRegex);
                if (dlStart) downloadData.push({ time: hm, timeFull: time, type: dlStart[1] === 'true' ? 'downloading' : 'idle', message, level });
                if (downloadCompleteRegex.test(message)) downloadData.push({ time: hm, timeFull: time, type: 'complete', message, level });
                if (downloadErrorRegex.test(message) || level === 'ERROR') downloadData.push({ time: hm, timeFull: time, type: 'error', message, level });
            }

            // Detect reboot (DUID + dex_config sequence)
            if (duidRegex.test(message)) {
                syncEvents.push({ time: hm, timeFull: time, event: 'Device Boot', detail: 'System DUID initialization' });
            }
        } else {
            parsed.push({ raw: line, index });

            // Check unstructured lines (like "Player Version: ...")
            const pvMatch2 = line.match(/Player Version:\s*(.+)/);
            if (pvMatch2) deviceInfo.playerVersion = pvMatch2[1].trim();
            const fvMatch2 = line.match(/Firmware Version:\s*(.+)/);
            if (fvMatch2) deviceInfo.firmwareVersion = fvMatch2[1].trim();
        }
    });

    // ─── Analysis Functions ──────────────────────────────────────────────
    const memoryTrend = analyzeMemoryTrend(healthData);
    const rebootInfo = analyzeReboots(rebootData, syncEvents);
    const mediaStats = buildMediaStats(mediaTimeline);
    const apiStats = buildApiStats(apiHealth);
    const errorGroups = buildErrorGroups(parsed);
    const downloadStats = buildDownloadStats(downloadData, syncEvents);

    // ─── Bookmarks State ─────────────────────────────────────────────────
    const bookmarks = new Set();
    let bookmarkCounter = 0;

    // Build HTML
    overlay.innerHTML = `
        <div class="ala-backdrop"></div>
        <div class="ala-modal">
            <div class="ala-header">
                <div class="ala-title-row">
                    <span class="ala-title"><strong>Log Analyzer</strong></span>
                    <div class="ala-search-group">
                        <input type="text" class="ala-search" placeholder="Buscar...">
                        <button class="ala-regex-toggle" title="Regex mode">.*</button>
                    </div>
                    <span class="ala-bookmark-nav">
                        <span class="ala-bookmark-count" title="Bookmarks">0</span>
                        <button class="ala-bookmark-prev" title="Bookmark anterior">&#9650;</button>
                        <button class="ala-bookmark-next" title="Bookmark siguiente">&#9660;</button>
                    </span>
                    <button class="ala-dark-toggle" title="Dark mode">&#9789;</button>
                    <button class="ala-sync-btn" title="Sincronizar con otros tabs">&#128279; Sync</button>
                    <button class="ala-close-btn">&#10005;</button>
                </div>
                <div class="ala-controls">
                    <div class="ala-filter-row">
                        <div class="ala-levels">
                            ${['INFO', 'DEBUG', 'WARNING', 'ERROR', 'SUCCESS'].map(l =>
        `<button class="ala-chip ala-level-chip active" data-level="${l}">${l}</button>`
    ).join('')}
                        </div>
                        <div class="ala-time-range">
                            <span class="ala-time-label">Hora</span>
                            <input type="time" class="ala-time-input ala-time-from" value="${minTime}" min="${minTime}" max="${maxTime}">
                            <span class="ala-time-sep">&mdash;</span>
                            <input type="time" class="ala-time-input ala-time-to" value="${maxTime}" min="${minTime}" max="${maxTime}">
                        </div>
                    </div>
                    <div class="ala-components">
                        <button class="ala-chip ala-comp-toggle">Ninguno</button>
                        ${Array.from(components).map(c =>
        `<button class="ala-chip ala-comp-chip active" data-comp="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    ).join('')}
                    </div>
                    <div class="ala-actions-row">
                        <button class="ala-summarize-btn">Resumir Logs</button>
                        <button class="ala-export-btn">&#128229; Exportar TXT</button>
                        <span class="ala-visible-count"></span>
                    </div>
                </div>
            </div>
            <div class="ala-tab-bar">
                <button class="ala-tab active" data-tab="logs">Logs</button>
                <button class="ala-tab" data-tab="dashboard">Dashboard</button>
                <button class="ala-tab" data-tab="timeline">Timeline</button>
                <button class="ala-tab" data-tab="sync">Sync</button>
                <button class="ala-tab" data-tab="downloads">Downloads</button>
            </div>
            <div class="ala-summary-container"></div>
            <div class="ala-tab-content active" data-content="logs">
                <div class="ala-log-body">
                    ${parsed.map(p => {
        if (p.level) {
            return `<div class="ala-line" data-level="${p.level}" data-comp="${escapeHtml(p.comp)}" data-hm="${p.hm}" data-text="${escapeHtml(p.raw.toLowerCase())}" data-idx="${p.index}" data-raw="${escapeHtml(p.raw)}">` +
                `<span class="ala-line-bookmark" title="Bookmark"></span>` +
                `<span class="ala-date">${p.date}</span>` +
                `<span class="ala-time">${p.time}</span>` +
                `<span class="ala-level ala-${p.level.toLowerCase()}">${p.level}</span>` +
                `<span class="ala-comp">${escapeHtml(p.comp)}</span>` +
                `<span class="ala-msg" data-original="${escapeHtml(p.message)}">${renderMessageWithJSON(escapeHtml(p.message))}</span>` +
                ((p.level === 'ERROR' || p.level === 'WARNING') ?
                    `<button class="ala-explain-btn" data-idx="${p.index}">&#10024; Explicar</button>` : '') +
                `</div>`;
        }
        return `<div class="ala-line ala-unparsed" data-text="${escapeHtml(p.raw.toLowerCase())}" data-idx="${p.index}" data-raw="${escapeHtml(p.raw)}"><span class="ala-line-bookmark" title="Bookmark"></span>${renderMessageWithJSON(escapeHtml(p.raw))}</div>`;
    }).join('')}
                </div>
            </div>
            <div class="ala-tab-content" data-content="dashboard">
                ${buildDashboardHTML(deviceInfo, healthData, memoryTrend, rebootInfo, apiStats, syncGroupInfo, errorGroups)}
            </div>
            <div class="ala-tab-content" data-content="timeline">
                ${buildTimelineHTML(mediaTimeline, mediaStats, minTime, maxTime)}
            </div>
            <div class="ala-tab-content" data-content="sync">
                ${buildSyncHTML(syncGroupInfo, syncData, syncEvents)}
            </div>
            <div class="ala-tab-content" data-content="downloads">
                ${buildDownloadsHTML(downloadStats, syncEvents)}
            </div>
        </div>
    `;

    // Inject styles
    if (!document.getElementById('ala-styles')) {
        const style = document.createElement('style');
        style.id = 'ala-styles';
        style.textContent = ALA_CSS;
        document.head.appendChild(style);
    }

    document.body.appendChild(overlay);

    // ─── Event Wiring ────────────────────────────────────────────────────
    const searchInput = overlay.querySelector('.ala-search');
    const timeFrom = overlay.querySelector('.ala-time-from');
    const timeTo = overlay.querySelector('.ala-time-to');

    // Pre-build search index
    const lineIndex = [];
    overlay.querySelectorAll('.ala-log-body .ala-line').forEach(el => {
        lineIndex.push({
            el,
            level: el.dataset.level || '',
            comp: el.dataset.comp || '',
            hm: el.dataset.hm || '',
            text: el.dataset.text || ''
        });
    });

    // Optimized filter
    let filterRAF = 0;
    let regexMode = false;
    function scheduleFilter() {
        cancelAnimationFrame(filterRAF);
        filterRAF = requestAnimationFrame(() => {
            const activeLevels = new Set(
                Array.from(overlay.querySelectorAll('.ala-level-chip.active')).map(b => b.dataset.level)
            );
            const activeComps = new Set(
                Array.from(overlay.querySelectorAll('.ala-comp-chip.active')).map(b => b.dataset.comp)
            );
            const term = searchInput.value.toLowerCase();
            const from = timeFrom.value;
            const to = timeTo.value;
            const useTime = !!(from || to);

            let searchRegex = null;
            if (term && regexMode) {
                try {
                    searchRegex = new RegExp(searchInput.value, 'gi');
                    searchInput.classList.remove('ala-search-error');
                } catch (e) {
                    searchInput.classList.add('ala-search-error');
                    return;
                }
            } else {
                searchInput.classList.remove('ala-search-error');
            }

            let visibleCount = 0;
            for (let i = 0; i < lineIndex.length; i++) {
                const { el, level, comp, hm, text } = lineIndex[i];
                let matchesSearch = true;
                if (term) {
                    if (regexMode && searchRegex) {
                        searchRegex.lastIndex = 0;
                        matchesSearch = searchRegex.test(text);
                    } else {
                        matchesSearch = text.includes(term);
                    }
                }
                const show = (!level || activeLevels.has(level))
                    && (!comp || activeComps.has(comp))
                    && matchesSearch
                    && (!useTime || !hm || (hm >= from && hm <= to));
                if (el.classList.contains('hidden') !== !show) {
                    el.classList.toggle('hidden', !show);
                }
                if (show) visibleCount++;

                // Highlight matches (F4)
                const msgSpan = el.querySelector('.ala-msg');
                if (msgSpan) {
                    const original = msgSpan.dataset.original || '';
                    if (term && show && original) {
                        let highlighted;
                        if (regexMode && searchRegex) {
                            searchRegex.lastIndex = 0;
                            highlighted = original.replace(searchRegex, m => `<mark class="ala-highlight">${m}</mark>`);
                        } else {
                            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            highlighted = original.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="ala-highlight">$1</mark>');
                        }
                        msgSpan.innerHTML = renderMessageWithJSON(highlighted);
                    } else if (original && msgSpan.querySelector('.ala-highlight')) {
                        msgSpan.innerHTML = renderMessageWithJSON(original);
                    }
                }
            }

            // Update visible count
            const countEl = overlay.querySelector('.ala-visible-count');
            if (countEl) countEl.textContent = `Mostrando ${visibleCount} de ${lineIndex.length}`;

            // Save filter state (F10)
            saveFilterState(overlay);
        });
    }

    // Close
    overlay.querySelector('.ala-close-btn').onclick = () => { analyzerDismissed = true; overlay.remove(); };
    overlay.querySelector('.ala-backdrop').onclick = () => { analyzerDismissed = true; overlay.remove(); };

    // Level & component chip filters
    overlay.querySelectorAll('.ala-level-chip, .ala-comp-chip').forEach(btn => {
        btn.onclick = () => { btn.classList.toggle('active'); scheduleFilter(); };
    });

    // Toggle all component chips
    const compToggle = overlay.querySelector('.ala-comp-toggle');
    compToggle.onclick = () => {
        const chips = overlay.querySelectorAll('.ala-comp-chip');
        const anyActive = Array.from(chips).some(c => c.classList.contains('active'));
        chips.forEach(c => c.classList.toggle('active', !anyActive));
        compToggle.textContent = anyActive ? 'Todos' : 'Ninguno';
        scheduleFilter();
    };

    // Time range filter
    timeFrom.oninput = scheduleFilter;
    timeTo.oninput = scheduleFilter;

    // Debounced search
    let searchTimer;
    searchInput.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(scheduleFilter, 180);
    };

    // Explain buttons
    overlay.querySelectorAll('.ala-explain-btn').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.idx);
            const context = lines.slice(Math.max(0, idx - 10), idx + 5).join('\n');
            explainLog(lines[idx], context, btn);
        };
    });

    // Summarize
    overlay.querySelector('.ala-summarize-btn').onclick = function () {
        summarizeLogs(overlay, this);
    };

    // ─── Regex Toggle (F3) ───────────────────────────────────────────────
    const regexToggleBtn = overlay.querySelector('.ala-regex-toggle');
    regexToggleBtn.onclick = () => {
        regexMode = !regexMode;
        regexToggleBtn.classList.toggle('active', regexMode);
        scheduleFilter();
    };

    // ─── Export (F1) ─────────────────────────────────────────────────────
    overlay.querySelector('.ala-export-btn').onclick = () => {
        const visible = Array.from(overlay.querySelectorAll('.ala-line:not(.hidden)'));
        const text = visible.map(l => l.dataset.raw || l.textContent).join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `log_export_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // ─── Copy Line (F5) ─────────────────────────────────────────────────
    overlay.querySelectorAll('.ala-line').forEach(line => {
        line.addEventListener('click', (e) => {
            if (e.target.closest('.ala-line-bookmark') || e.target.closest('.ala-explain-btn') || e.target.closest('.ala-json-toggle') || e.target.closest('.ala-json-content')) return;
            const raw = line.dataset.raw || line.textContent;
            navigator.clipboard.writeText(raw).then(() => {
                const toast = document.createElement('div');
                toast.className = 'ala-toast';
                toast.textContent = '✓ Copiado';
                line.style.position = 'relative';
                line.appendChild(toast);
                setTimeout(() => toast.remove(), 1500);
            });
        });
    });

    // ─── Dark Mode (F19) ────────────────────────────────────────────────
    const darkToggle = overlay.querySelector('.ala-dark-toggle');
    function applyDarkMode(dark) {
        overlay.querySelector('.ala-modal').classList.toggle('ala-dark', dark);
        darkToggle.innerHTML = dark ? '&#9788;' : '&#9789;';
        try { localStorage.setItem('logAnalyzer_darkMode', dark ? '1' : '0'); } catch (e) { }
        try { if (chrome?.storage?.local) chrome.storage.local.set({ logAnalyzerDarkMode: dark }); } catch (e) { }
    }
    try {
        const saved = localStorage.getItem('logAnalyzer_darkMode');
        if (saved === '1') applyDarkMode(true);
    } catch (e) { }
    darkToggle.onclick = () => {
        const isDark = overlay.querySelector('.ala-modal').classList.contains('ala-dark');
        applyDarkMode(!isDark);
    };

    // ─── Sync Button (F15) ──────────────────────────────────────────────
    const syncBtn = overlay.querySelector('.ala-sync-btn');
    syncBtn.onclick = () => {
        const syncPayload = {
            deviceInfo,
            healthData: healthData.length > 0 ? { lastCpu: healthData[healthData.length - 1].cpu, lastRam: healthData[healthData.length - 1].ram } : null,
            memoryTrend,
            apiStats,
            errorCount: parsed.filter(p => p.level === 'ERROR').length,
            warningCount: parsed.filter(p => p.level === 'WARNING').length,
            totalLines: parsed.length,
            timeRange: { from: minTime, to: maxTime },
            syncGroupInfo,
            timestamp: Date.now()
        };
        try {
            if (chrome?.runtime?.sendMessage) {
                chrome.runtime.sendMessage({ type: 'SYNC_LOG_DATA', payload: syncPayload }, () => {
                    syncBtn.innerHTML = '&#9989; Sincronizado';
                    syncBtn.classList.add('ala-synced');
                    setTimeout(() => { syncBtn.innerHTML = '&#128279; Sync'; syncBtn.classList.remove('ala-synced'); }, 3000);
                });
            }
        } catch (e) { console.error('Sync error:', e); }
    };

    // ─── JSON Toggle (F21) ──────────────────────────────────────────────
    overlay.addEventListener('click', (e) => {
        const toggle = e.target.closest('.ala-json-toggle');
        if (!toggle) return;
        e.stopPropagation();
        const content = toggle.nextElementSibling;
        if (content && content.classList.contains('ala-json-content')) {
            const isExpanded = content.style.display !== 'none';
            content.style.display = isExpanded ? 'none' : 'block';
            toggle.classList.toggle('ala-json-expanded', !isExpanded);
        }
    });

    // ─── Initial Count ──────────────────────────────────────────────────
    const initCount = overlay.querySelector('.ala-visible-count');
    if (initCount) initCount.textContent = `Mostrando ${lineIndex.length} de ${lineIndex.length}`;

    // ─── Restore Filter State (F10) ─────────────────────────────────────
    restoreFilterState(overlay, scheduleFilter);

    // ─── Tab Switching ───────────────────────────────────────────────────
    overlay.querySelectorAll('.ala-tab').forEach(tab => {
        tab.onclick = () => {
            overlay.querySelectorAll('.ala-tab').forEach(t => t.classList.remove('active'));
            overlay.querySelectorAll('.ala-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const target = overlay.querySelector(`.ala-tab-content[data-content="${tab.dataset.tab}"]`);
            if (target) target.classList.add('active');

            // Show/hide header controls based on tab
            const controls = overlay.querySelector('.ala-controls');
            const summary = overlay.querySelector('.ala-summary-container');
            const bookmarkNav = overlay.querySelector('.ala-bookmark-nav');
            if (tab.dataset.tab === 'logs') {
                controls.style.display = '';
                summary.style.display = '';
                bookmarkNav.style.display = '';
            } else {
                controls.style.display = 'none';
                summary.style.display = 'none';
                bookmarkNav.style.display = 'none';
            }
        };
    });

    // ─── Bookmarks ───────────────────────────────────────────────────────
    const bookmarkCountEl = overlay.querySelector('.ala-bookmark-count');

    function updateBookmarkCount() {
        bookmarkCountEl.textContent = bookmarks.size;
    }

    overlay.querySelectorAll('.ala-line-bookmark').forEach(bm => {
        bm.onclick = (e) => {
            e.stopPropagation();
            const line = bm.parentElement;
            const idx = line.dataset.idx;
            if (bookmarks.has(idx)) {
                bookmarks.delete(idx);
                line.classList.remove('ala-bookmarked');
            } else {
                bookmarks.add(idx);
                line.classList.add('ala-bookmarked');
            }
            updateBookmarkCount();
        };
    });

    // Bookmark navigation
    function getBookmarkedElements() {
        return Array.from(overlay.querySelectorAll('.ala-line.ala-bookmarked:not(.hidden)'));
    }

    overlay.querySelector('.ala-bookmark-next').onclick = () => {
        const els = getBookmarkedElements();
        if (!els.length) return;
        bookmarkCounter = (bookmarkCounter + 1) % els.length;
        els[bookmarkCounter].scrollIntoView({ behavior: 'smooth', block: 'center' });
        els[bookmarkCounter].classList.add('ala-flash');
        setTimeout(() => els[bookmarkCounter]?.classList.remove('ala-flash'), 800);
    };

    overlay.querySelector('.ala-bookmark-prev').onclick = () => {
        const els = getBookmarkedElements();
        if (!els.length) return;
        bookmarkCounter = (bookmarkCounter - 1 + els.length) % els.length;
        els[bookmarkCounter].scrollIntoView({ behavior: 'smooth', block: 'center' });
        els[bookmarkCounter].classList.add('ala-flash');
        setTimeout(() => els[bookmarkCounter]?.classList.remove('ala-flash'), 800);
    };

    // ─── Timeline Tooltips ───────────────────────────────────────────────
    overlay.querySelectorAll('.ala-tl-block').forEach(block => {
        block.onmouseenter = (e) => {
            const tooltip = overlay.querySelector('.ala-tl-tooltip');
            if (tooltip) {
                tooltip.textContent = block.dataset.tooltip;
                tooltip.style.display = 'block';
                tooltip.style.left = e.pageX + 'px';
                tooltip.style.top = (e.pageY - 40) + 'px';
            }
        };
        block.onmouseleave = () => {
            const tooltip = overlay.querySelector('.ala-tl-tooltip');
            if (tooltip) tooltip.style.display = 'none';
        };
    });
}

// ─── Analysis Functions ──────────────────────────────────────────────────────
function analyzeMemoryTrend(healthData) {
    if (healthData.length < 5) return { trend: 'insufficient', slope: 0, avgRam: 0, maxRam: 0, minRam: 0 };

    const rams = healthData.map(h => h.ram);
    const avgRam = rams.reduce((a, b) => a + b, 0) / rams.length;
    const maxRam = Math.max(...rams);
    const minRam = Math.min(...rams);

    // Linear regression on RAM values
    const n = rams.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += rams[i];
        sumXY += i * rams[i];
        sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // slope is MB per sample (~1 sample per minute)
    const slopePerHour = slope * 60;
    let trend = 'stable';
    if (slopePerHour > 2) trend = 'rising';
    else if (slopePerHour < -2) trend = 'falling';

    return { trend, slope: slopePerHour, avgRam: avgRam.toFixed(1), maxRam: maxRam.toFixed(1), minRam: minRam.toFixed(1) };
}

function analyzeReboots(rebootData, syncEvents) {
    const reboots = [];
    // Find when countdown reaches 0
    for (let i = 0; i < rebootData.length; i++) {
        if (rebootData[i].minutesLeft === 0) {
            reboots.push({ time: rebootData[i].time, type: 'scheduled' });
        }
    }
    // Find boot events from syncEvents
    syncEvents.forEach(e => {
        if (e.event === 'Device Boot') {
            reboots.push({ time: e.time, type: 'boot_detected' });
        }
    });

    // Reboot schedule
    let scheduledRebootTime = null;
    if (rebootData.length > 0) {
        const first = rebootData[0];
        // Calculate reboot time from first entry
        const [h, m] = first.time.split(':').map(Number);
        const rebootMin = h * 60 + m + first.minutesLeft;
        const rH = Math.floor(rebootMin / 60) % 24;
        const rM = rebootMin % 60;
        scheduledRebootTime = `${String(rH).padStart(2, '0')}:${String(rM).padStart(2, '0')}`;
    }

    return { reboots, scheduledRebootTime };
}

function buildMediaStats(mediaTimeline) {
    const playEvents = mediaTimeline.filter(m => m.type === 'play');
    const stats = {};

    for (let i = 0; i < playEvents.length; i++) {
        const name = playEvents[i].media;
        const startTime = timeToSeconds(playEvents[i].timeFull);
        const endTime = (i + 1 < playEvents.length) ? timeToSeconds(playEvents[i + 1].timeFull) : startTime + 10;
        const duration = Math.max(0, endTime - startTime);

        if (!stats[name]) stats[name] = { count: 0, totalDuration: 0 };
        stats[name].count++;
        stats[name].totalDuration += duration;
    }

    return Object.entries(stats).map(([name, s]) => ({
        name,
        count: s.count,
        totalDuration: s.totalDuration,
        avgDuration: s.count > 0 ? s.totalDuration / s.count : 0
    })).sort((a, b) => b.totalDuration - a.totalDuration);
}

function buildApiStats(apiHealth) {
    const stats = {};
    apiHealth.forEach(a => {
        if (!stats[a.api]) stats[a.api] = { total: 0, success: 0, fail: 0, lastStatus: null, lastTime: '', errors: [] };
        stats[a.api].total++;
        if (a.success) stats[a.api].success++;
        else {
            stats[a.api].fail++;
            if (a.error) stats[a.api].errors.push(a.error);
        }
        stats[a.api].lastStatus = a.success;
        stats[a.api].lastTime = a.timeFull;
    });
    return stats;
}

// ─── HTML Builders ───────────────────────────────────────────────────────────
function buildDashboardHTML(deviceInfo, healthData, memoryTrend, rebootInfo, apiStats, syncGroupInfo, errorGroups) {
    const di = deviceInfo;

    // Device info card
    const deviceCard = `
        <div class="ala-dash-card ala-dash-device">
            <div class="ala-dash-card-title">Informacion del Dispositivo</div>
            <div class="ala-dash-grid">
                ${di.platform ? `<div class="ala-dash-item"><span class="ala-dash-label">Platform</span><span class="ala-dash-value">${escapeHtml(di.platform)}</span></div>` : ''}
                ${di.playerVersion ? `<div class="ala-dash-item"><span class="ala-dash-label">Player Version</span><span class="ala-dash-value">${escapeHtml(di.playerVersion)}</span></div>` : ''}
                ${di.firmwareVersion ? `<div class="ala-dash-item"><span class="ala-dash-label">Firmware</span><span class="ala-dash-value">${escapeHtml(di.firmwareVersion)}</span></div>` : ''}
                ${di.playerId ? `<div class="ala-dash-item"><span class="ala-dash-label">Player ID</span><span class="ala-dash-value">${di.playerId}</span></div>` : ''}
                ${di.storeId ? `<div class="ala-dash-item"><span class="ala-dash-label">Store ID</span><span class="ala-dash-value">${di.storeId}</span></div>` : ''}
                ${di.customerId ? `<div class="ala-dash-item"><span class="ala-dash-label">Customer ID</span><span class="ala-dash-value">${di.customerId}</span></div>` : ''}
                ${di.displayType ? `<div class="ala-dash-item"><span class="ala-dash-label">Display Type</span><span class="ala-dash-value">${escapeHtml(di.displayType)}</span></div>` : ''}
                ${di.server ? `<div class="ala-dash-item"><span class="ala-dash-label">Server</span><span class="ala-dash-value">${escapeHtml(di.server)}</span></div>` : ''}
                ${di.tags ? `<div class="ala-dash-item ala-dash-item-full"><span class="ala-dash-label">Tags</span><span class="ala-dash-value">${di.tags.map(t => `<span class="ala-tag">${escapeHtml(t)}</span>`).join(' ')}</span></div>` : ''}
                ${di.userAgent ? `<div class="ala-dash-item ala-dash-item-full"><span class="ala-dash-label">User Agent</span><span class="ala-dash-value ala-dash-ua">${escapeHtml(di.userAgent)}</span></div>` : ''}
            </div>
            ${syncGroupInfo ? `
                <div class="ala-dash-card-title" style="margin-top:12px">Grupo de Sincronizacion</div>
                <div class="ala-dash-grid">
                    ${syncGroupInfo.group ? `<div class="ala-dash-item ala-dash-item-full"><span class="ala-dash-label">Grupo</span><span class="ala-dash-value">${escapeHtml(syncGroupInfo.group)}</span></div>` : ''}
                    ${syncGroupInfo.version ? `<div class="ala-dash-item"><span class="ala-dash-label">Sync Version</span><span class="ala-dash-value">${escapeHtml(syncGroupInfo.version)}</span></div>` : ''}
                    ${syncGroupInfo.members ? `<div class="ala-dash-item ala-dash-item-full"><span class="ala-dash-label">Miembros</span><span class="ala-dash-value">${syncGroupInfo.members.map(m =>
        `<span class="ala-member ${m.role === 'Master' ? 'ala-member-master' : 'ala-member-slave'}">${m.ip} <small>${m.role}</small></span>`
    ).join(' ')}</span></div>` : ''}
                </div>
            ` : ''}
        </div>
    `;

    // Memory trend alert
    const trendIcon = memoryTrend.trend === 'rising' ? '&#9650;' : memoryTrend.trend === 'falling' ? '&#9660;' : '&#9679;';
    const trendClass = memoryTrend.trend === 'rising' ? 'ala-alert-danger' : memoryTrend.trend === 'falling' ? 'ala-alert-ok' : 'ala-alert-neutral';
    const trendText = memoryTrend.trend === 'rising'
        ? `RAM creciente: +${memoryTrend.slope.toFixed(1)} MB/hora. Posible memory leak.`
        : memoryTrend.trend === 'falling'
            ? `RAM descendente: ${memoryTrend.slope.toFixed(1)} MB/hora. Comportamiento normal.`
            : memoryTrend.trend === 'insufficient'
                ? 'Datos insuficientes para analizar tendencia de RAM.'
                : `RAM estable (${memoryTrend.slope.toFixed(1)} MB/hora).`;

    const alertsCard = `
        <div class="ala-dash-card">
            <div class="ala-dash-card-title">Alertas</div>
            <div class="ala-alert ${trendClass}">
                <span class="ala-alert-icon">${trendIcon}</span>
                <div>
                    <strong>Tendencia de Memoria</strong>
                    <div>${trendText}</div>
                    ${memoryTrend.trend !== 'insufficient' ? `<small>Promedio: ${memoryTrend.avgRam} MB | Min: ${memoryTrend.minRam} MB | Max: ${memoryTrend.maxRam} MB</small>` : ''}
                </div>
            </div>
            <div class="ala-alert ${rebootInfo.reboots.length > 0 ? 'ala-alert-warn' : 'ala-alert-neutral'}">
                <span class="ala-alert-icon">&#8634;</span>
                <div>
                    <strong>Reboot</strong>
                    <div>${rebootInfo.scheduledRebootTime ? `Reboot programado: ${rebootInfo.scheduledRebootTime}` : 'Sin datos de reboot'}</div>
                    ${rebootInfo.reboots.length > 0 ? `<small>${rebootInfo.reboots.length} reinicio(s) detectado(s) en este log</small>` : ''}
                </div>
            </div>
        </div>
    `;

    // CPU/RAM Chart
    const chartCard = healthData.length > 0 ? `
        <div class="ala-dash-card ala-dash-chart-card">
            <div class="ala-dash-card-title">CPU &amp; RAM</div>
            <div class="ala-chart-container">
                <div class="ala-chart-legend">
                    <span class="ala-legend-cpu">&#9632; CPU (%)</span>
                    <span class="ala-legend-ram">&#9632; RAM (MB)</span>
                </div>
                <div class="ala-chart">
                    <div class="ala-chart-y-axis">
                        <span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span>
                    </div>
                    <div class="ala-chart-area">
                        ${buildChartBars(healthData)}
                    </div>
                </div>
                <div class="ala-chart-x-labels">
                    ${buildChartXLabels(healthData)}
                </div>
            </div>
        </div>
    ` : '';

    // API Health Cards
    const apiCards = Object.keys(apiStats).length > 0 ? `
        <div class="ala-dash-card">
            <div class="ala-dash-card-title">Estado de APIs</div>
            <div class="ala-api-grid">
                ${Object.entries(apiStats).map(([name, s]) => {
        const rate = s.total > 0 ? ((s.success / s.total) * 100).toFixed(0) : 0;
        const status = s.fail === 0 ? 'ok' : (rate >= 80 ? 'warn' : 'danger');
        return `
                        <div class="ala-api-card ala-api-${status}">
                            <div class="ala-api-name">${escapeHtml(name)}</div>
                            <div class="ala-api-rate">${rate}%</div>
                            <div class="ala-api-detail">${s.success}/${s.total} exitosos</div>
                            ${s.errors.length > 0 ? `<div class="ala-api-error">${escapeHtml(s.errors[s.errors.length - 1])}</div>` : ''}
                        </div>
                    `;
    }).join('')}
            </div>
        </div>
    ` : '';

    const errorGroupCard = buildErrorGroupHTML(errorGroups);
    return `<div class="ala-dashboard">${deviceCard}${alertsCard}${chartCard}${apiCards}${errorGroupCard}</div>`;
}

function buildChartBars(healthData) {
    // Sample to max 200 points for performance
    const data = healthData.length > 200
        ? healthData.filter((_, i) => i % Math.ceil(healthData.length / 200) === 0)
        : healthData;
    const maxRam = Math.max(...healthData.map(h => h.ram), 1);

    return data.map((h) => {
        const cpuH = h.cpu;
        const ramH = (h.ram / maxRam) * 100;
        const w = Math.max(100 / data.length, 2);
        return `<div class="ala-chart-bar-group" style="width:${w}%" title="${h.time} - CPU: ${h.cpu}% | RAM: ${h.ram} MB">` +
            `<div class="ala-chart-bar ala-bar-cpu" style="height:${cpuH}%"></div>` +
            `<div class="ala-chart-bar ala-bar-ram" style="height:${ramH}%"></div>` +
            `</div>`;
    }).join('');
}

function buildChartXLabels(healthData) {
    if (healthData.length === 0) return '';
    const step = Math.max(1, Math.floor(healthData.length / 8));
    let labels = '';
    for (let i = 0; i < healthData.length; i += step) {
        labels += `<span>${healthData[i].time}</span>`;
    }
    return labels;
}

function buildTimelineHTML(mediaTimeline, mediaStats, minTime, maxTime) {
    const playEvents = mediaTimeline.filter(m => m.type === 'play');
    if (playEvents.length === 0) return '<div class="ala-empty-tab">No se detectaron eventos de reproduccion de media.</div>';

    const minSec = timeToSeconds(minTime + ':00');
    const maxSec = timeToSeconds(maxTime + ':59');
    const totalSpan = Math.max(maxSec - minSec, 1);

    // Assign colors to media names
    const colorMap = {};
    const uniqueMedia = [...new Set(playEvents.map(p => p.media))];
    uniqueMedia.forEach((name, i) => {
        const hue = (i * 137.5) % 360;
        colorMap[name] = `hsl(${hue}, 65%, 55%)`;
    });

    // Build timeline blocks
    let blocks = '';
    for (let i = 0; i < playEvents.length; i++) {
        const startSec = timeToSeconds(playEvents[i].timeFull);
        const endSec = (i + 1 < playEvents.length) ? timeToSeconds(playEvents[i + 1].timeFull) : startSec + 10;
        const left = ((startSec - minSec) / totalSpan) * 100;
        const width = Math.max(((endSec - startSec) / totalSpan) * 100, 0.2);
        const dur = formatDuration(endSec - startSec);
        const color = colorMap[playEvents[i].media];
        const isTemplate = playEvents[i].media.includes('MenuBoard') || playEvents[i].media.includes('Template');

        blocks += `<div class="ala-tl-block ${isTemplate ? 'ala-tl-template' : ''}" ` +
            `style="left:${left}%;width:${width}%;background:${color}" ` +
            `data-tooltip="${escapeHtml(playEvents[i].media)} | ${playEvents[i].time} | ${dur}"></div>`;
    }

    // Legend
    const legend = uniqueMedia.map(name =>
        `<span class="ala-tl-legend-item"><span class="ala-tl-legend-color" style="background:${colorMap[name]}"></span>${escapeHtml(name)}</span>`
    ).join('');

    // Stats table
    const statsRows = mediaStats.map(s =>
        `<tr>
            <td><span class="ala-tl-legend-color" style="background:${colorMap[s.name] || '#888'}"></span>${escapeHtml(s.name)}</td>
            <td>${s.count}</td>
            <td>${formatDuration(s.totalDuration)}</td>
            <td>${formatDuration(s.avgDuration)}</td>
        </tr>`
    ).join('');

    return `
        <div class="ala-timeline">
            <div class="ala-tl-tooltip" style="display:none"></div>
            <div class="ala-dash-card">
                <div class="ala-dash-card-title">Timeline de Contenido</div>
                <div class="ala-tl-time-axis">
                    <span>${minTime}</span><span>${maxTime}</span>
                </div>
                <div class="ala-tl-track">
                    ${blocks}
                </div>
                <div class="ala-tl-legend">${legend}</div>
            </div>
            <div class="ala-dash-card">
                <div class="ala-dash-card-title">Resumen de Contenido</div>
                <table class="ala-tl-table">
                    <thead><tr><th>Media</th><th>Reproducciones</th><th>Duracion Total</th><th>Duracion Promedio</th></tr></thead>
                    <tbody>${statsRows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function buildSyncHTML(syncGroupInfo, syncData, syncEvents) {
    if (!syncGroupInfo && syncData.length === 0) {
        return '<div class="ala-empty-tab">No se detectaron datos de sincronizacion en este log.</div>';
    }

    // Group info
    const groupCard = syncGroupInfo ? `
        <div class="ala-dash-card">
            <div class="ala-dash-card-title">Grupo de Sincronizacion</div>
            <div class="ala-sync-group">
                ${syncGroupInfo.group ? `<div class="ala-sync-info"><span class="ala-dash-label">Grupo</span><span>${escapeHtml(syncGroupInfo.group)}</span></div>` : ''}
                ${syncGroupInfo.version ? `<div class="ala-sync-info"><span class="ala-dash-label">Version</span><span>${escapeHtml(syncGroupInfo.version)}</span></div>` : ''}
                ${syncGroupInfo.members ? `
                    <div class="ala-sync-members">
                        ${syncGroupInfo.members.map(m => `
                            <div class="ala-sync-member ${m.role === 'Master' ? 'ala-sync-master' : 'ala-sync-slave'}">
                                <div class="ala-sync-member-icon">${m.role === 'Master' ? '&#9733;' : '&#9679;'}</div>
                                <div class="ala-sync-member-ip">${m.ip}</div>
                                <div class="ala-sync-member-role">${m.role}</div>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
        </div>
    ` : '';

    // Drift chart
    let driftChart = '';
    if (syncData.length > 0) {
        const maxDrift = Math.max(...syncData.map(s => s.drift), 5);
        const avgDrift = syncData.reduce((a, b) => a + b.drift, 0) / syncData.length;
        const driftStatus = avgDrift <= 1 ? 'ok' : avgDrift <= 3 ? 'warn' : 'danger';

        const driftData = syncData.length > 200
            ? syncData.filter((_, i) => i % Math.ceil(syncData.length / 200) === 0)
            : syncData;

        const driftBars = driftData.map(s => {
            const h = Math.max((s.drift / maxDrift) * 100, 2);
            const barClass = s.drift <= 1 ? 'ala-drift-ok' : s.drift <= 3 ? 'ala-drift-warn' : 'ala-drift-danger';
            const w = Math.max(100 / driftData.length, 2);
            return `<div class="ala-chart-bar-group" style="width:${w}%" title="${s.time} - Drift: ${s.drift}">` +
                `<div class="ala-chart-bar ${barClass}" style="height:${h}%"></div></div>`;
        }).join('');

        const driftXLabels = buildChartXLabelsFromSync(driftData);

        driftChart = `
            <div class="ala-dash-card ala-dash-chart-card">
                <div class="ala-dash-card-title">
                    Sync Drift (Now - Received)
                    <span class="ala-drift-badge ala-drift-badge-${driftStatus}">${avgDrift.toFixed(1)} avg</span>
                </div>
                <div class="ala-chart-container">
                    <div class="ala-chart">
                        <div class="ala-chart-y-axis">
                            <span>${maxDrift}</span><span>${Math.round(maxDrift * 0.75)}</span><span>${Math.round(maxDrift * 0.5)}</span><span>${Math.round(maxDrift * 0.25)}</span><span>0</span>
                        </div>
                        <div class="ala-chart-area">${driftBars}</div>
                    </div>
                    <div class="ala-chart-x-labels">${driftXLabels}</div>
                </div>
            </div>
        `;
    }

    // Sync events table
    let eventsTable = '';
    if (syncEvents.length > 0) {
        const rows = syncEvents.map(e => {
            const eClass = e.event === 'Network Error' || e.event === 'Integrity Fail' ? 'ala-sync-evt-error'
                : e.event === 'Disconnected' ? 'ala-sync-evt-warn'
                    : e.event === 'Device Boot' ? 'ala-sync-evt-boot'
                        : 'ala-sync-evt-ok';
            return `<tr class="${eClass}"><td>${e.time}</td><td>${escapeHtml(e.event)}</td><td>${escapeHtml(e.detail)}</td></tr>`;
        }).join('');

        eventsTable = `
            <div class="ala-dash-card">
                <div class="ala-dash-card-title">Eventos de Sync / Red</div>
                <div class="ala-sync-events-container">
                    <table class="ala-tl-table">
                        <thead><tr><th>Hora</th><th>Evento</th><th>Detalle</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    return `<div class="ala-sync-tab">${groupCard}${driftChart}${eventsTable}</div>`;
}

function buildChartXLabelsFromSync(data) {
    if (data.length === 0) return '';
    const step = Math.max(1, Math.floor(data.length / 8));
    let labels = '';
    for (let i = 0; i < data.length; i += step) {
        labels += `<span>${data[i].time}</span>`;
    }
    return labels;
}

// ─── New Builder Functions ────────────────────────────────────────────────────
function buildErrorGroups(parsed) {
    const groups = {};
    parsed.forEach(p => {
        if (p.level === 'ERROR' || p.level === 'WARNING') {
            const key = (p.message || '').replace(/\d{4}-\d{2}-\d{2}/g, 'DATE').replace(/\d{2}:\d{2}:\d{2}/g, 'TIME').replace(/\d+\.\d+\.\d+\.\d+/g, 'IP').substring(0, 120);
            if (!groups[key]) groups[key] = { message: p.message, level: p.level, comp: p.comp, count: 0, firstTime: p.hm, lastTime: p.hm };
            groups[key].count++;
            groups[key].lastTime = p.hm;
        }
    });
    return Object.values(groups).filter(g => g.count > 1).sort((a, b) => b.count - a.count);
}

function buildErrorGroupHTML(errorGroups) {
    if (!errorGroups || errorGroups.length === 0) return '';
    const rows = errorGroups.slice(0, 20).map(g => {
        const levelClass = g.level === 'ERROR' ? 'ala-err-grp-error' : 'ala-err-grp-warn';
        return `<tr class="${levelClass}"><td>${g.count}</td><td>${escapeHtml(g.comp)}</td><td title="${escapeHtml(g.message)}">${escapeHtml(g.message.substring(0, 100))}${g.message.length > 100 ? '...' : ''}</td><td>${g.firstTime}</td><td>${g.lastTime}</td></tr>`;
    }).join('');
    return `
        <div class="ala-dash-card">
            <div class="ala-dash-card-title">Errores Frecuentes</div>
            <div class="ala-sync-events-container">
                <table class="ala-tl-table">
                    <thead><tr><th>#</th><th>Componente</th><th>Mensaje</th><th>Primer</th><th>\xDAltimo</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function buildDownloadStats(downloadData, syncEvents) {
    const stats = { downloading: 0, idle: 0, complete: 0, error: 0, events: downloadData };
    downloadData.forEach(d => { if (stats[d.type] !== undefined) stats[d.type]++; });
    const integrityFails = syncEvents.filter(e => e.event === 'Integrity Fail');
    stats.integrityFails = integrityFails;
    return stats;
}

function buildDownloadsHTML(stats, syncEvents) {
    if (!stats || stats.events.length === 0) {
        const intFails = syncEvents.filter(e => e.event === 'Integrity Fail');
        if (intFails.length === 0) return '<div class="ala-empty-tab">No se detectaron eventos de descarga en este log.</div>';
    }

    const cards = `
        <div class="ala-api-grid">
            <div class="ala-api-card ala-api-ok"><div class="ala-api-name">Completadas</div><div class="ala-api-rate">${stats.complete}</div></div>
            <div class="ala-api-card ${stats.error > 0 ? 'ala-api-danger' : 'ala-api-ok'}"><div class="ala-api-name">Errores</div><div class="ala-api-rate">${stats.error}</div></div>
            <div class="ala-api-card ala-api-warn"><div class="ala-api-name">En Descarga</div><div class="ala-api-rate">${stats.downloading}</div></div>
            <div class="ala-api-card ${stats.integrityFails.length > 0 ? 'ala-api-danger' : 'ala-api-ok'}"><div class="ala-api-name">Integridad Fallida</div><div class="ala-api-rate">${stats.integrityFails.length}</div></div>
        </div>
    `;

    const eventRows = stats.events.slice(-50).reverse().map(d => {
        const cls = d.type === 'error' ? 'ala-sync-evt-error' : d.type === 'complete' ? 'ala-sync-evt-ok' : '';
        return `<tr class="${cls}"><td>${d.time}</td><td>${escapeHtml(d.type)}</td><td>${escapeHtml(d.message.substring(0, 120))}</td></tr>`;
    }).join('');

    const intRows = stats.integrityFails.map(f =>
        `<tr class="ala-sync-evt-error"><td>${f.time}</td><td>${escapeHtml(f.detail)}</td></tr>`
    ).join('');

    return `
        <div class="ala-sync-tab">
            <div class="ala-dash-card">
                <div class="ala-dash-card-title">Estado de Descargas</div>
                ${cards}
            </div>
            ${eventRows ? `
            <div class="ala-dash-card">
                <div class="ala-dash-card-title">Eventos de Descarga (\xDAltimos 50)</div>
                <div class="ala-sync-events-container">
                    <table class="ala-tl-table">
                        <thead><tr><th>Hora</th><th>Tipo</th><th>Detalle</th></tr></thead>
                        <tbody>${eventRows}</tbody>
                    </table>
                </div>
            </div>` : ''}
            ${intRows ? `
            <div class="ala-dash-card">
                <div class="ala-dash-card-title">Problemas de Integridad</div>
                <div class="ala-sync-events-container">
                    <table class="ala-tl-table">
                        <thead><tr><th>Hora</th><th>Detalle</th></tr></thead>
                        <tbody>${intRows}</tbody>
                    </table>
                </div>
            </div>` : ''}
        </div>
    `;
}

function renderMessageWithJSON(msgHtml) {
    return msgHtml.replace(/\{(?:[^{}]|\{[^{}]*\}){15,}\}/g, (match) => {
        try {
            const unescaped = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
            const parsed = JSON.parse(unescaped);
            const formatted = JSON.stringify(parsed, null, 2);
            return `<span class="ala-json-toggle" title="Click para ver JSON">{\u2026}</span><pre class="ala-json-content" style="display:none">${escapeHtml(formatted)}</pre>`;
        } catch (e) { return match; }
    });
}

function saveFilterState(overlay) {
    try {
        const levels = Array.from(overlay.querySelectorAll('.ala-level-chip')).map(b => ({ level: b.dataset.level, active: b.classList.contains('active') }));
        const comps = Array.from(overlay.querySelectorAll('.ala-comp-chip')).map(b => ({ comp: b.dataset.comp, active: b.classList.contains('active') }));
        const search = overlay.querySelector('.ala-search')?.value || '';
        const from = overlay.querySelector('.ala-time-from')?.value || '';
        const to = overlay.querySelector('.ala-time-to')?.value || '';
        localStorage.setItem('logAnalyzer_filterState', JSON.stringify({ levels, comps, search, from, to }));
    } catch (e) { }
}

function restoreFilterState(overlay, scheduleFilter) {
    try {
        const saved = localStorage.getItem('logAnalyzer_filterState');
        if (!saved) return;
        const state = JSON.parse(saved);
        if (state.levels) {
            state.levels.forEach(s => {
                const chip = overlay.querySelector(`.ala-level-chip[data-level="${s.level}"]`);
                if (chip) chip.classList.toggle('active', s.active);
            });
        }
        if (state.comps) {
            state.comps.forEach(s => {
                const chip = overlay.querySelector(`.ala-comp-chip[data-comp="${s.comp}"]`);
                if (chip) chip.classList.toggle('active', s.active);
            });
        }
        if (state.search) { const si = overlay.querySelector('.ala-search'); if (si) si.value = state.search; }
        if (state.from) { const tf = overlay.querySelector('.ala-time-from'); if (tf) tf.value = state.from; }
        if (state.to) { const tt = overlay.querySelector('.ala-time-to'); if (tt) tt.value = state.to; }
        scheduleFilter();
    } catch (e) { }
}

// ─── Gemini API ──────────────────────────────────────────────────────────────
async function callGemini(prompt) {
    return new Promise((resolve, reject) => {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
            return reject(new Error("No API Key"));
        }
        chrome.storage.local.get(['geminiApiKey'], async (result) => {
            const key = result.geminiApiKey;
            if (!key) return reject(new Error("No API Key"));
            try {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        systemInstruction: {
                            parts: [{ text: "Eres un ingeniero experto en análisis de logs. Manual técnico:\n\n" + contextFileText }]
                        }
                    })
                });
                const data = await response.json();
                if (!response.ok) {
                    const msg = data?.error?.message || `HTTP ${response.status}`;
                    throw new Error(msg);
                }
                if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    const reason = data.candidates?.[0]?.finishReason || 'empty response';
                    throw new Error(`Gemini: ${reason}`);
                }
                resolve(data.candidates[0].content.parts[0].text);
            } catch (err) { reject(err); }
        });
    });
}

async function explainLog(targetLine, contextFrame, btn) {
    btn.innerHTML = '&#9203; Pensando...';
    btn.disabled = true;
    const prompt = `Explicame brevemente qué significa este error y sus posibles causas. Sé conciso.\n\nLínea:\n${targetLine}\n\nContexto:\n${contextFrame}`;
    try {
        const result = await callGemini(prompt);
        const box = document.createElement('div');
        box.className = 'ala-explanation';
        box.innerHTML = '<strong>&#10024; AI Insight:</strong><br/>' + formatMarkdown(result);
        btn.parentElement.after(box);
        btn.innerHTML = '&#9989; Explicado';
    } catch (e) {
        if (e.message === "No API Key") {
            alert("No hay API Key configurada.\n\nHaz clic en el icono de la extension para configurarla.");
            btn.innerHTML = '&#10024; Explicar';
        } else {
            console.error('Log Analyzer AI error:', e);
            btn.innerHTML = '&#10060; Error';
            btn.title = e.message;
        }
        btn.disabled = false;
    }
}

async function summarizeLogs(overlay, btn) {
    btn.innerHTML = '&#9203; Resumiendo...';
    const visible = Array.from(overlay.querySelectorAll('.ala-line:not(.hidden)'));
    const critical = visible.filter(l => l.dataset.level === 'ERROR' || l.dataset.level === 'WARNING').map(l => l.textContent);
    const start = visible.slice(0, 50).map(l => l.textContent);
    const end = visible.slice(-50).map(l => l.textContent);
    const sample = [...start, ...critical, "--- TRIMMED ---", ...end].join('\n');
    const prompt = `Haz un resumen analítico de esta sesión de logs. Destaca problemas principales, anomalías de memoria, o bucles fallidos.\n\nLogs:\n${sample}`;

    try {
        const result = await callGemini(prompt);
        const container = overlay.querySelector('.ala-summary-container');
        container.innerHTML = `
            <div class="ala-summary">
                <div class="ala-summary-header">
                    <strong>Resumen de Logs:</strong>
                    <div>
                        <button class="ala-copy-btn">&#128203; Copiar</button>
                        <button class="ala-close-summary">&#10006; Cerrar</button>
                    </div>
                </div>
                <div class="ala-summary-body">${formatMarkdown(result)}</div>
            </div>
        `;
        container.querySelector('.ala-copy-btn').onclick = (e) => {
            navigator.clipboard.writeText(result);
            e.target.innerHTML = '&#9989; Copiado';
            setTimeout(() => e.target.innerHTML = '&#128203; Copiar', 2000);
        };
        container.querySelector('.ala-close-summary').onclick = () => { container.innerHTML = ''; };
        btn.innerHTML = '&#9989; Resumido';
        setTimeout(() => { btn.innerHTML = 'Resumir Logs'; }, 4000);
    } catch (e) {
        if (e.message === "No API Key") {
            alert("No hay API Key configurada.\n\nHaz clic en el icono de la extension para configurarla.");
        } else {
            console.error('Log Analyzer AI error:', e);
            btn.title = e.message;
        }
        btn.innerHTML = 'Resumir Logs';
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatMarkdown(text) {
    let f = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    f = f.replace(/\*(.*?)\*/g, '<em>$1</em>');
    f = f.replace(/\n/g, '<br/>');
    return f;
}

function timeToSeconds(timeStr) {
    const parts = timeStr.split(':');
    const h = parseInt(parts[0]) || 0;
    const m = parseInt(parts[1]) || 0;
    const s = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
}

function formatDuration(seconds) {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
const ALA_CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');

#ai-log-analyzer-overlay {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Inter', sans-serif;
}

.ala-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(2px);
}

.ala-modal {
    position: relative;
    width: 92vw;
    height: 90vh;
    max-width: 1500px;
    background: #fff;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    overflow: hidden;
}

/* ─── Header ────────────────────────────────────────────────────────────── */
.ala-header {
    padding: 16px 20px 12px;
    background: #fafafa;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
}

.ala-title-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
}

.ala-title {
    font-size: 16px;
    color: #222;
    white-space: nowrap;
}

.ala-search {
    flex: 1;
    padding: 7px 14px;
    border: 1px solid #c0c0c0;
    border-radius: 6px;
    font-size: 13px;
    font-family: 'Inter', sans-serif;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
}
.ala-search:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
}

.ala-bookmark-nav {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
}
.ala-bookmark-count {
    background: #eef2ff;
    color: #4f46e5;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 11px;
    min-width: 20px;
    text-align: center;
}
.ala-bookmark-prev, .ala-bookmark-next {
    background: none;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    width: 24px;
    height: 24px;
    font-size: 10px;
    cursor: pointer;
    color: #666;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.ala-bookmark-prev:hover, .ala-bookmark-next:hover {
    background: #eef2ff;
    border-color: #c7d2fe;
}

.ala-close-btn {
    background: none;
    border: 1px solid #d0d0d0;
    width: 34px;
    height: 34px;
    border-radius: 6px;
    font-size: 16px;
    cursor: pointer;
    color: #666;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.ala-close-btn:hover {
    background: #fee2e2;
    border-color: #fca5a5;
    color: #dc2626;
}

.ala-controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ala-filter-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.ala-levels {
    display: flex;
    gap: 6px;
    padding-right: 12px;
    border-right: 1px solid #e0e0e0;
}

.ala-time-range {
    display: flex;
    align-items: center;
    gap: 6px;
}

.ala-time-label {
    font-size: 12px;
    font-weight: 500;
    color: #555;
}

.ala-time-input {
    padding: 3px 6px;
    border: 1px solid #c0c0c0;
    border-radius: 5px;
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    color: #333;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
}
.ala-time-input:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 2px rgba(37,99,235,0.12);
}

.ala-time-sep {
    color: #999;
    font-size: 13px;
}

.ala-components {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.ala-chip {
    background: #f5f5f5;
    border: 1px solid #e0e0e0;
    color: #777;
    padding: 4px 12px;
    border-radius: 16px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
    font-family: 'Inter', sans-serif;
}
.ala-chip:hover { background: #eee; }

.ala-comp-toggle {
    background: #fff;
    border-style: dashed;
    font-weight: 500;
    color: #555;
}
.ala-comp-toggle:hover { background: #f0f0f4; }

.ala-chip.active {
    background: #eef2ff;
    border-color: #c7d2fe;
    color: #4f46e5;
    font-weight: 500;
}

.ala-level-chip[data-level="ERROR"].active   { color: #d32f2f; background: #ffebee; border-color: #ffcdd2; }
.ala-level-chip[data-level="WARNING"].active { color: #f57c00; background: #fff3e0; border-color: #ffe0b2; }
.ala-level-chip[data-level="INFO"].active    { color: #1976d2; background: #e3f2fd; border-color: #bbdefb; }
.ala-level-chip[data-level="DEBUG"].active   { color: #616161; background: #f5f5f5; border-color: #e0e0e0; }
.ala-level-chip[data-level="SUCCESS"].active { color: #2e7d32; background: #e8f5e9; border-color: #c8e6c9; }

.ala-actions-row {
    display: flex;
    gap: 8px;
}

.ala-summarize-btn {
    align-self: flex-start;
    background: #2563eb;
    border: none;
    color: #fff;
    padding: 6px 18px;
    border-radius: 6px;
    font-weight: 500;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.2s;
    font-family: 'Inter', sans-serif;
    white-space: nowrap;
}
.ala-summarize-btn:hover { background: #1d4ed8; }

/* ─── Tabs ──────────────────────────────────────────────────────────────── */
.ala-tab-bar {
    display: flex;
    gap: 0;
    background: #fafafa;
    border-bottom: 1px solid #e0e0e0;
    padding: 0 20px;
    flex-shrink: 0;
}

.ala-tab {
    padding: 8px 20px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #888;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    transition: all 0.15s;
}
.ala-tab:hover { color: #555; background: #f0f0f4; }
.ala-tab.active {
    color: #2563eb;
    border-bottom-color: #2563eb;
}

.ala-tab-content {
    display: none;
    flex: 1;
    overflow: hidden;
    min-height: 0;
}
.ala-tab-content.active {
    display: flex;
    flex-direction: column;
}

/* ─── Summary ───────────────────────────────────────────────────────────── */
.ala-summary-container { flex-shrink: 0; }

.ala-summary {
    margin: 12px 20px;
    padding: 16px 20px;
    background: #f8fbff;
    border: 1px solid #d0e3ff;
    border-radius: 8px;
    font-size: 14px;
    line-height: 1.6;
    max-height: 30vh;
    overflow-y: auto;
}

.ala-summary-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
}

.ala-summary-header div { display: flex; gap: 8px; }

.ala-copy-btn, .ala-close-summary {
    background: #2563eb;
    border: none;
    color: #fff;
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
}
.ala-close-summary { background: #d32f2f; }
.ala-copy-btn:hover { background: #1d4ed8; }
.ala-close-summary:hover { background: #b71c1c; }

.ala-summary-body { word-break: break-word; }

/* ─── Log Body ──────────────────────────────────────────────────────────── */
.ala-log-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: auto;
    padding: 10px 20px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    line-height: 1.5;
    background: #fafafa;
}

.ala-log-body::-webkit-scrollbar { width: 8px; height: 8px; }
.ala-log-body::-webkit-scrollbar-track { background: #f1f1f1; }
.ala-log-body::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 4px; }

.ala-line {
    padding: 2px 0 2px 24px;
    white-space: nowrap;
    border-bottom: 1px solid transparent;
    transition: background 0.1s;
    position: relative;
}
.ala-line:hover { background: #f0f0f4; }
.ala-line.hidden { display: none; }

.ala-line-bookmark {
    position: absolute;
    left: 2px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    cursor: pointer;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    opacity: 0;
    transition: opacity 0.15s;
}
.ala-line:hover .ala-line-bookmark { opacity: 0.5; }
.ala-line-bookmark::before { content: '\\25C6'; color: #999; }
.ala-line:hover .ala-line-bookmark::before { color: #4f46e5; }

.ala-line.ala-bookmarked {
    background: #fefce8 !important;
    border-bottom-color: #fef08a;
}
.ala-line.ala-bookmarked .ala-line-bookmark {
    opacity: 1 !important;
}
.ala-line.ala-bookmarked .ala-line-bookmark::before {
    content: '\\25C6';
    color: #ca8a04;
}

.ala-line.ala-flash {
    animation: ala-flash-anim 0.8s ease;
}
@keyframes ala-flash-anim {
    0%, 100% { background: transparent; }
    50% { background: #dbeafe; }
}

.ala-date, .ala-time { color: #888; }
.ala-time { margin-right: 8px; }
.ala-level { font-weight: 600; display: inline-block; min-width: 65px; }
.ala-info    { color: #0066cc; }
.ala-debug   { color: #666; }
.ala-warning { color: #cc7700; }
.ala-error   { color: #d32f2f; }
.ala-success { color: #2e7d32; }
.ala-comp { color: #6a1b9a; font-weight: 600; margin-right: 8px; }
.ala-msg  { color: #333; }
.ala-unparsed { color: #999; }

.ala-explain-btn {
    background: #f0f0f4;
    border: 1px solid #dcdcdc;
    color: #333;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    margin-left: 12px;
    font-family: 'Inter', sans-serif;
}
.ala-explain-btn:hover { background: #e4e4e9; }

.ala-explanation {
    margin: 6px 0 10px 24px;
    padding: 10px 14px;
    background: #fffafa;
    border-left: 3px solid #d32f2f;
    border-radius: 0 6px 6px 0;
    color: #444;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    white-space: normal;
    word-break: break-word;
}

/* ─── Dashboard ─────────────────────────────────────────────────────────── */
.ala-dashboard {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ala-dash-card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 16px 20px;
}

.ala-dash-card-title {
    font-size: 14px;
    font-weight: 600;
    color: #333;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.ala-dash-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px 16px;
}

.ala-dash-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ala-dash-item-full {
    grid-column: 1 / -1;
}

.ala-dash-label {
    font-size: 11px;
    font-weight: 500;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.ala-dash-value {
    font-size: 13px;
    color: #333;
    font-weight: 500;
}

.ala-dash-ua {
    font-size: 11px;
    font-family: 'IBM Plex Mono', monospace;
    color: #666;
    word-break: break-all;
}

.ala-tag {
    display: inline-block;
    background: #eef2ff;
    color: #4f46e5;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
    margin-right: 4px;
}

.ala-member {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    margin-right: 6px;
}
.ala-member small { font-family: 'Inter', sans-serif; font-weight: 600; font-size: 10px; text-transform: uppercase; }
.ala-member-master { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }
.ala-member-slave { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }

/* ─── Alerts ────────────────────────────────────────────────────────────── */
.ala-alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 6px;
    margin-bottom: 8px;
    font-size: 13px;
}
.ala-alert:last-child { margin-bottom: 0; }
.ala-alert-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
.ala-alert strong { display: block; margin-bottom: 2px; }
.ala-alert small { color: #666; font-size: 11px; }

.ala-alert-ok     { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
.ala-alert-warn   { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
.ala-alert-danger  { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
.ala-alert-neutral { background: #f8fafc; border: 1px solid #e2e8f0; color: #475569; }

/* ─── Charts ────────────────────────────────────────────────────────────── */
.ala-dash-chart-card { overflow: hidden; }

.ala-chart-container { display: flex; flex-direction: column; gap: 4px; }

.ala-chart-legend {
    display: flex;
    gap: 16px;
    font-size: 11px;
    color: #666;
    margin-bottom: 4px;
}
.ala-legend-cpu { color: #3b82f6; }
.ala-legend-ram { color: #f97316; }

.ala-chart {
    display: flex;
    height: 150px;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    overflow: hidden;
}

.ala-chart-y-axis {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 4px 8px;
    font-size: 10px;
    color: #999;
    background: #fafafa;
    border-right: 1px solid #e5e7eb;
    min-width: 36px;
    text-align: right;
}

.ala-chart-area {
    flex: 1;
    display: flex;
    align-items: flex-end;
    gap: 0;
    padding: 2px 2px 0;
    background: #fff;
    position: relative;
}

.ala-chart-bar-group {
    display: flex;
    gap: 1px;
    align-items: flex-end;
    height: 100%;
}

.ala-chart-bar {
    flex: 1;
    min-width: 1px;
    border-radius: 1px 1px 0 0;
    transition: height 0.2s;
}

.ala-bar-cpu { background: rgba(59, 130, 246, 0.6); }
.ala-bar-ram { background: rgba(249, 115, 22, 0.6); }

.ala-chart-x-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: #999;
    padding: 2px 44px 0 44px;
}

/* ─── API Health ────────────────────────────────────────────────────────── */
.ala-api-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
}

.ala-api-card {
    padding: 12px;
    border-radius: 6px;
    border: 1px solid #e5e7eb;
    text-align: center;
}

.ala-api-name { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.ala-api-rate { font-size: 24px; font-weight: 700; }
.ala-api-detail { font-size: 11px; color: #666; }
.ala-api-error { font-size: 10px; color: #dc2626; margin-top: 4px; word-break: break-all; }

.ala-api-ok     { background: #f0fdf4; border-color: #bbf7d0; }
.ala-api-ok .ala-api-rate { color: #16a34a; }
.ala-api-warn   { background: #fffbeb; border-color: #fde68a; }
.ala-api-warn .ala-api-rate { color: #d97706; }
.ala-api-danger { background: #fef2f2; border-color: #fecaca; }
.ala-api-danger .ala-api-rate { color: #dc2626; }

/* ─── Timeline ──────────────────────────────────────────────────────────── */
.ala-timeline {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ala-tl-time-axis {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: #888;
    margin-bottom: 4px;
}

.ala-tl-track {
    position: relative;
    height: 40px;
    background: #f1f5f9;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid #e2e8f0;
}

.ala-tl-block {
    position: absolute;
    top: 0;
    height: 100%;
    opacity: 0.85;
    cursor: pointer;
    transition: opacity 0.15s;
    border-right: 1px solid rgba(255,255,255,0.4);
}
.ala-tl-block:hover { opacity: 1; z-index: 1; }
.ala-tl-block.ala-tl-template { opacity: 0.5; }

.ala-tl-tooltip {
    position: fixed;
    background: #1e293b;
    color: #fff;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    white-space: nowrap;
    z-index: 100000;
    pointer-events: none;
}

.ala-tl-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
}

.ala-tl-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #555;
}

.ala-tl-legend-color {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
}

.ala-tl-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}

.ala-tl-table th {
    text-align: left;
    padding: 8px 12px;
    font-weight: 600;
    color: #555;
    border-bottom: 2px solid #e5e7eb;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.ala-tl-table td {
    padding: 6px 12px;
    border-bottom: 1px solid #f1f5f9;
    color: #333;
}

.ala-tl-table tbody tr:hover { background: #f8fafc; }

/* ─── Sync ──────────────────────────────────────────────────────────────── */
.ala-sync-tab {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ala-sync-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ala-sync-info {
    display: flex;
    gap: 12px;
    align-items: center;
}

.ala-sync-members {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 4px;
}

.ala-sync-member {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 20px;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
    min-width: 120px;
}
.ala-sync-master { background: #fffbeb; border-color: #fcd34d; }
.ala-sync-slave { background: #f0fdf4; border-color: #bbf7d0; }

.ala-sync-member-icon { font-size: 20px; }
.ala-sync-master .ala-sync-member-icon { color: #d97706; }
.ala-sync-slave .ala-sync-member-icon { color: #16a34a; }

.ala-sync-member-ip {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    font-weight: 600;
    color: #333;
}

.ala-sync-member-role {
    font-size: 10px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 1px;
    color: #888;
}

.ala-drift-ok { background: rgba(34, 197, 94, 0.6); }
.ala-drift-warn { background: rgba(234, 179, 8, 0.6); }
.ala-drift-danger { background: rgba(239, 68, 68, 0.6); }

.ala-drift-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
}
.ala-drift-badge-ok { background: #dcfce7; color: #166534; }
.ala-drift-badge-warn { background: #fef3c7; color: #92400e; }
.ala-drift-badge-danger { background: #fee2e2; color: #991b1b; }

.ala-sync-events-container {
    max-height: 300px;
    overflow-y: auto;
}

.ala-sync-evt-error td { color: #dc2626; }
.ala-sync-evt-warn td { color: #d97706; }
.ala-sync-evt-boot td { color: #2563eb; font-weight: 500; }
.ala-sync-evt-ok td { color: #16a34a; }

/* ─── Empty Tab ─────────────────────────────────────────────────────────── */
.ala-empty-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: #999;
    font-size: 14px;
    padding: 40px;
}

/* ─── Search Group (F3) ────────────────────────────────────────────────── */
.ala-search-group {
    flex: 1;
    display: flex;
    gap: 0;
}
.ala-search-group .ala-search {
    flex: 1;
    border-radius: 6px 0 0 6px;
}
.ala-regex-toggle {
    background: #f5f5f5;
    border: 1px solid #c0c0c0;
    border-left: none;
    border-radius: 0 6px 6px 0;
    padding: 0 10px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    font-weight: 600;
    color: #999;
    cursor: pointer;
    transition: all 0.15s;
}
.ala-regex-toggle:hover { background: #eee; }
.ala-regex-toggle.active { background: #eef2ff; color: #4f46e5; border-color: #c7d2fe; }
.ala-search-error { border-color: #dc2626 !important; box-shadow: 0 0 0 2px rgba(220,38,38,0.15) !important; }

/* ─── Dark Mode & Sync Buttons ─────────────────────────────────────────── */
.ala-dark-toggle, .ala-sync-btn {
    background: none;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    padding: 0 10px;
    height: 34px;
    font-size: 14px;
    cursor: pointer;
    color: #666;
    transition: all 0.15s;
    font-family: 'Inter', sans-serif;
    white-space: nowrap;
}
.ala-dark-toggle:hover { background: #f0f0f4; }
.ala-sync-btn { font-size: 12px; }
.ala-sync-btn:hover { background: #eef2ff; border-color: #c7d2fe; color: #4f46e5; }
.ala-sync-btn.ala-synced { background: #dcfce7; border-color: #bbf7d0; color: #166534; }

/* ─── Export Button (F1) ───────────────────────────────────────────────── */
.ala-export-btn {
    background: #f5f5f5;
    border: 1px solid #d0d0d0;
    color: #555;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    white-space: nowrap;
    transition: all 0.15s;
}
.ala-export-btn:hover { background: #eee; border-color: #bbb; }

/* ─── Visible Count ────────────────────────────────────────────────────── */
.ala-visible-count {
    font-size: 11px;
    color: #888;
    padding: 6px 0;
    margin-left: auto;
    white-space: nowrap;
}

/* ─── Highlight (F4) ───────────────────────────────────────────────────── */
.ala-highlight {
    background: #fef08a;
    border-radius: 2px;
    padding: 0 1px;
    color: #000;
}

/* ─── Toast (F5) ───────────────────────────────────────────────────────── */
.ala-toast {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: #1e293b;
    color: #fff;
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-family: 'Inter', sans-serif;
    z-index: 10;
    animation: ala-toast-fade 1.5s ease forwards;
    pointer-events: none;
}
@keyframes ala-toast-fade {
    0% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; }
}
.ala-line { cursor: pointer; }

/* ─── JSON Viewer (F21) ───────────────────────────────────────────────── */
.ala-json-toggle {
    display: inline-block;
    background: #eef2ff;
    color: #4f46e5;
    padding: 1px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    transition: all 0.15s;
    border: 1px solid #c7d2fe;
}
.ala-json-toggle:hover { background: #c7d2fe; }
.ala-json-toggle.ala-json-expanded { background: #4f46e5; color: #fff; }
.ala-json-content {
    background: #1e293b;
    color: #e2e8f0;
    padding: 12px 16px;
    border-radius: 6px;
    margin: 6px 0;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid #334155;
}

/* ─── Error Groups (F7a) ──────────────────────────────────────────────── */
.ala-err-grp-error td { color: #dc2626; }
.ala-err-grp-warn td { color: #d97706; }
.ala-err-grp-error td:first-child, .ala-err-grp-warn td:first-child {
    font-weight: 700;
    font-size: 14px;
    text-align: center;
}

/* ─── Dark Mode (F19) ────────────────────────────────────────────────── */
.ala-dark { background: #0f172a; color: #e2e8f0; }
.ala-dark .ala-header { background: #1e293b; border-color: #334155; }
.ala-dark .ala-title { color: #f1f5f9; }
.ala-dark .ala-search { background: #1e293b; border-color: #475569; color: #e2e8f0; }
.ala-dark .ala-search::placeholder { color: #64748b; }
.ala-dark .ala-chip { background: #1e293b; border-color: #475569; color: #94a3b8; }
.ala-dark .ala-chip:hover { background: #334155; }
.ala-dark .ala-chip.active { background: #312e81; border-color: #4f46e5; color: #a5b4fc; }
.ala-dark .ala-level-chip[data-level="ERROR"].active { color: #f87171; background: #450a0a; border-color: #7f1d1d; }
.ala-dark .ala-level-chip[data-level="WARNING"].active { color: #fbbf24; background: #451a03; border-color: #78350f; }
.ala-dark .ala-level-chip[data-level="INFO"].active { color: #60a5fa; background: #172554; border-color: #1e3a5f; }
.ala-dark .ala-level-chip[data-level="DEBUG"].active { color: #94a3b8; background: #1e293b; border-color: #475569; }
.ala-dark .ala-level-chip[data-level="SUCCESS"].active { color: #4ade80; background: #052e16; border-color: #166534; }
.ala-dark .ala-tab-bar { background: #1e293b; border-color: #334155; }
.ala-dark .ala-tab { color: #64748b; }
.ala-dark .ala-tab:hover { color: #94a3b8; background: #334155; }
.ala-dark .ala-tab.active { color: #818cf8; border-bottom-color: #818cf8; }
.ala-dark .ala-log-body { background: #0f172a; }
.ala-dark .ala-line:hover { background: #1e293b; }
.ala-dark .ala-date, .ala-dark .ala-time { color: #64748b; }
.ala-dark .ala-info { color: #60a5fa; }
.ala-dark .ala-debug { color: #94a3b8; }
.ala-dark .ala-warning { color: #fbbf24; }
.ala-dark .ala-error { color: #f87171; }
.ala-dark .ala-success { color: #4ade80; }
.ala-dark .ala-comp { color: #c084fc; }
.ala-dark .ala-msg { color: #cbd5e1; }
.ala-dark .ala-unparsed { color: #64748b; }
.ala-dark .ala-dash-card { background: #1e293b; border-color: #334155; }
.ala-dark .ala-dash-card-title { color: #f1f5f9; }
.ala-dark .ala-dash-label { color: #64748b; }
.ala-dark .ala-dash-value { color: #e2e8f0; }
.ala-dark .ala-chart { border-color: #334155; }
.ala-dark .ala-chart-y-axis { background: #1e293b; border-color: #334155; color: #64748b; }
.ala-dark .ala-chart-area { background: #0f172a; }
.ala-dark .ala-chart-x-labels { color: #64748b; }
.ala-dark .ala-alert-ok { background: #052e16; border-color: #166534; color: #4ade80; }
.ala-dark .ala-alert-warn { background: #451a03; border-color: #78350f; color: #fbbf24; }
.ala-dark .ala-alert-danger { background: #450a0a; border-color: #7f1d1d; color: #f87171; }
.ala-dark .ala-alert-neutral { background: #1e293b; border-color: #334155; color: #94a3b8; }
.ala-dark .ala-api-ok { background: #052e16; border-color: #166534; }
.ala-dark .ala-api-warn { background: #451a03; border-color: #78350f; }
.ala-dark .ala-api-danger { background: #450a0a; border-color: #7f1d1d; }
.ala-dark .ala-tl-table th { color: #94a3b8; border-color: #334155; }
.ala-dark .ala-tl-table td { color: #cbd5e1; border-color: #1e293b; }
.ala-dark .ala-tl-table tbody tr:hover { background: #334155; }
.ala-dark .ala-summary { background: #1e293b; border-color: #334155; color: #e2e8f0; }
.ala-dark .ala-explanation { background: #1e293b; border-color: #7f1d1d; color: #e2e8f0; }
.ala-dark .ala-close-btn { border-color: #475569; color: #94a3b8; }
.ala-dark .ala-close-btn:hover { background: #7f1d1d; border-color: #dc2626; color: #f87171; }
.ala-dark .ala-bookmark-count { background: #312e81; color: #a5b4fc; }
.ala-dark .ala-bookmark-prev, .ala-dark .ala-bookmark-next { border-color: #475569; color: #94a3b8; }
.ala-dark .ala-line.ala-bookmarked { background: #422006 !important; border-bottom-color: #78350f; }
.ala-dark .ala-time-input { background: #1e293b; border-color: #475569; color: #e2e8f0; }
.ala-dark .ala-time-label { color: #94a3b8; }
.ala-dark .ala-summarize-btn { background: #4f46e5; }
.ala-dark .ala-summarize-btn:hover { background: #4338ca; }
.ala-dark .ala-highlight { background: #854d0e; color: #fef08a; }
.ala-dark .ala-json-toggle { background: #312e81; border-color: #4f46e5; color: #a5b4fc; }
.ala-dark .ala-json-toggle:hover { background: #4f46e5; color: #fff; }
.ala-dark .ala-toast { background: #f1f5f9; color: #1e293b; }
.ala-dark .ala-dark-toggle, .ala-dark .ala-sync-btn { border-color: #475569; color: #94a3b8; }
.ala-dark .ala-export-btn { background: #1e293b; border-color: #475569; color: #94a3b8; }
.ala-dark .ala-export-btn:hover { background: #334155; }
.ala-dark .ala-regex-toggle { background: #1e293b; border-color: #475569; color: #64748b; }
.ala-dark .ala-regex-toggle.active { background: #312e81; border-color: #4f46e5; color: #a5b4fc; }
.ala-dark .ala-visible-count { color: #64748b; }
.ala-dark .ala-comp-toggle { background: #0f172a; border-color: #475569; color: #94a3b8; }
.ala-dark .ala-explain-btn { background: #1e293b; border-color: #475569; color: #94a3b8; }
.ala-dark .ala-member-master { background: #451a03; color: #fbbf24; border-color: #78350f; }
.ala-dark .ala-member-slave { background: #052e16; color: #4ade80; border-color: #166534; }
.ala-dark .ala-sync-master { background: #451a03; border-color: #78350f; }
.ala-dark .ala-sync-slave { background: #052e16; border-color: #166534; }
.ala-dark .ala-tl-track { background: #1e293b; border-color: #334155; }
.ala-dark .ala-backdrop { background: rgba(0,0,0,0.7); }
.ala-dark .ala-tag { background: #312e81; color: #a5b4fc; }
.ala-dark .ala-log-body::-webkit-scrollbar-track { background: #1e293b; }
.ala-dark .ala-log-body::-webkit-scrollbar-thumb { background: #475569; }
`;
