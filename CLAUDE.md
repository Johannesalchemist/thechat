# THE CHAT — Master CLAUDE.md
# Konsolidiert: Graph Agency + NYXA Kernel + Masterplan
# Version: 3.0 | 2026-03-05
# Ablage: C:\Users\Johannes\thechat\CLAUDE.md

---

## ARBEITSVERZEICHNISSE

```
HAUPT-PROJEKT:   C:\Users\Johannes\thechat\
NYXA KERNEL:     C:\Users\Johannes\nyxa-dev-agent\
GRAV/WEBSITE:    /var/www/grav  (SSH: 178.104.4.9)
```

---

## REGELN (IMMER GÜLTIG — KEINE AUSNAHME)

```
1. Sequenz einhalten          Phasen strikt in Reihenfolge
2. Directory-Check first      IF missing → Make Directory → dann weiter
3. Vollständige Dateien       Kein Fragment. Kein TODO. Kein Platzhalter.
4. Deterministischer Replace  Dateien immer komplett überschreiben
5. Fehler = STOP              Stoppen · melden · nicht fortfahren
6. Stabilität > Speed > Features
7. Gleicher Input → Gleicher Output (deterministisch)
```

---

## PROJEKTSTRUKTUR (ZIEL)

```
thechat\
  apps\
    frontend\              Next.js UI (läuft auf Docker)
  api\                     Node.js Backend (läuft auf Docker)
  agents\
    phone_agent\           PARTIAL  (Aufgabe 1)
    formation_agent\       MISSING  (Aufgabe 2)
    sales_agent\           MISSING
    telegram_agent\        MISSING  (Aufgabe 8)
    social_agent\          MISSING
    analytics_agent\       MISSING
    training_agent\        MISSING
    dashboard_agent\       MISSING
    monitor_agent\         MISSING
    tax_agent\
      elster\              MISSING  (Aufgabe 6)
      us\                  MISSING
      austria\             MISSING  (Aufgabe 7)
  core\
    nyxa_kernel.ts         OK
    event_bus.ts           OK
    event_dispatcher.ts    OK
    event_registry.ts      OK
    agent_registry.ts      OK
  graph\
    graph_nodes.json       OK
    graph_edges.json       OK
    graph_router.ts        OK
  lead_engine\             STUB
  memory\                  STUB — event_store CRITICAL
  connectors\
    phone\                 OK
    telegram\              PARTIAL
    social\                MISSING
  pipelines\               STUB
  monitoring\              PARTIAL
  data\calls\              auto-created
  reports\businessplans\
  .env
  package.json
  tsconfig.json
```

---

## ENVIRONMENT (.env — VOR ALLEM ANDEREN PRÜFEN)

```env
VAPI_API_KEY=
VAPI_ASSISTANT_ID=
WEBHOOK_URL=https://
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
STRIPE_SECRET_KEY=
MERCURY_API_KEY=
PORT=3001
NODE_ENV=development
```

CHECK vor jeder Aufgabe:
  IF .env missing → CREATE .env → STOP → Keys vom Nutzer erfragen
  IF value == "" → WARN "BLOCKED_AUTH: [KEY]" → weiter mit nächster Aufgabe

---

## AUFGABEN IN REIHENFOLGE

### AUFGABE 1 — Phone Agent STT (HEUTE, P0)

Datei: agents/phone_agent/stt_pipeline.ts

Vapi Webhook Payload-Format:
  payload.artifact.transcript = Array<{
    role: "bot" | "user"
    message: string
    time: number
    endTime: number
    secondsFromStart: number
  }>

Was tun:
  1. Parse transcript Array → TranscriptSegment[]
  2. role:"user" → speaker:"caller", role:"bot" → speaker:"agent"
  3. confidence: 1.0 als Default
  4. transcriptionStore.update(callId, { transcript: segments })
  5. processCompletedCall(callId) aufrufen

