const SUNO_BASE = 'https://suno.com';
const SUNO_CREATE = 'https://suno.com/create';
const SUNO_LIBRARY = 'https://suno.com/me';
const SUNO_EXPLORE = 'https://suno.com/explore';
const HISTORY_KEY = 'suno_prompt_history';
const MAX_HISTORY = 20;

document.addEventListener('DOMContentLoaded', () => {
  const btnOpenSuno = document.getElementById('btn-open-suno');
  const btnCreateSong = document.getElementById('btn-create-song');
  const btnGenerate = document.getElementById('btn-generate');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const btnLibrary = document.getElementById('btn-library');
  const btnExplore = document.getElementById('btn-explore');
  const btnSettings = document.getElementById('btn-settings');
  const promptInput = document.getElementById('prompt-input');
  const instrumentalToggle = document.getElementById('instrumental-toggle');
  const styleSelect = document.getElementById('style-select');
  const historyList = document.getElementById('history-list');

  // Load saved state
  chrome.storage.local.get(['lastPrompt', 'instrumental', 'style', HISTORY_KEY], (data) => {
    if (data.lastPrompt) promptInput.value = data.lastPrompt;
    if (data.instrumental) instrumentalToggle.checked = data.instrumental;
    if (data.style) styleSelect.value = data.style;
    renderHistory(data[HISTORY_KEY] || []);
  });

  // Quick actions
  btnOpenSuno.addEventListener('click', () => {
    chrome.tabs.create({ url: SUNO_BASE });
  });

  btnCreateSong.addEventListener('click', () => {
    chrome.tabs.create({ url: SUNO_CREATE });
  });

  // Generate: save prompt and open Suno create page with prompt context
  btnGenerate.addEventListener('click', () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      promptInput.focus();
      return;
    }

    const style = styleSelect.value;
    const instrumental = instrumentalToggle.checked;

    // Build the full prompt
    let fullPrompt = prompt;
    if (style) {
      fullPrompt = `${style} - ${fullPrompt}`;
    }

    // Save to history
    chrome.storage.local.get([HISTORY_KEY], (data) => {
      const history = data[HISTORY_KEY] || [];
      history.unshift({
        prompt: fullPrompt,
        instrumental,
        style,
        timestamp: Date.now()
      });
      // Keep only recent entries
      const trimmed = history.slice(0, MAX_HISTORY);
      chrome.storage.local.set({
        [HISTORY_KEY]: trimmed,
        lastPrompt: prompt,
        instrumental,
        style
      });
      renderHistory(trimmed);
    });

    // Store prompt data for content script to pick up
    chrome.storage.local.set({
      pendingPrompt: {
        text: fullPrompt,
        instrumental,
        timestamp: Date.now()
      }
    });

    // Open Suno create page — content script will inject the prompt
    chrome.tabs.create({ url: SUNO_CREATE });
  });

  // Footer nav
  btnLibrary.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: SUNO_LIBRARY });
  });

  btnExplore.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: SUNO_EXPLORE });
  });

  btnSettings.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `${SUNO_BASE}/account` });
  });

  // Clear history
  btnClearHistory.addEventListener('click', () => {
    chrome.storage.local.remove([HISTORY_KEY], () => {
      renderHistory([]);
    });
  });

  // Click history item to reuse prompt
  historyList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    promptInput.value = li.dataset.prompt || li.textContent;
    promptInput.focus();
  });

  // Auto-save prompt as user types
  promptInput.addEventListener('input', () => {
    chrome.storage.local.set({ lastPrompt: promptInput.value });
  });

  function renderHistory(items) {
    historyList.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      const text = typeof item === 'string' ? item : item.prompt;
      li.textContent = text;
      li.dataset.prompt = text;
      li.title = text;
      historyList.appendChild(li);
    });
  }
});
