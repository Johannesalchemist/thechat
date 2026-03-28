// Content script for Suno pages — handles prompt injection

(function () {
  // Listen for prompt injection messages from background
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'SUNO_INJECT_PROMPT') return;

    injectPrompt(message.prompt, message.instrumental);
    sendResponse({ success: true });
  });

  // Also check for pending prompt on load
  chrome.storage.local.get(['pendingPrompt'], (data) => {
    if (!data.pendingPrompt) return;

    const age = Date.now() - data.pendingPrompt.timestamp;
    if (age > 60000) {
      chrome.storage.local.remove(['pendingPrompt']);
      return;
    }

    // Wait for page to be interactive
    waitForElement('textarea, [contenteditable="true"], input[type="text"]', 10000)
      .then(() => {
        injectPrompt(data.pendingPrompt.text, data.pendingPrompt.instrumental);
        chrome.storage.local.remove(['pendingPrompt']);
      })
      .catch(() => {
        // Element not found within timeout
      });
  });

  function injectPrompt(text, instrumental) {
    // Try common input selectors on Suno's create page
    const selectors = [
      'textarea[placeholder*="song"]',
      'textarea[placeholder*="describe"]',
      'textarea[placeholder*="prompt"]',
      'textarea',
      '[contenteditable="true"]',
      'input[type="text"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        setInputValue(el, text);
        break;
      }
    }

    // Try to toggle instrumental if requested
    if (instrumental) {
      const instrumentalSelectors = [
        'button[aria-label*="nstrumental"]',
        'label:has(input[type="checkbox"])',
        '[data-testid*="instrumental"]'
      ];

      for (const selector of instrumentalSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          break;
        }
      }
    }
  }

  function setInputValue(el, value) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // Use native input setter to trigger React's onChange
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype,
        'value'
      ).set;
      nativeInputValueSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.contentEditable === 'true') {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.focus();
  }

  function waitForElement(selector, timeout) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timeout waiting for element'));
      }, timeout);
    });
  }
})();