Test-Curl nach Implementierung:
  curl -X POST http://localhost:3001/phone/inbound
    -H "Content-Type: application/json"
    -d '{"callId":"test-001","from":"+4915112345678","artifact":{"transcript":[
      {"role":"user","message":"Ich interessiere mich fuer eine Delaware LLC","time":1.2,"endTime":3.1,"secondsFromStart":1.2},
      {"role":"bot","message":"Sehr gerne, welche Leistung benoetigen Sie?","time":3.5,"endTime":5.0,"secondsFromStart":3.5},
      {"role":"user","message":"Businessplan und Bankkonto eroeffnen","time":5.5,"endTime":7.2,"secondsFromStart":5.5}
    ]}}'

Erwartung: data/calls/test-001.json existiert, outcome gesetzt, Event gepusht

---

### AUFGABE 2 — Formation Agent (WOCHE 1, P1)

Erstelle: agents/formation_agent/

Dateien und Inhalt:

jurisdiction_router.ts:
  Jurisdiktionen: delaware, austria, germany, uk
  je mit: entityTypes[], filingFee, timeline_days, requirements[]

registered_agent_marketplace.ts:
  Tier 1: Harvard Business Services — $299/Jahr — same-day, attorney-network
  Tier 2: Northwest Registered Agent — $125/Jahr — standard-filing
  Tier 3: ZenBusiness — $49/Jahr — basic-compliance

entity_type_selector.ts:
  LLC / C-Corp / S-Corp / GmbH / UG / Verein / AG / Ltd / LLP

document_generator.ts:
  Articles of Incorporation Template (Delaware)
  Operating Agreement Template (Delaware LLC)
  KI-generiert via Anthropic API auf Basis von Input-Daten

ein_applicant.ts:
  Interface FormSS4 mit: legalName, entityType, stateOfFormation,
  formationDate, responsiblePartyName, responsiblePartySSN_ITIN (verschluesselt),
  reasonForApplying, primaryActivity, expectedEmployees

follow_up_scheduler.ts:
  Timeline Engine: Filing → EIN (1-4 Wochen) → Bank Account (1-3 Tage)
  Reminder Events via event_dispatcher
  Status: pending / in_progress / completed / failed

---

### AUFGABE 3 — Business Plan Generator (WOCHE 1, P1)

Datei: agents/formation_agent/business_plan_generator.ts

Input: { industry, idea, targetMarket, budget, founders[], jurisdiction, language:"de"|"en" }

Ablauf:
  1. Anthropic API Call — System Prompt fordert JSON mit Sections:
     executiveSummary, marketAnalysis, businessModel,
     financialProjections, competitiveAnalysis, risks
  2. JSON parsen
  3. DOCX generieren (npm: docx) — professionelles Format
  4. Speichern: reports/businessplans/{timestamp}_{name}.docx
  5. Return: { filePath, executiveSummary }

Preis standalone: 99 EUR (Stripe Checkout Link generieren)

---

### AUFGABE 4 — Memory Event Store (WOCHE 1, CRITICAL)

Datei: memory/event_store.ts

npm install better-sqlite3 @types/better-sqlite3

Schema:
  events(id TEXT PK, type TEXT, source TEXT, payload TEXT, timestamp INTEGER)
  conversations(id TEXT PK, callId TEXT, transcript TEXT, created INTEGER)
  leads(id TEXT PK, source TEXT, score INTEGER, outcome TEXT, data TEXT, created INTEGER)

Ersetze alle STUBs in memory/ mit echten SQLite-Implementierungen

---

### AUFGABE 5 — Delaware Filing Automation (WOCHE 2, P2)

Datei: agents/formation_agent/state_filing.ts

npm install playwright && npx playwright install chromium

Target: https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx

Schritte:
  1. Name Availability Check
  2. Articles of Incorporation formular auto-fill
  3. Registered Agent aus Marketplace eintragen
  4. Stripe Payment trigger (Filing Fee: $90)
  5. Certificate PDF download → data/formations/{entityId}/certificate.pdf
  6. EIN Applicant triggern nach erfolgreichem Filing

---

### AUFGABE 6 — ELSTER Agent (WOCHE 3, P3)

Erstelle: agents/tax_agent/elster/

ERiC Bibliothek: https://www.elster.de/elsterweb/softwareprodukt/eric
Einbinden via child_process (eric CLI) oder node-ffi

