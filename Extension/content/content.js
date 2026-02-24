// content.js - Injected into the shadow dom log viewer page

console.log("🚀 DexManager Log Analyzer AI Started!");

// Recursive function to pierce through Shadow DOMs
function findElementDeep(root, selector) {
    let el = root.querySelector(selector);
    if (el) return el;

    // Find all custom elements that might have shadow roots
    const children = root.querySelectorAll('*');
    for (let child of children) {
        if (child.shadowRoot) {
            const found = findElementDeep(child.shadowRoot, selector);
            if (found) return found;
        }
    }
    return null;
}

// Guard flag to prevent re-entrant calls
let isProcessing = false;

// We need to continuously check because the paper-dialog might open dynamically
// and the logs take time to fetch from the server.
const initInterval = setInterval(() => {
    if (isProcessing) return;

    const dialog = findElementDeep(document, 'paper-dialog#previewLogDialog');
    if (dialog) {
        // Set width and height but DO NOT force display property to avoid overriding open/close native logic
        dialog.style.width = '90vw';
        dialog.style.maxWidth = '1400px';
        dialog.style.height = '90vh';

        const logContent = dialog.querySelector('.content-body');
        // Wait until there is actual log data (more than just whitespace)
        if (logContent && !logContent.dataset.analyzed && logContent.textContent.trim().length > 50) {
            logContent.dataset.analyzed = "true";

            // Set up an observer in case the user loads a different log into the same dialog
            if (!dialog.dataset.observerAttached) {
                dialog.dataset.observerAttached = "true";
                const observer = new MutationObserver(() => {
                    if (isProcessing) return;

                    const currentLogs = dialog.querySelector('.content-body');
                    if (currentLogs && !currentLogs.dataset.analyzed && currentLogs.textContent.trim().length > 50) {
                        currentLogs.dataset.analyzed = "true";
                        isProcessing = true;
                        try {
                            initAnalyzer(currentLogs.parentNode, currentLogs);
                        } finally {
                            isProcessing = false;
                        }
                    }
                });
                observer.observe(dialog, { childList: true, subtree: true });
            }

            isProcessing = true;
            try {
                initAnalyzer(logContent.parentNode, logContent);
            } finally {
                isProcessing = false;
            }
        }
    }
}, 1000);

let contextFileText = "";

// Fetch mapping context (resume.txt)
fetch(chrome.runtime.getURL('resume.txt'))
    .then(res => res.text())
    .then(text => { contextFileText = text; })
    .catch(err => console.error("Could not fetch resume.txt", err));

function initAnalyzer(shadowRoot, logContent) {
    injectCSS(shadowRoot);

    // Cleanup old UI elements if they exist from a previous log
    const oldBar = shadowRoot.querySelector('.ai-filter-bar');
    if (oldBar) oldBar.remove();

    const oldSummary = shadowRoot.querySelector('.ai-global-summary');
    if (oldSummary) oldSummary.remove();

    const rawText = logContent.textContent;
    const lines = rawText.split('\n');

    let components = new Set();

    // Transform lines into styled DOM elements
    const fragment = document.createDocumentFragment();

    // Component in brackets is OPTIONAL — many log lines skip it
    const regex = /^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2}\.\d+)\s([A-Z]+)\s(?:(\[[^\]]+\])\s)?(.*)$/;

    lines.forEach((line, index) => {
        if (!line.trim()) return;

        const div = document.createElement('div');
        div.className = 'log-line';

        const match = line.match(regex);
        if (match) {
            const [_, date, time, level, component, message] = match;
            const comp = component || '[General]';
            components.add(comp);

            div.dataset.level = level;
            div.dataset.component = comp;
            // Store lowercase text for fast search matching
            div.dataset.text = line.toLowerCase();

            div.innerHTML = `
        <span class="log-date">${date}</span>
        <span class="log-time">${time}</span>
        <span class="log-level level-${level.toLowerCase()}">${level}</span>
        <span class="log-component">${escapeHtml(comp)}</span>
        <span class="log-message">${escapeHtml(message)}</span>
      `;

            if (level === 'ERROR' || level === 'WARNING') {
                const aiBtn = document.createElement('button');
                aiBtn.className = 'ai-inline-btn';
                aiBtn.innerHTML = '✨ Explicar';
                aiBtn.onclick = () => explainLog(line, lines.slice(Math.max(0, index - 10), index + 5).join('\n'), aiBtn);
                div.appendChild(aiBtn);
            }
        } else {
            div.className = 'log-line parse-fail';
            div.dataset.text = line.toLowerCase();
            div.textContent = line;
        }

        fragment.appendChild(div);
    });

    // Clear original and append new
    logContent.innerHTML = '';
    logContent.appendChild(fragment);

    buildTopBar(shadowRoot, logContent, Array.from(components));
}

