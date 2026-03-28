# Suno Chrome Extension

Quick access to [Suno](https://suno.com) AI music generation from your browser toolbar.

## Features

- **Quick Launch** — Open Suno or jump straight to the create page
- **Prompt Builder** — Write song prompts with style presets and instrumental toggle
- **Auto-Inject** — Prompts are automatically filled into Suno's create page
- **Prompt History** — Recent prompts saved locally for quick reuse

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extensions/suno-chrome` directory

## Usage

1. Click the Suno icon in your toolbar
2. Type a song prompt and select options
3. Click **Generate with Suno** — opens Suno with your prompt pre-filled
4. Click any history item to reuse a previous prompt

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (Manifest V3) |
| `popup.html/css/js` | Toolbar popup UI |
| `background.js` | Service worker for tab management |
| `content.js/css` | Content script for prompt injection on suno.com |