Dateien:
  elster_xml_generator.ts  → ERiC-kompatibles XML fuer UStVA
  umsatzsteuer_agent.ts    → UStVA Interface + auto-fill
    Input: { steuernummer, jahr, monat, umsaetze_19, umsaetze_7, vorsteuer }
  gewerbesteuer_agent.ts   → GewSt Interface
  elster_submit.ts         → HTTP Submit an ELSTER Server + Beleg-Download

---

### AUFGABE 7 — Oesterreich Verein (WOCHE 3, P3)

Erstelle: agents/formation_agent/austria/

verein_generator.ts:
  Input: { name, zweck, sitz, obmann, kassier, schriftfuehrer,
           gruendungsdatum, mitgliedsbeitrag, gemeinnuetzig }
  Output: Statuten-DOCX (KI-generiert) + ZVR-Anmeldeformular-PDF

zvr_filing.ts:
  ZVR = Zentrales Vereinsregister Oesterreich
  Formular-Auto-Fill fuer Vereinsanmeldung

Preis: 199 EUR

---

### AUFGABE 8 — Telegram Agent (WOCHE 2, P2)

Datei: connectors/telegram/telegram_bot.ts

npm install node-telegram-bot-api @types/node-telegram-bot-api

Erweitern:
  Eingehende Nachrichten → lead_detected Event emittieren
  Keywords triggern Auto-Reply: "gruendung", "llc", "businessplan", "delaware"
  Gruppen-Listener → Lead-Aggregation
  Jede Konversation → conversation_store speichern

---

## NYXA KERNEL (separates Fenster)

```
Pfad:  C:\Users\Johannes\nyxa-dev-agent
Stand: v1.5.0 — Genesis-Anchor aktiv
CLAUDE.md bleibt dort getrennt

Verbindung zu thechat:
  execSync("node C:/Users/Johannes/nyxa-dev-agent/agent/dist/cli.js kernel-validate")

Naechste Kernel-Schritte (nach thechat P1 abgeschlossen):
  B) Merkle-Tree Snapshot
  C) Multi-Kernel Registry
  D) Policy Layer
```

---

## GRAV (SSH 178.104.4.9)

```
Nach jeder Aenderung:
  sudo -u www-data php bin/grav clearcache
  sudo systemctl restart php8.1-fpm
  sudo chown -R www-data:www-data /var/www/grav

KRITISCH:
  assets.css() immer mit () aufrufen
  page.content immer mit |raw
  Komplette Dateien ersetzen — keine Fragmente
```

---

## DOCKER

```bash
cd C:\Users\Johannes\thechat\infra
docker compose down && docker compose up --build -d
docker compose logs -f
# Frontend: http://localhost:3000
# API:      http://localhost:3001
```

---

## SERVICE PAKETE (fuer Pricing-Logik in Agents)

```
Starter    $149   Delaware LLC + RA + EIN + Operating Agreement
Growth     $299   + Premium RA + Mercury Bank + Business Plan + Phone Onboarding
Pro        $499   + Cap Table + Steuer Jahr 1 + Annual Report + Reorg Session
Enterprise $999+  Multi-Jurisdiktion + ELSTER + White-Label API

Add-Ons:
  AT Verein      199 EUR
  AT GmbH        499 EUR
  UK Ltd         199 USD
  ELSTER Jahres  149 EUR/Jahr
  Businessplan    99 EUR standalone
  Reorg Paket    799 EUR
```

---

## PRIORITAETS-MATRIX

```
P0 SOFORT    .env befuellen · Aufgabe 1 Phone Agent
P1 WOCHE 1   Aufgabe 2 Formation Agent · Aufgabe 3 Business Plan · Aufgabe 4 Memory
P2 WOCHE 2   Aufgabe 5 Delaware Filing · Aufgabe 8 Telegram · Stripe
P3 WOCHE 3   Aufgabe 6 ELSTER · Aufgabe 7 Oesterreich · Dashboard
P4 MONAT 2   Cap Table · Multi-Bank · White-Label API · Steuerberater-Marketplace
```

---

## START

Erste Eingabe:
  Prüfe .env auf Vollständigkeit, dann führe Aufgabe 1 aus.
