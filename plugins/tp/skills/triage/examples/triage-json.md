# triage.json — good and bad

Written with `node <lib>/state.mjs put <workdir> triage`. The state script derives the wait for the
person from `decision` and `questions`, the park from `blockedBy`, and shows `why` for `close` and
`blocked`; `complexity` picks the model and effort of every later agent.

## Good

A change small enough to implement without a plan:

```json good triage
{ "decision": "direct", "confidence": "high", "override": null, "flags": [], "questions": [], "complexity": "low" }
```

Planned first, with the risk flag that makes the person read the plan closely:

```json good triage
{ "decision": "plan", "confidence": "medium", "override": null, "flags": ["public-contract"], "questions": [], "complexity": "high" }
```

It cannot go on without the person: each question is a decision with its choices and the default
assumed if nobody answers (a plain string is fine when there are no choices):

```json good triage
{
  "decision": "needs-input", "confidence": "low", "override": null, "flags": [],
  "questions": [
    "Should a zero-rated order show 0% or hide the VAT line?",
    { "text": "Round VAT per line or on the total?", "choices": ["per line", "on the total"], "default": "on the total" }
  ],
  "complexity": "medium"
}
```

Closed: `why` says what delivers or supersedes it, so the person can close the ticket with that reason:

```json good triage
{ "decision": "close", "confidence": "high", "override": null, "flags": [], "questions": [], "complexity": "low", "why": "ACME-31 already shows VAT on the invoice page (merged 2026-09-02); nothing is left to do here" }
```

Parked behind another ticket: `blockedBy` lists the ids that must land first.

```json good triage
{ "decision": "blocked", "confidence": "high", "override": null, "flags": [], "questions": [], "complexity": "medium", "blockedBy": ["ACME-40"], "why": "needs the tax-rate endpoint ACME-40 adds" }
```

## Bad

A decision the pipeline has no stage for — `put` says which values exist:

```json bad triage $.decision
{ "decision": "maybe", "confidence": "high", "override": null, "flags": [], "questions": [], "complexity": "low" }
```

Questions as one string: the script renders each question as a line, so it needs the list:

```json bad triage $.questions: expected array, got string
{ "decision": "needs-input", "confidence": "low", "override": null, "flags": [], "questions": "Zero-rated: 0% or hidden?", "complexity": "medium" }
```

No rating: every later agent's model comes from it.

```json bad triage $.complexity: required, missing
{ "decision": "direct", "confidence": "high", "override": null, "flags": [], "questions": [] }
```

A structured question needs its text:

```json bad triage $.questions[0].text: required, missing
{ "decision": "needs-input", "confidence": "low", "override": null, "flags": [], "questions": [{ "choices": ["per line", "on the total"] }], "complexity": "medium" }
```
