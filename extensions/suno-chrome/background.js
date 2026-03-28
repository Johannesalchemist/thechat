// Background service worker for Suno Chrome Extension

// Listen for tab updates to inject pending prompts
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;

  const isSuno = tab.url.includes('suno.com') || tab.url.includes('app.suno.ai');
  if (!isSuno) return;

  // Check for pending prompt to inject
  chrome.storage.local.get(['pendingPrompt'], (data) => {
    if (!data.pendingPrompt) return;

    // Only use prompts less than 60 seconds old
    const age = Date.now() - data.pendingPrompt.timestamp;
    if (age > 60000) {
      chrome.storage.local.remove(['pendingPrompt']);
      return;
    }

    // Send prompt to content script
    chrome.tabs.sendMessage(tabId, {
      type: 'SUNO_INJECT_PROMPT',
      prompt: data.pendingPrompt.text,
      instrumental: data.pendingPrompt.instrumental
    }).then(() => {
      // Clear pending prompt after successful injection
      chrome.storage.local.remove(['pendingPrompt']);
    }).catch(() => {
      // Content script not ready yet, will retry on next update
    });
  });
});

// Handle extension icon click when popup is not configured
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://suno.com/create' });
});
