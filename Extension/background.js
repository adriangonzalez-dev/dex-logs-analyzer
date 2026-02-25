// background.js — Service worker for multi-player log sync (F15)
const syncedLogs = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SYNC_LOG_DATA') {
        const tabId = sender.tab?.id || 'unknown';
        syncedLogs[tabId] = {
            ...message.payload,
            tabId,
            tabUrl: sender.tab?.url || '',
            syncedAt: Date.now()
        };
        sendResponse({ ok: true, count: Object.keys(syncedLogs).length });
        return true;
    }

    if (message.type === 'GET_SYNCED_LOGS') {
        // Clean old entries (> 30 min)
        const now = Date.now();
        Object.keys(syncedLogs).forEach(k => {
            if (now - syncedLogs[k].syncedAt > 30 * 60 * 1000) delete syncedLogs[k];
        });
        sendResponse({ logs: Object.values(syncedLogs) });
        return true;
    }

    if (message.type === 'CLEAR_SYNCED_LOGS') {
        Object.keys(syncedLogs).forEach(k => delete syncedLogs[k]);
        sendResponse({ ok: true });
        return true;
    }
});
