# Suno + Claude — AI Music Prompter

Chrome extension that uses **Claude AI** to generate optimized music prompts for **Suno**, then sends them directly to Suno's create page.

## Features

- **Claude-Powered Prompts** — Describe your idea in plain language, Claude crafts an optimized Suno prompt with style tags, genre, BPM, instruments, and vocal descriptors
- **Lyrics Generation** — Claude writes lyrics (verses + chorus) when not in instrumental mode
- **Auto-Inject** — Generated prompts are automatically filled into Suno's create page
- **Style & Mood Presets** — 16 genres and 10 moods to guide Claude's output
- **Prompt History** — Recent prompts saved locally for quick reuse
- **Model Selection** — Choose between Claude Haiku (fast), Sonnet (balanced), or Opus (best)

## Installation

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select `extensions/suno-chrome`
4. Click the extension icon → **Settings** → add your Anthropic API key

## Usage

1. Click the Suno+Claude icon in your toolbar
2. Type your song idea (e.g. "chill lo-fi beat for studying")
3. Optionally pick a style and mood
4. Click **Ask Claude to Write Prompt**
5. Review Claude's optimized prompt and lyrics
6. Click **Send to Suno** — opens Suno with everything pre-filled

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (Manifest V3) |
| `popup.html/css/js` | Toolbar popup UI |
| `background.js` | Service worker — Claude API calls + tab management |
| `content.js/css` | Content script for prompt injection on suno.com |
| `options.html` | Settings page for API key and model selection |
