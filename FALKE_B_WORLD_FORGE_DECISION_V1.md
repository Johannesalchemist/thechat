# Falke B World Forge Architecture Decision
Status: ARCHITECTURE DECISION — DRAFT

## Overview

- A = NYXA Core / Live-System
- B = Falke B / Governance + zukünftiger World Forge Node

## Confirmed

- Governance Layer
- Audit
- Confidence
- Safety

## Not Found

- World Generator
- Quest Engine
- NPC Runtime
- Edutainment Assets

## Decision
Falke B wird als Zielknoten für World Forge / Edutainment Generation vorgesehen.

World Forge ist aktuell **nicht deployed** und **nicht runtime-verifiziert**. Diese Entscheidung beschreibt ausschließlich die geplante Zielarchitektur.

## A/B Ownership Boundaries

### A — NYXA Core
Verantwortlich für:

- Live-Systeme
- Öffentliche Frontends
- n8n Workflows
- APIs
- Bots
- Veröffentlichung von Inhalten
- Nutzerinteraktionen

### B — Falke B
Verantwortlich für:

- Governance Layer
- Audit Layer
- Confidence Layer
- Safety Layer
- World Template Registry
- World Generation
- Quest Generation
- NPC Generation
- Simulationen
- Coherence Testing
- Export Packages

## Phases

1. Governance Layer vorhanden
2. World Template Registry
3. World Generator API
4. Quest/NPC Generator
5. Simulation + Coherence Testing
6. Export Package Generation
7. Übergabe an A zur Veröffentlichung

## Publication Rule
In V1 erfolgt keine automatische Veröffentlichung.

Ablauf:

1. Welt auf B erzeugen
2. Governance-Prüfung auf B
3. Review Status vergeben
4. Menschliche Freigabe
5. Export Package erzeugen
6. Übergabe an A
7. Veröffentlichung durch bestehende Systeme auf A

## Notes

- Keine Serveränderung
- Kein Deployment
- Keine Runtime-Aktion
- Nur Dokumentation
- Keine Production-Ready-Aussage
- Keine automatisierte Veröffentlichung
