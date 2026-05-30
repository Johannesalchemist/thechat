# NYXA Opportunity Report

**Report-ID:** {{report_id}}  
**Erstellt:** {{timestamp}}  
**Lead-ID:** {{lead_id}}  
**Kanal:** {{channel}}  
**Sprache:** {{language}}

---

## 1. Executive Summary

**Gründer-Archetype:** {{founder_archetype_name}}  
**Lead-Score:** {{lead_score}} / 100 — **{{lead_tier}}**  
**Empfohlenes Paket:** {{recommended_package}} ({{price_usd}} USD)  
**Access Level:** {{access_level_name}}  
**Konversions-Wahrscheinlichkeit:** {{conversion_probability}}

---

## 2. Identifizierte Opportunities

| Rang | MVP | Bezeichnung | Match | Preis |
|------|-----|-------------|-------|-------|
{{#each opportunities}}
| {{this.priority_rank}} | {{this.mvp_id}} | {{this.mvp_name}} | {{this.match_confidence_pct}}% | {{this.price_usd}} USD |
{{/each}}

**Primäre Opportunity:** {{primary_opportunity_name}}  
**Begründung:** {{primary_opportunity_reason}}

---

## 3. Upsell-Pipeline

{{#each upsell_opportunities}}
- **{{this.mvp_name}}** ({{this.mvp_id}}): {{this.trigger_condition}}
{{/each}}

---

## 4. Touchpoint-Plan

{{#each touchpoints}}
**Schritt {{this.step}} — {{this.timing}}**  
- Aktion: {{this.action}}  
- Kanal: {{this.channel}}  
- Automatisiert: {{#if this.automated}}Ja{{else}}Nein{{/if}}

{{/each}}

---

## 5. Friction Points & Mitigationen

{{#each friction_points}}
**Hürde:** {{this.point}}  
**Mitigation:** {{this.mitigation}}

{{/each}}

---

## 6. Compliance-Hinweise

{{#if compliance_flags}}
{{#each compliance_flags}}
- {{this}}
{{/each}}
{{else}}
Keine besonderen Compliance-Hinweise für diese Opportunity.
{{/if}}

---

## 7. Nächste Aktion

**{{next_action}}**

---

*Dieser Report ist informatorisch. NYXA gibt keine Rechts-, Steuer- oder Anlageberatung.*  
*Keine Förder-, Kredit- oder Einkommensgarantien.*  
*NYXA Opportunity & Access System V0.1 — {{timestamp}}*
