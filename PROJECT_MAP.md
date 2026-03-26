# PROJECT MAP — Johannes / Nyxa
_Last updated: 2026-03-20_

---

## Overview

Three related but separate projects, running across two servers and one local Windows machine.

| Project | Where | Purpose |
|---|---|---|
| **Nyxa Chat / The Room** | Server 2 (46.225.239.128) | Multi-agent AI chat platform |
| **Nyxa Kernel** | Local + Server 2 | Core logic, agent runtime, knowledge graph |
| **InCMS Migration** | Server 1 (178.104.4.9) | Static site exports from InCMS, served via Caddy |

---

## Server 1 — 178.104.4.9 (InCMS / Caddy)

**Access:** `ssh deploy@178.104.4.9`
**Webserver:** Caddy v2.11 (systemd, `systemctl status caddy`)
**Caddyfile:** Managed locally at `C:\Users\Johannes\Caddyfile`, deployed to server

### What runs here

**InCMS Static Exports** — `/var/www/incms-scrape/`
Scraped with `wget --mirror` from InCMS subdomains, served as static HTML via Caddy.

| Slug | Source URL | Live Domain |
|---|---|---|
| mediation-jarzambek | 1mediation.incms.net | www.mediation-jarzambek.de |
| happyhavenhouse | happyhavenhouse2.incms.net | www.happyhavenhouse.com |
| missilia | www.missilia.de | missilia.de |
| ganzheitliche-psychotherapie | psychologischeberatung.incms.net | www.ganzheitliche-psychotherapie-leipzig.de |
| clausen | birger.incms.net | www.clausen.es |
| schreinerei-lambertz | schreinereilambertz.incms.net | staging.schreinerei-lambertz.de |
| schreinerei-steeger | steeger2.incms.net | staging.schreinerei-steeger.de |
| wemakeyouhappy | wmyh.incms.net | staging.wemakeyouhappy.de |
| arjuns-odyssey | base.incms.net | staging.arjuns-odyssey.de |
| future24 | zukunftacademy.incms.net | staging.future24.eu |
| digitalleria | (direct) | www.digitalleria.com |

**Grav CMS** — `/var/www/grav-platform/`
- `grav-core` → webdesign-heilbronn.com
- `incms-portal` → dashboard.webdesign-heilbronn.com

**Other**
- `/var/www/guenstig-finanzieren.com/` → guenstig-finanzieren.com (Phalcon/PHP)
- `/var/www/backstop-report/` → port 8082 (visual regression reports)
- Port 8081 → browse `/var/www/incms-scrape/` (internal)

### Re-scraping a site
```bash
ssh deploy@178.104.4.9 "wget --mirror --convert-links --adjust-extension \
  --page-requisites --no-parent --no-host-directories \
  --directory-prefix=/var/www/incms-scrape/[slug] \
  --timeout=30 --tries=3 --wait=1 --user-agent='Mozilla/5.0' \
  [SOURCE_URL] 2>&1 | tee /var/www/incms-scrape/[slug]/wget.log"
```

---

## Server 2 — 46.225.239.128 (Nyxa Platform / The Chat)

**Access:** `ssh root@46.225.239.128`
**Working dir:** `/opt/thechat/`
**Process manager:** PM2

### PM2 Processes

| ID | Name | Script | Port | Purpose |
|---|---|---|---|---|
| 0 | nyxa-api | apps/console/api/server.js | 3000 | Main API + Room backend |
| 1 | nyxa-bot | apps/telegram/bot.js | — | Telegram bot (Nyxa Phone Agent) |
| 2 | nyxa-dev-agent | apps/dev-agent/index.js | 3001 | Dev task queue worker |

```bash
pm2 list          # status
pm2 logs nyxa-api --lines 50
pm2 restart nyxa-api
```

### Environment — `/opt/thechat/.env`
```
TELEGRAM_TOKEN=...
ANTHROPIC_KEY=...       ← needs active credits (claude-sonnet-4-6)
NYXA_API=http://localhost:3000
ELEVENLABS_API_KEY=...
```

### Directory Structure

```
/opt/thechat/
├── apps/
│   ├── console/api/server.js   ← nyxa-api main file (all REST endpoints)
│   ├── dashboard/              ← static frontend (served at /dashboard)
│   │   └── room.html           ← "The Room" multi-agent chat UI
│   ├── core/                   ← conversationEngine, phoneAgent, rooms
│   ├── llm/                    ← llmService.js (Anthropic API calls)
│   ├── memory/                 ← per-user conversation history
│   ├── resonance/              ← resonanceEngine (emotional layer)
│   ├── rooms/                  ← roomsService.js (Mystik/Mythos/System/Programm/Integrity)
│   ├── telegram/bot.js         ← Telegram long-poll bot
│   └── dev-agent/              ← autonomous dev task agent
├── codex/
│   ├── agent-factory/storage/agents.json
│   └── knowledge-graph/
├── data/
│   ├── leads/leads.json
│   ├── events/events.json
│   ├── orchestrator/runs.json
│   └── dev-agent/tasks.json
├── nyxa/                       ← Nyxa kernel (PHP), world model
├── ecosystem.config.cjs        ← PM2 config
└── .env
```

