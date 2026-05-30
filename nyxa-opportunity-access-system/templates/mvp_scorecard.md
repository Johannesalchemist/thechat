# NYXA MVP Scorecard

**Scorecard-ID:** {{scorecard_id}}  
**Erstellt:** {{timestamp}}  
**MVP-ID:** {{mvp_id}}  
**MVP-Name:** {{mvp_name}}

---

## Scoring-Übersicht

| Dimension            | Score (1–10) | Richtung       | Bewertung        |
|----------------------|--------------|----------------|------------------|
| Complexity           | {{complexity_score}} | Niedriger = besser | {{complexity_label}} |
| Revenue Potential    | {{revenue_potential_score}} | Höher = besser | {{revenue_label}} |
| Market Readiness     | {{market_readiness_score}} | Höher = besser | {{market_label}} |
| Founder Effort       | {{founder_effort_score}} | Niedriger = besser | {{effort_label}} |

**NOS Gesamt-Score:** {{nos_total}} / 40  
**Priorität:** **{{priority}}** — {{priority_label}}

---

## Score-Formel

```
NOS = revenue_potential + market_readiness + (10 - complexity) + (10 - founder_effort)
    = {{revenue_potential_score}} + {{market_readiness_score}} + (10 - {{complexity_score}}) + (10 - {{founder_effort_score}})
    = {{nos_total}}
```

---

## Begründungen

**Complexity ({{complexity_score}}/10):**  
{{complexity_rationale}}

**Revenue Potential ({{revenue_potential_score}}/10):**  
{{revenue_rationale}}

**Market Readiness ({{market_readiness_score}}/10):**  
{{market_rationale}}

**Founder Effort ({{founder_effort_score}}/10):**  
{{effort_rationale}}

---

## MVP-Details

**Beschreibung:** {{mvp_description}}  
**Jurisdiktion:** {{jurisdiction}}  
**Lieferzeit:** {{time_to_deliver_days}} Werktage  
**Preis:** {{price_usd}} USD  
**Status:** {{status}}

**Deliverables:**
{{#each deliverables}}
- {{this}}
{{/each}}

---

## Abhängigkeiten

**Alle Abhängigkeiten erfüllt:** {{#if dependencies_met}}Ja{{else}}Nein{{/if}}

**Fehlende Abhängigkeiten:**
{{#if missing_dependencies}}
{{#each missing_dependencies}}
- {{this}}
{{/each}}
{{else}}
Keine fehlenden Abhängigkeiten.
{{/if}}

---

## Blocker

{{#if blockers}}
{{#each blockers}}
- {{this}}
{{/each}}
{{else}}
Keine Blocker identifiziert.
{{/if}}

---

## Empfehlung

{{recommendation}}

**Geschätzte Implementierungszeit:** {{estimated_build_days}} Tage

---

*NYXA MVP Scorecard — Scoring nach NYXA Opportunity Score (NOS) V0.1*  
*Erstellt: {{timestamp}}*
