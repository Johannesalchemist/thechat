const SUNO_BASE = 'https://suno.com';
const SUNO_CREATE = 'https://suno.com/create';
const SUNO_LIBRARY = 'https://suno.com/me';
const SUNO_EXPLORE = 'https://suno.com/explore';
const HISTORY_KEY = 'suno_prompt_history';
const MAX_HISTORY = 20;

let lastClaudeResult = null;

document.addEventListener('DOMContentLoaded', () => {
  const btnOpenSuno = document.getElementById('btn-open-suno');
  const btnCreateSong = document.getElementById('btn-create-song');
  const btnClaudeGenerate = document.getElementById('btn-claude-generate');
  const btnSendToSuno = document.getElementById('btn-send-to-suno');
  const btnRegenerate = document.getElementById('btn-regenerate');
  const btnCopy = document.getElementById('btn-copy');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const btnLibrary = document.getElementById('btn-library');
  const btnExplore = document.getElementById('btn-explore');
  const btnSettings = document.getElementById('btn-settings');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const apiKeyWarning = document.getElementById('api-key-warning');
  const ideaInput = document.getElementById('idea-input');
  const instrumentalToggle = document.getElementById('instrumental-toggle');
  const styleSelect = document.getElementById('style-select');
  const moodSelect = document.getElementById('mood-select');
  const claudeOutputSection = document.getElementById('claude-output-section');
  const claudeOutput = document.getElementById('claude-output');
  const claudeLyrics = document.getElementById('claude-lyrics');
  const loadingEl = document.getElementById('loading');
  const historyList = document.getElementById('history-list');

  // Check API key on load
  chrome.storage.sync.get(['anthropic_api_key'], (data) => {
    if (!data.anthropic_api_key) {
      apiKeyWarning.style.display = 'block';
      btnClaudeGenerate.disabled = true;
    }
  });

  // Load saved state
  chrome.storage.local.get(['lastIdea', 'instrumental', 'style', 'mood', HISTORY_KEY], (data) => {
    if (data.lastIdea) ideaInput.value = data.lastIdea;
    if (data.instrumental) instrumentalToggle.checked = data.instrumental;
    if (data.style) styleSelect.value = data.style;
    if (data.mood) moodSelect.value = data.mood;
    renderHistory(data[HISTORY_KEY] || []);
  });

  // Quick actions
  btnOpenSuno.addEventListener('click', () => {
    chrome.tabs.create({ url: SUNO_BASE });
  });

  btnCreateSong.addEventListener('click', () => {
    chrome.tabs.create({ url: SUNO_CREATE });
  });

  // Claude generate
  btnClaudeGenerate.addEventListener('click', () => generateWithClaude());
  btnRegenerate.addEventListener('click', () => generateWithClaude());

  async function generateWithClaude() {
    const idea = ideaInput.value.trim();
    if (!idea) {
      ideaInput.focus();
      return;
    }

    const style = styleSelect.value;
    const mood = moodSelect.value;
    const instrumental = instrumentalToggle.checked;

    // Save state
    chrome.storage.local.set({ lastIdea: idea, instrumental, style, mood });

    // Show loading
    loadingEl.style.display = 'flex';
    claudeOutputSection.style.display = 'none';
    btnClaudeGenerate.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CLAUDE_GENERATE_PROMPT',
        idea,
        style,
        mood,
        instrumental
      });

      if (result.error) {
        claudeOutput.textContent = `Error: ${result.error}`;
        claudeOutputSection.style.display = 'block';
        return;
      }

      lastClaudeResult = result;
      claudeOutput.textContent = result.prompt;

      if (result.lyrics && !instrumental) {
        claudeLyrics.textContent = result.lyrics;
        claudeLyrics.style.display = 'block';
      } else {
        claudeLyrics.style.display = 'none';
      }

      claudeOutputSection.style.display = 'block';

      // Save to history
      saveToHistory({
        idea,
        prompt: result.prompt,
        style,
        mood,
        instrumental,
        timestamp: Date.now()
      });
    } catch (err) {
      claudeOutput.textContent = `Error: ${err.message}`;
      claudeOutputSection.style.display = 'block';
    } finally {
      loadingEl.style.display = 'none';
      btnClaudeGenerate.disabled = false;
    }
  }

  // Send to Suno
  btnSendToSuno.addEventListener('click', () => {
    if (!lastClaudeResult) return;

    const instrumental = instrumentalToggle.checked;
    const fullText = lastClaudeResult.lyrics && !instrumental
      ? `${lastClaudeResult.prompt}\n\n${lastClaudeResult.lyrics}`
      : lastClaudeResult.prompt;

    chrome.storage.local.set({
      pendingPrompt: {
        text: lastClaudeResult.prompt,
        lyrics: lastClaudeResult.lyrics || null,
        instrumental,
        timestamp: Date.now()
      }
    });

    chrome.tabs.create({ url: SUNO_CREATE });
  });

  // Copy to clipboard
  btnCopy.addEventListener('click', () => {
    if (!lastClaudeResult) return;
    const instrumental = instrumentalToggle.checked;
    const text = lastClaudeResult.lyrics && !instrumental
      ? `${lastClaudeResult.prompt}\n\n--- Lyrics ---\n${lastClaudeResult.lyrics}`
      : lastClaudeResult.prompt;
    navigator.clipboard.writeText(text);
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
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

  const openSettings = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  btnSettings.addEventListener('click', openSettings);
  btnOpenSettings.addEventListener('click', openSettings);

  // Clear history
  btnClearHistory.addEventListener('click', () => {
    chrome.storage.local.remove([HISTORY_KEY], () => renderHistory([]));
  });

  // Click history item to reuse
  historyList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    ideaInput.value = li.dataset.idea || li.textContent;
    ideaInput.focus();
  });

  // Auto-save idea as user types
  ideaInput.addEventListener('input', () => {
    chrome.storage.local.set({ lastIdea: ideaInput.value });
  });

  function saveToHistory(entry) {
    chrome.storage.local.get([HISTORY_KEY], (data) => {
      const history = data[HISTORY_KEY] || [];
      history.unshift(entry);
      const trimmed = history.slice(0, MAX_HISTORY);
      chrome.storage.local.set({ [HISTORY_KEY]: trimmed });
      renderHistory(trimmed);
    });
  }

  function renderHistory(items) {
    historyList.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      const idea = typeof item === 'string' ? item : (item.idea || item.prompt);
      li.textContent = idea;
      li.dataset.idea = idea;
      li.title = item.prompt || idea;
      historyList.appendChild(li);
    });
  }
});
