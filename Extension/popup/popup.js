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
});