function buildTopBar(shadowRoot, logContent, components) {
    const bar = document.createElement('div');
    bar.className = 'ai-filter-bar';

    const titleRow = document.createElement('div');
    titleRow.className = 'ai-title-row';

    const title = document.createElement('div');
    title.className = 'ai-title';
    title.innerHTML = '<strong>Log Analyzer</strong> AI';
    titleRow.appendChild(title);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '🔍 Buscar...';
    searchInput.className = 'ai-search-input';
    // Debounce search for performance
    let searchTimer;
    searchInput.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyFilters(shadowRoot), 150);
    };
    titleRow.appendChild(searchInput);

    bar.appendChild(titleRow);

    const controlsRow = document.createElement('div');
    controlsRow.className = 'ai-controls-row';

    // Levels Filter
    const levelsGroup = document.createElement('div');
    levelsGroup.className = 'ai-filters levels';
    ['INFO', 'DEBUG', 'WARNING', 'ERROR'].forEach(lvl => {
        const btn = document.createElement('button');
        btn.className = `filter-chip level-chip active`;
        btn.textContent = lvl;
        btn.dataset.level = lvl;
        btn.onclick = () => {
            btn.classList.toggle('active');
            applyFilters(shadowRoot);
        };
        levelsGroup.appendChild(btn);
    });
    controlsRow.appendChild(levelsGroup);

    // Components Filter
    const compGroup = document.createElement('div');
    compGroup.className = 'ai-filters components';
    components.forEach(comp => {
        const btn = document.createElement('button');
        btn.className = 'filter-chip comp-chip active';
        btn.textContent = comp;
        btn.dataset.comp = comp;
        btn.onclick = () => {
            btn.classList.toggle('active');
            applyFilters(shadowRoot);
        };
        compGroup.appendChild(btn);
    });
    controlsRow.appendChild(compGroup);

    const summaryBtn = document.createElement('button');
    summaryBtn.className = 'ai-action-btn';
    summaryBtn.innerHTML = '🧠 Resumir Sesión';
    summaryBtn.onclick = () => summarizeLogs(shadowRoot, logContent, summaryBtn);
    controlsRow.appendChild(summaryBtn);

    bar.appendChild(controlsRow);

    logContent.parentNode.insertBefore(bar, logContent);
}

function applyFilters(shadowRoot) {
    const activeComps = new Set(Array.from(shadowRoot.querySelectorAll('.comp-chip.active')).map(b => b.dataset.comp));
    const activeLevels = new Set(Array.from(shadowRoot.querySelectorAll('.level-chip.active')).map(b => b.dataset.level));
    const searchInput = shadowRoot.querySelector('.ai-search-input');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

    const lines = shadowRoot.querySelectorAll('.log-line');

    lines.forEach(line => {
        const comp = line.dataset.component;
        const level = line.dataset.level;
        const text = line.dataset.text || '';

        const compMatch = !comp || activeComps.has(comp);
        const levelMatch = !level || activeLevels.has(level);
        const searchMatch = !searchTerm || text.includes(searchTerm);

        if (compMatch && levelMatch && searchMatch) {
            line.classList.remove('hidden');
        } else {
            line.classList.add('hidden');
        }
    });
}

async function callGemini(prompt) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['geminiApiKey'], async (result) => {
            const key = result.geminiApiKey;
            if (!key) {
                return reject(new Error("No API Key"));
            }

            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        systemInstruction: {
                            parts: [{ text: "Eres un ingeniero experto en análisis de logs. Aquí tienes el manual técnico de la arquitectura de la que tratarán los logs:\n\n" + contextFileText }]
                        }
                    })
                });

                if (!response.ok) throw new Error("API Request Failed");
                const data = await response.json();
                resolve(data.candidates[0].content.parts[0].text);
            } catch (err) {
                reject(err);
            }
        });
    });
}

function promptForApiKey() {
    return new Promise((resolve) => {
        // We use alert instead of prompt to prevent freezing the entire browser tab indefinitely 
        // if the user switches tabs while waiting for the AI.
        alert("⚠️ Funcionalidad AI detectada pero no hay API Key.\n\nPor favor configura tu API Key de Gemini haciendo clic en el ícono de la extensión arriba a la derecha para no bloquear la página.");
        resolve(false);
    });
}

