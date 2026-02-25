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
        .catch(() => {});
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
                    <input type="text" class="ala-search" placeholder="Buscar...">
                    <span class="ala-bookmark-nav">
                        <span class="ala-bookmark-count" title="Bookmarks">0</span>
                        <button class="ala-bookmark-prev" title="Bookmark anterior">&#9650;</button>
                        <button class="ala-bookmark-next" title="Bookmark siguiente">&#9660;</button>
                    </span>
                    <button class="ala-close-btn">&#10005;</button>
                </div>
                <div class="ala-controls">
                    <div class="ala-filter-row">
                        <div class="ala-levels">
                            ${['INFO','DEBUG','WARNING','ERROR','SUCCESS'].map(l =>
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
                    </div>
                </div>
            </div>
            <div class="ala-tab-bar">
                <button class="ala-tab active" data-tab="logs">Logs</button>
                <button class="ala-tab" data-tab="dashboard">Dashboard</button>
                <button class="ala-tab" data-tab="timeline">Timeline</button>
                <button class="ala-tab" data-tab="sync">Sync</button>
            </div>
            <div class="ala-summary-container"></div>
            <div class="ala-tab-content active" data-content="logs">
                <div class="ala-log-body">
                    ${parsed.map(p => {
                        if (p.level) {
                            return `<div class="ala-line" data-level="${p.level}" data-comp="${escapeHtml(p.comp)}" data-hm="${p.hm}" data-text="${escapeHtml(p.raw.toLowerCase())}" data-idx="${p.index}">` +
                                `<span class="ala-line-bookmark" title="Bookmark"></span>` +
                                `<span class="ala-date">${p.date}</span>` +
                                `<span class="ala-time">${p.time}</span>` +
                                `<span class="ala-level ala-${p.level.toLowerCase()}">${p.level}</span>` +
                                `<span class="ala-comp">${escapeHtml(p.comp)}</span>` +
                                `<span class="ala-msg">${escapeHtml(p.message)}</span>` +
                                ((p.level === 'ERROR' || p.level === 'WARNING') ?
                                    `<button class="ala-explain-btn" data-idx="${p.index}">&#10024; Explicar</button>` : '') +
                                `</div>`;
                        }
                        return `<div class="ala-line ala-unparsed" data-text="${escapeHtml(p.raw.toLowerCase())}" data-idx="${p.index}"><span class="ala-line-bookmark" title="Bookmark"></span>${escapeHtml(p.raw)}</div>`;
                    }).join('')}
                </div>
            </div>
            <div class="ala-tab-content" data-content="dashboard">
                ${buildDashboardHTML(deviceInfo, healthData, memoryTrend, rebootInfo, apiStats, syncGroupInfo)}
            </div>
            <div class="ala-tab-content" data-content="timeline">
                ${buildTimelineHTML(mediaTimeline, mediaStats, minTime, maxTime)}
            </div>
            <div class="ala-tab-content" data-content="sync">
                ${buildSyncHTML(syncGroupInfo, syncData, syncEvents)}
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

            for (let i = 0; i < lineIndex.length; i++) {
                const { el, level, comp, hm, text } = lineIndex[i];
                const show = (!level || activeLevels.has(level))
                    && (!comp || activeComps.has(comp))
                    && (!term || text.includes(term))
                    && (!useTime || !hm || (hm >= from && hm <= to));
                if (el.classList.contains('hidden') !== !show) {
                    el.classList.toggle('hidden', !show);
                }
            }
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
    overlay.querySelector('.ala-summarize-btn').onclick = function() {
        summarizeLogs(overlay, this);
    };

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
function buildDashboardHTML(deviceInfo, healthData, memoryTrend, rebootInfo, apiStats, syncGroupInfo) {
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

    return `<div class="ala-dashboard">${deviceCard}${alertsCard}${chartCard}${apiCards}</div>`;
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
`;
