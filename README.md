# THE CHAT — Nyxa Knowledge Platform
# Version 1.0 | Stand: 2026-03-05

## Systemarchitektur

```
INTERFACE LAYER    → Control Room (3D) · Dev Console · Grav CMS
NYXA KERNEL        → Event Bus · Command Runner · World Model
CODEX SYSTEM       → Agent Factory · Marketplace · Codex Temple
KNOWLEDGE GRAPH    → Concepts · Relations · Entities
DATA LAYER         → world.json · agents.json · graph.json
```

## Verzeichnisstruktur

| Pfad                          | Funktion                           |
|-------------------------------|-------------------------------------|
| nyxa/kernel/                  | Kernel Core (PHP)                  |
| nyxa/events/                  | Event Bus                          |
| nyxa/commands/                | Command Runner                     |
| nyxa/world/                   | World Model                        |
| nyxa/data/                    | Persistente Daten (JSON)           |
| nyxa/ontology/                | Entity Types, Relations            |
| codex/agent-factory/          | Agent Factory                      |
| codex/agent-marketplace/      | Agent Marketplace                  |
| apps/control-room/            | 3D Dashboard                       |
| apps/console/api/             | Dev API (Node.js)                  |
| grav/user/pages/              | Content (Grav CMS)                 |
| data/                         | Knowledge Graph, Dreams, Council   |
| builder/config/               | Projektkonfiguration               |

## Starten

### Nyxa Kernel testen
```bash
php nyxa/start.php
```

### Control Room (Standalone)
```bash
cd apps/control-room
python -m http.server 8080
# → http://localhost:8080
```

### Dev Console API
```bash
cd apps/console/api
npm install && node server.js
# → http://localhost:3000
```

## Entwicklungsphasen

| Phase | Modul             | Status      |
|-------|-------------------|-------------|
| 1     | Nyxa Kernel       | ✅ v1.0     |
| 2     | Knowledge Graph   | pending     |
| 3     | Agent System      | pending     |
| 4     | Civilization      | pending     |
| 5     | Evolution Engine  | pending     |
| 6     | Control Room Full | ✅ v1.0     |

## Regeln für Weiterentwicklung

1. Alle neuen Module beginnen mit Phase-0-Check
2. Commandlet-Prinzip — keine impliziten Mechanismen
3. Vollständige Dateien — keine Fragmente
4. Verifikationsschritt nach jeder Phase