async function explainLog(targetLine, contextFrame, btnElement) {
    btnElement.innerHTML = '⏳ Pensando...';
    btnElement.disabled = true;

    const prompt = `Explicame brevemente qué significa este error y sus posibles causas, basándote en el manual técnico que conoces. Sé conciso.\n\nLínea afectada:\n${targetLine}\n\nContexto cercano:\n${contextFrame}`;

    try {
        const result = await callGemini(prompt);

        const explanationDiv = document.createElement('div');
        explanationDiv.className = 'ai-explanation-box';
        explanationDiv.innerHTML = '<strong>✨ AI Insight:</strong><br/>' + formatMarkdown(result);

        // Insert after the current line
        const currentLineDiv = btnElement.parentElement;
        currentLineDiv.parentNode.insertBefore(explanationDiv, currentLineDiv.nextSibling);
        btnElement.innerHTML = '✅ Explicado';
    } catch (e) {
        if (e.message === "No API Key") {
            const saved = await promptForApiKey();
            if (saved) {
                return explainLog(targetLine, contextFrame, btnElement); // retry
            }
            btnElement.innerHTML = '✨ Explicar';
        } else {
            console.error(e);
            btnElement.innerHTML = '❌ Error API';
        }
        btnElement.disabled = false;
    }
}

