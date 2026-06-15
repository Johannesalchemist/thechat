// Background service worker — handles Claude API calls and Suno injection

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CLAUDE_GENERATE_PROMPT') {
    handleClaudeGenerate(message).then(sendResponse);
    return true; // Keep channel open for async response
  }
});

async function handleClaudeGenerate({ idea, style, mood, instrumental }) {
  const { anthropic_api_key, claude_model } = await chrome.storage.sync.get(['anthropic_api_key', 'claude_model']);
  if (!anthropic_api_key) {
    return { error: 'No Anthropic API key configured. Go to extension Settings.' };
  }

  const styleHint = style ? `Genre/style: ${style}.` : '';
  const moodHint = mood ? `Mood: ${mood}.` : '';
  const instrHint = instrumental
    ? 'This is instrumental only — no lyrics needed. Focus on describing the musical arrangement, instruments, tempo, and feel.'
    : 'Include suggested lyrics (1-2 verses + chorus).';

  const systemPrompt = `You are an expert music prompt engineer for Suno AI music generation. Your job is to take a user's rough idea and turn it into an optimized, detailed Suno prompt that produces great results.

Rules:
- Output valid JSON with these fields:
  "prompt": The Suno-optimized prompt string (style tags, genre, mood, instruments, tempo, vocal style)
  "lyrics": Suggested lyrics if applicable (null if instrumental)
  "title": A suggested song title
- The "prompt" field should be a concise Suno-style description (under 200 chars) that captures genre, mood, tempo, instruments, and vocal style
- Use Suno-friendly terminology: specific genre tags, BPM hints, instrument names, vocal descriptors
- Be creative but stay true to the user's intent`;

  const userMessage = `Turn this idea into an optimized Suno prompt:

Idea: ${idea}
${styleHint}
${moodHint}
${instrHint}

Respond with JSON only.`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropic_api_key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: claude_model || 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { error: `API error (${response.status}): ${errText}` };
    }

    const data = await response.json();
    const text = data.content[0].text;

    // Parse JSON from Claude's response (handle markdown code blocks)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const parsed = JSON.parse(jsonMatch[1].trim());

    return {
      prompt: parsed.prompt,
      lyrics: parsed.lyrics || null,
      title: parsed.title || null
    };
  } catch (err) {
    return { error: `Failed to call Claude: ${err.message}` };
  }
}

// Inject prompts into Suno tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;

  const isSuno = tab.url.includes('suno.com') || tab.url.includes('app.suno.ai');
  if (!isSuno) return;

  chrome.storage.local.get(['pendingPrompt'], (data) => {
    if (!data.pendingPrompt) return;

    const age = Date.now() - data.pendingPrompt.timestamp;
    if (age > 60000) {
      chrome.storage.local.remove(['pendingPrompt']);
      return;
    }

    chrome.tabs.sendMessage(tabId, {
      type: 'SUNO_INJECT_PROMPT',
      prompt: data.pendingPrompt.text,
      lyrics: data.pendingPrompt.lyrics,
      instrumental: data.pendingPrompt.instrumental
    }).then(() => {
      chrome.storage.local.remove(['pendingPrompt']);
    }).catch(() => {
      // Content script not ready, will retry on next update
    });
  });
});
