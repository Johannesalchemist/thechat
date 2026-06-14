# World Generator API V1

Status: ARCHITECTURE DECISION — DRAFT

## Purpose
Define the documentation-level interface for World Forge generation flows.

## Proposed API Surface
- generateWorld(input)
- generateQuest(input)
- generateNPC(input)
- simulateWorld(input)
- exportWorld(input)

## Input Expectations
- World theme
- Learning or gameplay objective
- Constraints
- Governance policy references

## Output Expectations
- World outline
- Quest list
- NPC / Agent descriptors
- Simulation summary
- Export package reference
