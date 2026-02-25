// background.js — Service Worker for DexManager Log Analyzer
// Manages synced logs across multiple tabs for multi-player comparison

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────
const SYNCED_LOGS_KEY = 'syncedLogs';
const MAX_SYNCED_LOGS = 20; // Prevent unbounded memory growth

// ─── In-Memory Cache ─────────────────────────────────────────────────────────
// Service workers can be terminated at any time — persist to chrome.storage
let syncedLogsCache = [];

// ─── Initialization ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log('📦 DexManager Log Analyzer installed');
  loadSyncedLogs();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('🔄 Service Worker started');
  loadSyncedLogs();
});

// ─── Load Synced Logs from Storage ──────────────────────────────────────────
async function loadSyncedLogs() {
  try {
    const result = await chrome.storage.local.get([SYNCED_LOGS_KEY]);
    syncedLogsCache = result[SYNCED_LOGS_KEY] || [];
    console.log(`✅ Loaded ${syncedLogsCache.length} synced logs`);
  } catch (error) {
    console.error('❌ Failed to load synced logs:', error);
    syncedLogsCache = [];
  }
}

// ─── Save Synced Logs to Storage ─────────────────────────────────────────────
async function saveSyncedLogs() {
  try {
    await chrome.storage.local.set({ [SYNCED_LOGS_KEY]: syncedLogsCache });
    console.log(`💾 Saved ${syncedLogsCache.length} synced logs`);
  } catch (error) {
    console.error('❌ Failed to save synced logs:', error);
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // All handlers are async — return true to keep channel open
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  const { type } = message;

  switch (type) {
    case 'ADD_SYNCED_LOG':
      await handleAddSyncedLog(message, sender, sendResponse);
      break;

    case 'GET_SYNCED_LOGS':
      handleGetSyncedLogs(sendResponse);
      break;

    case 'CLEAR_SYNCED_LOGS':
      await handleClearSyncedLogs(sendResponse);
      break;

    default:
      sendResponse({ error: `Unknown message type: ${type}` });
  }
}

// ─── Add Synced Log ──────────────────────────────────────────────────────────
async function handleAddSyncedLog(message, sender, sendResponse) {
  const { logData } = message;

  if (!logData) {
    sendResponse({ error: 'Missing logData' });
    return;
  }

  // Add sender tab info
  const enrichedLog = {
    ...logData,
    tabId: sender.tab?.id || null,
    timestamp: Date.now()
  };

  // Remove oldest log if at capacity
  if (syncedLogsCache.length >= MAX_SYNCED_LOGS) {
    syncedLogsCache.shift();
  }

  syncedLogsCache.push(enrichedLog);
  await saveSyncedLogs();

  sendResponse({ success: true, totalLogs: syncedLogsCache.length });
}

// ─── Get Synced Logs ─────────────────────────────────────────────────────────
function handleGetSyncedLogs(sendResponse) {
  sendResponse({ logs: syncedLogsCache });
}

// ─── Clear Synced Logs ───────────────────────────────────────────────────────
async function handleClearSyncedLogs(sendResponse) {
  syncedLogsCache = [];
  await saveSyncedLogs();
  sendResponse({ success: true });
}

// ─── Error Handler ───────────────────────────────────────────────────────────
self.addEventListener('error', (event) => {
  console.error('🔥 Service Worker error:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('🔥 Unhandled promise rejection:', event.reason);
});
