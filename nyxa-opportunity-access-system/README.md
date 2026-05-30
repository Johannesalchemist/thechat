# NYXA Opportunity & Access System V0.1

**System:** NYXA Opportunity & Access  
**Version:** 0.1  
**Stand:** 2026-05-30  
**Status:** Ampel GELB → GRÜN nach vollständiger Datei-Erstellung

---

## Zweck

Das NYXA Opportunity & Access System identifiziert, bewertet und priorisiert
Marktchancen für Gründer auf Basis strukturierter Katalog-, Scoring- und
Governance-Daten. Es ist ein statisches Wissenssystem ohne API-Calls,
ohne externe Connector-Aktivierung und ohne Outreach-Automation.

---

## Verzeichnisstruktur

```
nyxa-opportunity-access-system/
├── README.md                        Dieses Dokument
├── data/
│   ├── mvp_catalog.json             Mindestens 12 MVPs mit Scoring-Metadaten
│   ├── platform_matrix.json         Mindestens 12 Plattformen mit Parametern
│   ├── connector_catalog.json       Mindestens 10 Connector-/Tooltypen
│   ├── founder_access_taxonomy.json Gründer-Zugangstaxonomie
│   ├── scoring_rules.json           Scoring-Regeln für Opportunity-Bewertung
│   ├── governance_rules.json        Governance-Regeln und Betriebsgrenzen
│   └── self_hosting_matrix.json     Self-Hosting-Optionen je Komponente
├── prompts/
│   ├── opportunity_scan.md          Prompt: Marktchancen-Scan
│   ├── mvp_evaluation.md            Prompt: MVP-Bewertung
│   └── access_assessment.md         Prompt: Zugangs-Assessment
├── templates/
│   ├── opportunity_report.md        Template: Opportunity-Report
│   ├── mvp_scorecard.md             Template: MVP-Scorecard
│   └── access_plan.md               Template: Zugangspfad-Plan
└── reports/                         Ausgabeverzeichnis (leer bei Init)
```

---

## Geltungsbereich V0.1

- **IN SCOPE:** Statische Katalog-, Prompt-, Template- und Governance-Dateien
- **OUT OF SCOPE:** API-Calls, Connector-Aktivierung, Outreach-Automation,
  personenbezogene Datensammlung, Production-Deployments

---

## Betriebsgrenzen

- Keine Förder-, Kredit- oder Einkommensgarantien
- Keine automatische Outreach-Aktivierung
- Keine echten Connector-Ausführungen in V0.1
- Keine API-Keys gespeichert

---

## Naming-Konvention

- System-Name: **NYXA** (konsistent, kein Alias)
- Interne Referenz: `nyxa-opportunity-access-system`
- Version-Tag: `v0.1`
