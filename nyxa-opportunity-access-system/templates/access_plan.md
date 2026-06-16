# NYXA Zugangspfad-Plan

**Plan-ID:** {{plan_id}}  
**Erstellt:** {{timestamp}}  
**Lead-ID:** {{lead_id}}  
**Access Level:** {{access_level_name}} ({{access_level_id}})

---

## Gründerprofil

| Attribut             | Wert                        |
|----------------------|-----------------------------|
| Archetype            | {{founder_archetype_name}}  |
| Gründungsphase       | {{founder_phase}}           |
| Jurisdiktion         | {{jurisdiction_preference}} |
| Primärkanal          | {{primary_channel}}         |
| Sprache              | {{language}}                |
| Lead-Score           | {{lead_score}} / 100        |
| Lead-Tier            | {{lead_tier}}               |

---

## Empfohlenes Paket

**{{recommended_package_name}}** — {{price_usd}} USD

**Enthaltene Deliverables:**
{{#each package_deliverables}}
- {{this}}
{{/each}}

---

## Zugangspfad-Schritte

{{#each touchpoints}}
### Schritt {{this.step}}: {{this.action}}

- **Kanal:** {{this.channel}}
- **Timing:** {{this.timing}}
- **Automatisiert:** {{#if this.automated}}Ja{{else}}Nein — manueller Trigger erforderlich{{/if}}

{{/each}}

---

## Upsell-Sequenz

{{#if upsell_sequence}}
| Phase | MVP | Trigger |
|-------|-----|---------|
{{#each upsell_sequence}}
| {{this.phase}} | {{this.mvp_id}} | {{this.trigger}} |
{{/each}}
{{else}}
Kein Upsell für dieses Profil geplant.
{{/if}}

---

## Friction Points

{{#each friction_points}}
**Hürde {{@index_1}}:** {{this.point}}  
**Mitigation:** {{this.mitigation}}

{{/each}}

---

## Compliance-Hinweise

{{#if compliance_flags}}
> **Achtung:** Folgende Compliance-Punkte sind zu beachten:

{{#each compliance_flags}}
- {{this}}
{{/each}}
{{else}}
Keine besonderen Compliance-Hinweise.
{{/if}}

---

## Metriken

**Konversions-Wahrscheinlichkeit:** {{conversion_probability_pct}}%  
**Automation-Grad:** {{automation_grade}}  
**Erwartete Bearbeitungszeit:** {{estimated_delivery_days}} Werktage nach Zahlung

---

## Nächste Aktion

**{{next_action}}**

---

*NYXA Zugangspfad-Plan — Informatorisch, keine Rechts- oder Steuerberatung.*  
*Keine Förder-, Kredit- oder Einkommensgarantien.*  
*NYXA Opportunity & Access System V0.1 — {{timestamp}}*
