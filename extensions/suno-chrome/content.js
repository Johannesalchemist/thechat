// Content script for Suno pages — handles prompt + lyrics injection from Claude

(function () {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'SUNO_INJECT_PROMPT') return;
    injectPrompt(message.prompt, message.lyrics, message.instrumental);
    sendResponse({ success: true });
  });

  // Check for pending prompt on page load
  chrome.storage.local.get(['pendingPrompt'], (data) => {
    if (!data.pendingPrompt) return;

    const age = Date.now() - data.pendingPrompt.timestamp;
    if (age > 60000) {
      chrome.storage.local.remove(['pendingPrompt']);
      return;
    }

    waitForElement('textarea, [contenteditable="true"], input[type="text"]', 10000)
      .then(() => {
        injectPrompt(
          data.pendingPrompt.text,
          data.pendingPrompt.lyrics,
          data.pendingPrompt.instrumental
        );
        chrome.storage.local.remove(['pendingPrompt']);
      })
      .catch(() => {});
  });

  function injectPrompt(prompt, lyrics, instrumental) {
    // Find the main prompt/description textarea
    const promptSelectors = [
      'textarea[placeholder*="song"]',
      'textarea[placeholder*="describe"]',
      'textarea[placeholder*="prompt"]',
      'textarea[placeholder*="style"]',
      'textarea',
    ];

    let promptInjected = false;
    for (const selector of promptSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        setInputValue(el, prompt);
        promptInjected = true;
        break;
      }
    }

    // If there are lyrics and a separate lyrics textarea, inject there too
    if (lyrics && !instrumental) {
      const allTextareas = document.querySelectorAll('textarea');
      if (allTextareas.length > 1) {
        // Second textarea is typically for lyrics
        setInputValue(allTextareas[1], lyrics);
      }
    }

    // Toggle instrumental if needed
    if (instrumental) {
      const instrumentalSelectors = [
        'button[aria-label*="nstrumental"]',
        '[data-testid*="instrumental"]',
        'label:has(input[type="checkbox"])'
      ];

      for (const selector of instrumentalSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          break;
        }
      }
    }

    // Visual feedback
    if (promptInjected) {
      showNotification('Claude prompt injected into Suno!');
    }
  }

  function setInputValue(el, value) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.contentEditable === 'true') {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.focus();
  }

  function showNotification(text) {
    const note = document.createElement('div');
    note.textContent = text;
    Object.assign(note.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      background: 'linear-gradient(135deg, #d4a574, #c4956a)',
      color: '#1a1a2e',
      padding: '10px 18px',
      borderRadius: '8px',
      fontSize: '13px',
      fontWeight: '600',
      zIndex: '999999',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      transition: 'opacity 0.3s ease'
    });
    document.body.appendChild(note);
    setTimeout(() => {
      note.style.opacity = '0';
      setTimeout(() => note.remove(), 300);
    }, 3000);
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
        reject(new Error('Timeout'));
      }, timeout);
    });
  }
})();
