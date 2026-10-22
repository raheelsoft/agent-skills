# retro.json — good and bad

Written by `/tp:retro` with `node <lib>/state.mjs put <workdir> retro`; never applied by the stage. The four counts say
how the ticket went against its plan; each proposal names what it would change and the evidence from this ticket.

## Good

```json good retro
{
  "deviations": 1, "reviewFindingsMissedByCheck": 1, "questions": 2, "manualCriteria": 1,
  "proposals": [
    { "target": "conventions", "text": "State that money is formatted by src/invoices/format.ts only.", "evidence": "step 2 deviated to fix a hard-coded two-decimal formatter; review finding 3 was the same defect" }
  ]
}
```

## Bad

A proposal aimed at nothing the pipeline owns — the targets are the conventions file, the ticket template, the standing instructions and the skills:

```json bad retro $.proposals[0].target
{ "deviations": 0, "reviewFindingsMissedByCheck": 0, "questions": 0, "manualCriteria": 0, "proposals": [{ "target": "team", "text": "Write better tickets.", "evidence": "ACME-42" }] }
```

A proposal with no evidence — a rule added on a hunch is one more thing to maintain:

```json bad retro $.proposals[0].evidence: required, missing
{ "deviations": 0, "reviewFindingsMissedByCheck": 0, "questions": 0, "manualCriteria": 0, "proposals": [{ "target": "skill", "text": "Ask for the design link in the pickup." }] }
```
