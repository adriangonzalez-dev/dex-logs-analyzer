document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  // Load existing key
  chrome.storage.local.get(['geminiApiKey'], (result) => {
    if (result.geminiApiKey) {
      apiKeyInput.value = result.geminiApiKey;
    }
  });

  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ geminiApiKey: key }, () => {
      statusEl.textContent = 'API Key guardada exitosamente ✨';
      statusEl.classList.remove('hidden');
      setTimeout(() => {
        statusEl.classList.add('hidden');
      }, 3000);
    });
  });

  // ─── Dark Mode Toggle (F19) ──────────────────────────────────────────
  const darkToggle = document.getElementById('darkToggle');

  chrome.storage.local.get(['logAnalyzerDarkMode'], (result) => {
    if (result.logAnalyzerDarkMode) {
      document.body.classList.add('dark');
      darkToggle.innerHTML = '&#9788;';
    }
  });

  darkToggle.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark');
    darkToggle.innerHTML = isDark ? '&#9788;' : '&#9789;';
    chrome.storage.local.set({ logAnalyzerDarkMode: isDark });
    // Also sync to localStorage for content script
    try { localStorage.setItem('logAnalyzer_darkMode', isDark ? '1' : '0'); } catch (e) { }
  });

  // ─── Multi-Player Sync (F15) ─────────────────────────────────────────
  const syncedContainer = document.getElementById('syncedPlayers');
  const clearBtn = document.getElementById('clearSync');

  function loadSyncedData() {
    chrome.runtime.sendMessage({ type: 'GET_SYNCED_LOGS' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.logs || response.logs.length === 0) {
        syncedContainer.innerHTML = '<p class="empty-sync">Sin datos sincronizados. Abre logs en distintos tabs y clickea "Sync".</p>';
        return;
      }

      const cards = response.logs.map(log => {
        const di = log.deviceInfo || {};
        const name = di.playerId || di.storeId || `Tab ${log.tabId}`;
        const memClass = log.memoryTrend?.trend === 'rising' ? 'mem-danger'
          : log.memoryTrend?.trend === 'falling' ? 'mem-ok' : 'mem-neutral';
        const errClass = log.errorCount > 10 ? 'err-danger' : log.errorCount > 0 ? 'err-warn' : 'err-ok';

        return `
          <div class="player-card">
            <div class="player-name">${escapeHtml(String(name))}</div>
            <div class="player-stats">
              <div class="stat">
                <span class="stat-label">Errores</span>
                <span class="stat-value ${errClass}">${log.errorCount || 0}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Warnings</span>
                <span class="stat-value">${log.warningCount || 0}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Líneas</span>
                <span class="stat-value">${log.totalLines || 0}</span>
              </div>
              ${log.healthData ? `
              <div class="stat">
                <span class="stat-label">CPU</span>
                <span class="stat-value">${log.healthData.lastCpu}%</span>
              </div>
              <div class="stat">
                <span class="stat-label">RAM</span>
                <span class="stat-value">${log.healthData.lastRam} MB</span>
              </div>` : ''}
              <div class="stat">
                <span class="stat-label">RAM Trend</span>
                <span class="stat-value ${memClass}">${log.memoryTrend?.trend || 'N/A'}</span>
              </div>
            </div>
            ${di.platform ? `<div class="player-meta">${escapeHtml(di.platform)} ${di.playerVersion ? '• v' + escapeHtml(di.playerVersion) : ''}</div>` : ''}
            <div class="player-time">${log.timeRange?.from || '?'} — ${log.timeRange?.to || '?'}</div>
          </div>
        `;
      }).join('');

      syncedContainer.innerHTML = cards;
    });
  }

  loadSyncedData();

  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_SYNCED_LOGS' }, () => {
      loadSyncedData();
    });
  });

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
});