### The Room — `/opt/thechat/apps/dashboard/room.html`

Multi-agent chat UI at `http://46.225.239.128/dashboard/room.html`

**8 Room Agents** (defined in `server.js` as `ROOM_AGENTS`):

| Key | Name | Type | Color |
|---|---|---|---|
| sophia | Sophia | GuideAgent | #a78bfa |
| mentor | Mentor | TeacherAgent | #22d3ee |
| runner | Runner | MediatorAgent | #fb923c |
| oracle | Oracle | OracleAgent | #fbbf24 |
| archivist | Archivist | ArchivistAgent | #2dd4bf |
| codex | Codex | KnowledgeAgent | #60a5fa |
| nyxadev | NyxaDev | DevAgent | #4ade80 |
| claudecode | Claude Code | DevAgent | #f97316 |

**Orchestrator:** Claude Haiku picks 1-3 agents per message. Agents see shared room history.

**TTS:** ElevenLabs voices per agent, proxied via `/api/tts`.

**Key API endpoints:**
```
GET  /api/room/agents       → list agents
POST /api/room/message      → send message, get agent responses
GET  /api/room/history      → full chat history (in-memory, resets on restart)
DELETE /api/room/clear      → clear history
POST /api/tts               → ElevenLabs TTS proxy
GET  /api/status            → kernel status
GET  /api/agents            → codex agent factory list
GET  /api/leads             → lead engine
```

### Telegram Bot

`apps/telegram/bot.js` — "Nyxa Phone Agent"
- Long-polls Telegram API
- Routes `/start`, `/help`, `/status`, `/agents`, `/join`, `/leads`, `/room`, `/rooms`
- Uses `conversationEngine.js` → `llmService.js` (Anthropic)
- System prompt in `apps/core/phoneAgent.js` — replies in user's language (German/English)
- Rooms: Mystik / Mythos / System / Programm / Integrity (switchable per user)

---

## Local Machine — C:\Users\Johannes\ (Windows 11)

Development workspace and config management.

| Path | Purpose |
|---|---|
| `~/thechat/` | Working copy / source for Server 2 deployment |
| `~/nyxa-kernel/` | Local Nyxa kernel (TypeScript, compiled to dist/) |
| `~/nyxa-kernel-runtime/` | Runtime layer for kernel |
| `~/nyxa-platform/` | Larger platform codebase (agents, backend, core, design-system) |
| `~/Caddyfile` | Caddy config for Server 1 (deploy after changes) |
| `~/dashboard/` | Local dashboard assets |

### Deploying changes to Server 2
```bash
# Copy a file to server
scp ~/thechat/apps/console/api/server.js root@46.225.239.128:/opt/thechat/apps/console/api/server.js
pm2 restart nyxa-api

# Or edit directly on server, then restart
ssh root@46.225.239.128 "pm2 restart nyxa-api"
```

---

## Known Issues & History

| Date | Issue | Status |
|---|---|---|
| 2026-03-20 | Sara la Kali (ElevenLabs ConvAI guest agent) added to room.html — blocked agents sidebar from rendering | Fixed — removed, backup at room.html.bak |
| 2026-03-20 | Anthropic API key out of credits → Room agents silent, bot returns fallback | Needs credit top-up at console.anthropic.com |
| 2026-03-20 | Telegram bot "socket hang up" on long poll | Intermittent, not a block — bot recovers automatically |
| ongoing | InCMS scraping: 10 sites, some still on staging subdomains | In progress |

---

## How The Projects Relate

```
InCMS Migration (Server 1)
  → Static exports of client websites
  → Served via Caddy on custom domains
  → Independent of Nyxa

Nyxa Kernel (local + Server 2)
  → Core intelligence layer: agents, knowledge graph, world model, event memory
  → Powers both The Chat (Room) and the Telegram bot

The Chat / The Room (Server 2)
  → Frontend: room.html multi-agent UI
  → Backend: nyxa-api (Express, port 3000)
  → Three processes: api + bot + dev-agent
  → Depends on: Anthropic API (agents), ElevenLabs (TTS), Telegram API (bot)
```
