// popup.js — DexManager Log Analyzer Configuration UI
// Optimized with async/await, proper error handling, and modern ES6+ patterns

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────
const STORAGE_KEYS = {
  API_KEY: 'geminiApiKey',
  DARK_MODE: 'logAnalyzerDarkMode'
};

const STATUS_TIMEOUT_MS = 3000;

const MEMORY_TREND_CLASSES = {
  rising: 'mem-danger',
  falling: 'mem-ok',
  stable: 'mem-neutral'
};

// ─── DOM Elements ────────────────────────────────────────────────────────────
let elements;

// ─── Initialization ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    cacheElements();
    await initializeSettings();
    attachEventListeners();
    await loadSyncedData();
  } catch (error) {
    console.error('Failed to initialize popup:', error);
    showStatus('Error al inicializar la extensión', 'error');
  }
});

// ─── Cache DOM Elements ──────────────────────────────────────────────────────
function cacheElements() {
  elements = {
    apiKeyInput: document.getElementById('apiKey'),
    saveBtn: document.getElementById('saveBtn'),
    statusEl: document.getElementById('status'),
    darkToggle: document.getElementById('darkToggle'),
    syncedContainer: document.getElementById('syncedPlayers'),
    clearBtn: document.getElementById('clearSync')
  };

  // Validate required elements exist
  const missing = Object.entries(elements)
    .filter(([, el]) => !el)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing DOM elements: ${missing.join(', ')}`);
  }
}

// ─── Initialize Settings ─────────────────────────────────────────────────────
async function initializeSettings() {
  try {
    const settings = await chromeStorageGet([
      STORAGE_KEYS.API_KEY,
      STORAGE_KEYS.DARK_MODE
    ]);

    // Load API key
    if (settings[STORAGE_KEYS.API_KEY]) {
      elements.apiKeyInput.value = settings[STORAGE_KEYS.API_KEY];
    }

    // Apply dark mode
    if (settings[STORAGE_KEYS.DARK_MODE]) {
      document.body.classList.add('dark');
      elements.darkToggle.innerHTML = '&#9788;';
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
    throw error;
  }
}

// ─── Attach Event Listeners ──────────────────────────────────────────────────
function attachEventListeners() {
  elements.saveBtn.addEventListener('click', handleSaveApiKey);
  elements.darkToggle.addEventListener('click', handleToggleDarkMode);
  elements.clearBtn.addEventListener('click', handleClearSyncedLogs);
}

// ─── Handle Save API Key ─────────────────────────────────────────────────────
async function handleSaveApiKey() {
  const key = elements.apiKeyInput.value.trim();

  if (!key) {
    showStatus('Por favor ingresa una API Key válida', 'error');
    return;
  }

  try {
    await chromeStorageSet({ [STORAGE_KEYS.API_KEY]: key });
    showStatus('API Key guardada exitosamente ✨', 'success');
  } catch (error) {
    console.error('Failed to save API key:', error);
    showStatus('Error al guardar la API Key', 'error');
  }
}

// ─── Handle Toggle Dark Mode ─────────────────────────────────────────────────
async function handleToggleDarkMode() {
  const isDark = document.body.classList.toggle('dark');
  elements.darkToggle.innerHTML = isDark ? '&#9788;' : '&#9789;';

  try {
    await chromeStorageSet({ [STORAGE_KEYS.DARK_MODE]: isDark });

    // Sync to localStorage for content script (optional cross-context sharing)
    try {
      localStorage.setItem('logAnalyzer_darkMode', isDark ? '1' : '0');
    } catch (e) {
      // localStorage may not be accessible in extension context
      console.warn('Could not sync to localStorage:', e);
    }
  } catch (error) {
    console.error('Failed to save dark mode preference:', error);
  }
}

// ─── Handle Clear Synced Logs ────────────────────────────────────────────────
async function handleClearSyncedLogs() {
  try {
    await sendRuntimeMessage({ type: 'CLEAR_SYNCED_LOGS' });
    await loadSyncedData();
    showStatus('Datos sincronizados eliminados', 'success');
  } catch (error) {
    console.error('Failed to clear synced logs:', error);
    showStatus('Error al eliminar datos', 'error');
  }
}

// ─── Load Synced Data ────────────────────────────────────────────────────────
async function loadSyncedData() {
  try {
    const response = await sendRuntimeMessage({ type: 'GET_SYNCED_LOGS' });

    if (!response?.logs || response.logs.length === 0) {
      renderEmptyState();
      return;
    }

    renderSyncedPlayers(response.logs);
  } catch (error) {
    console.error('Failed to load synced data:', error);
    renderEmptyState();
  }
}

// ─── Render Empty State ──────────────────────────────────────────────────────
function renderEmptyState() {
  elements.syncedContainer.innerHTML =
    '<p class="empty-sync">Sin datos sincronizados. Abre logs en distintos tabs y clickea "Sync".</p>';
}

// ─── Render Synced Players ───────────────────────────────────────────────────
function renderSyncedPlayers(logs) {
  const cards = logs.map(createPlayerCard).join('');
  elements.syncedContainer.innerHTML = cards;
}

// ─── Create Player Card ──────────────────────────────────────────────────────
function createPlayerCard(log) {
  const deviceInfo = log.deviceInfo || {};
  const name = deviceInfo.playerId || deviceInfo.storeId || `Tab ${log.tabId}`;

  const memoryClass = MEMORY_TREND_CLASSES[log.memoryTrend?.trend] || 'mem-neutral';
  const errorClass = getErrorClass(log.errorCount);

  return `
    <div class="player-card">
      <div class="player-name">${escapeHtml(String(name))}</div>
      <div class="player-stats">
        ${createStatItem('Errores', log.errorCount || 0, errorClass)}
        ${createStatItem('Warnings', log.warningCount || 0)}
        ${createStatItem('Líneas', log.totalLines || 0)}
        ${log.healthData ? createHealthStats(log.healthData) : ''}
        ${createStatItem('RAM Trend', log.memoryTrend?.trend || 'N/A', memoryClass)}
      </div>
      ${deviceInfo.platform ? createPlayerMeta(deviceInfo) : ''}
      ${createTimeRange(log.timeRange)}
    </div>
  `;
}

// ─── Create Stat Item ────────────────────────────────────────────────────────
function createStatItem(label, value, className = '') {
  return `
    <div class="stat">
      <span class="stat-label">${escapeHtml(label)}</span>
      <span class="stat-value ${className}">${escapeHtml(String(value))}</span>
    </div>
  `;
}

// ─── Create Health Stats ─────────────────────────────────────────────────────
function createHealthStats(healthData) {
  return `
    ${createStatItem('CPU', `${healthData.lastCpu}%`)}
    ${createStatItem('RAM', `${healthData.lastRam} MB`)}
  `;
}

// ─── Create Player Meta ──────────────────────────────────────────────────────
function createPlayerMeta(deviceInfo) {
  const version = deviceInfo.playerVersion
    ? ` • v${escapeHtml(deviceInfo.playerVersion)}`
    : '';
  return `<div class="player-meta">${escapeHtml(deviceInfo.platform)}${version}</div>`;
}

// ─── Create Time Range ───────────────────────────────────────────────────────
function createTimeRange(timeRange) {
  if (!timeRange) return '';
  const from = escapeHtml(timeRange.from || '?');
  const to = escapeHtml(timeRange.to || '?');
  return `<div class="player-time">${from} — ${to}</div>`;
}

// ─── Get Error Class ─────────────────────────────────────────────────────────
function getErrorClass(errorCount) {
  if (errorCount > 10) return 'err-danger';
  if (errorCount > 0) return 'err-warn';
  return 'err-ok';
}

// ─── Show Status Message ─────────────────────────────────────────────────────
function showStatus(message, type = 'success') {
  elements.statusEl.textContent = message;
  elements.statusEl.className = `status-msg ${type}`;
  elements.statusEl.classList.remove('hidden');

  setTimeout(() => {
    elements.statusEl.classList.add('hidden');
  }, STATUS_TIMEOUT_MS);
}

// ─── Escape HTML (XSS Prevention) ────────────────────────────────────────────
function escapeHtml(str) {
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;'
  };

  return String(str).replace(/[&<>"'/]/g, char => escapeMap[char]);
}

// ─── Chrome Storage Helpers (Promisified) ────────────────────────────────────
function chromeStorageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function chromeStorageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

// ─── Chrome Runtime Message Helper ───────────────────────────────────────────
function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