async function summarizeLogs(shadowRoot, logContent, btnElement) {
    // Grab a sample of logs (e.g. first 100, last 100, and all errors/warnings) to avoid token limits
    btnElement.innerHTML = '⏳ Resumiendo...';

    // ONLY send lines that are currently visible (filtered)
    const visibleLines = Array.from(shadowRoot.querySelectorAll('.log-line[data-component]'))
        .filter(l => l.style.display !== 'none');

    const critical = visibleLines.filter(l => l.dataset.level === 'ERROR' || l.dataset.level === 'WARNING').map(l => l.textContent);

    const start = visibleLines.slice(0, 50).map(l => l.textContent);
    const end = visibleLines.slice(-50).map(l => l.textContent);

    const sample = [...start, ...critical, "--- TRIMMED ---", ...end].join('\n');

    const prompt = `Por favor, haz un resumen analítico de esta sesión de logs. Destaca cualquier problema principal, anomalías de memoria, o bucles fallidos. Ignora eventos de latencia regulares a menos que sean un problema.\n\nMuestra de Logs:\n${sample}`;

    try {
        const result = await callGemini(prompt);

        // Check if summary already exists
        let sumDiv = shadowRoot.querySelector('.ai-global-summary');
        if (!sumDiv) {
            sumDiv = document.createElement('div');
            sumDiv.className = 'ai-global-summary';
            const filterBar = shadowRoot.querySelector('.ai-filter-bar');
            filterBar.parentNode.insertBefore(sumDiv, filterBar.nextSibling);
        }

        sumDiv.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                <strong>🧠 Resumen de Sesión:</strong>
                <div>
                    <button class="ai-action-btn copy-btn" style="margin-right: 8px;">📋 Copiar</button>
                    <button class="ai-action-btn close-btn" style="background:#d32f2f; border-color:#b71c1c;">✖ Cerrar</button>
                </div>
            </div>
            <div class="summary-content">${formatMarkdown(result)}</div>
        `;

        sumDiv.querySelector('.copy-btn').onclick = (e) => {
            navigator.clipboard.writeText(result);
            e.target.innerHTML = '✅ Copiado';
            setTimeout(() => e.target.innerHTML = '📋 Copiar', 2000);
        };

        sumDiv.querySelector('.close-btn').onclick = () => {
            sumDiv.remove();
        };

        btnElement.innerHTML = '✅ Resumido';
        setTimeout(() => { btnElement.innerHTML = '🧠 Resumir Sesión'; }, 5000);
    } catch (e) {
        if (e.message === "No API Key") {
            const saved = await promptForApiKey();
            if (saved) {
                return summarizeLogs(shadowRoot, logContent, btnElement); // retry
            }
            btnElement.innerHTML = '🧠 Resumir Sesión';
        } else {
            console.error(e);
            btnElement.innerHTML = '❌ Error API';
        }
    }
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatMarkdown(text) {
    // Basic Markdown parser: replace **text** with <strong>text</strong>
    let formatted = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Replace *text* with <em>text</em>
    formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Replace line breaks
    formatted = formatted.replace(/\n/g, '<br/>');
    return formatted;
}

function injectCSS(shadowRoot) {
    if (shadowRoot.querySelector('#ai-styles')) return;

    const style = document.createElement('style');
    style.id = 'ai-styles';
    style.textContent = `
    /* Minimalist Aesthetic */
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');

    #previewLogDialog .content-wrapper {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    #previewLogDialog .content-body {
        background: #fafafa !important;
        color: #333333 !important;
        font-family: 'IBM Plex Mono', monospace !important;
        font-size: 13px;
        line-height: 1.5;
        padding: 16px;
        border-radius: 6px;
        overflow-y: auto !important;
        overflow-x: auto !important;
        flex: 1 1 auto !important;
        min-height: 0 !important;
        height: auto !important;
        max-width: 100% !important;
        width: 100% !important;
        margin-top: 16px;
        box-sizing: border-box !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }

    #previewLogDialog .content-body::-webkit-scrollbar {
        width: 8px;
        background: #f1f1f1;
    }
    #previewLogDialog .content-body::-webkit-scrollbar-thumb {
        background: #c1c1c1;
        border-radius: 4px;
    }
    
    .log-line {
        padding: 3px 0;
        white-space: nowrap;
        border-bottom: 1px solid transparent;
        transition: background 0.1s;
    }
    
    .log-line.hidden {
        display: none !important;
    }
    
    .log-line:hover {
        background: #f0f0f4;
    }
    
    .log-date { color: #888; }
    .log-time { color: #888; margin-right: 8px; }
    
    .log-level {
        font-weight: 600;
        display: inline-block;
        min-width: 65px;
    }
    .level-info { color: #0066cc; }
    .level-debug { color: #666666; }
    .level-success { color: #008844; }
    .level-warning { color: #cc7700; }
    .level-error { color: #d32f2f; }
    
    .log-component {
        color: #6a1b9a;
        margin-right: 8px;
        font-weight: 600;
    }
    
    .log-message {
        color: #333;
    }
    
    .ai-inline-btn {
        background: #f0f0f4;
        border: 1px solid #dcdcdc;
        color: #333;
        border-radius: 4px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        margin-left: 12px;
        font-family: 'Inter', sans-serif;
        transition: all 0.2s;
    }
    
    .ai-inline-btn:hover {
        background: #e4e4e9;
        border-color: #c4c4c9;
    }
    
    .ai-explanation-box {
        margin: 8px 0 12px 24px;
        padding: 12px 16px;
        background: #fffafa;
        border-left: 3px solid #d32f2f;
        border-radius: 0 4px 4px 0;
        color: #444;
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }
    
    .ai-global-summary {
        margin: 16px 0;
        padding: 20px;
        background: #f8fbff;
        border: 1px solid #d0e3ff;
        border-radius: 6px;
        color: #333;
        font-family: 'Inter', sans-serif;
        font-size: 14px;
        line-height: 1.6;
        box-shadow: 0 2px 8px rgba(0,0,0,0.04);
        box-sizing: border-box;
        width: 100%;
        overflow-x: auto;
    }
    
    .summary-content {
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .ai-global-summary strong {
        color: #222;
    }
    
    .ai-filter-bar {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px 16px;
        background: #ffffff;
        border-radius: 6px;
        border: 1px solid #e0e0e0;
        font-family: 'Inter', sans-serif;
        box-shadow: 0 1px 4px rgba(0,0,0,0.04);
        box-sizing: border-box;
        width: 100%;
    }
    
    .ai-title-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
    }
    
    .ai-controls-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        width: 100%;
    }
    
    .ai-title {
        font-size: 15px;
        color: #333;
        font-weight: 500;
    }
    
    .ai-search-input {
        padding: 6px 12px;
        border: 1px solid #c0c0c0;
        border-radius: 4px;
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        width: 250px;
        outline: none;
    }
    
    .ai-search-input:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 2px rgba(37,99,235,0.2);
    }
    
    .ai-filters {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    
    .ai-filters.levels {
        border-right: 1px solid #e0e0e0;
        padding-right: 12px;
    }
    
    .ai-filters.components {
        flex: 1;
    }
    
    .filter-chip {
        background: #f5f5f5;
        border: 1px solid #e0e0e0;
        color: #555;
        padding: 4px 12px;
        border-radius: 16px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
        font-family: 'Inter', sans-serif;
    }
    
    .filter-chip:hover {
        background: #e8e8e8;
    }
    
    .filter-chip.active {
        background: #eef2ff;
        border-color: #c7d2fe;
        color: #4f46e5;
        font-weight: 500;
    }
    
    .level-chip[data-level="ERROR"].active { color: #d32f2f; background: #ffebee; border-color: #ffcdd2; }
    .level-chip[data-level="WARNING"].active { color: #f57c00; background: #fff3e0; border-color: #ffe0b2; }
    .level-chip[data-level="INFO"].active { color: #1976d2; background: #e3f2fd; border-color: #bbdefb; }
    .level-chip[data-level="DEBUG"].active { color: #616161; background: #f5f5f5; border-color: #e0e0e0; }
    
    .ai-action-btn {
        background: #2563eb;
        border: 1px solid #1d4ed8;
        color: #ffffff;
        padding: 6px 16px;
        border-radius: 4px;
        font-weight: 500;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s;
        font-family: 'Inter', sans-serif;
    }
    
    .ai-action-btn:hover {
        background: #1d4ed8;
    }
    `;
    shadowRoot.appendChild(style);
}

