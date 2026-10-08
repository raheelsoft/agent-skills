# The review as data — good and bad

A review pass is a JSON file, `<.claude>/worktrees/_out/review-<slug>.json`; `findings.mjs render` makes the comment
from it and the verdict follows from the priorities (P0 correctness, security, data loss · P1 contract break,
regression, missing test · P2 design · P3 clean code · P4 style — `instructions/checklist.md` § Priorities).

## Good

A first pass: one thing that must change before merging, one that need not, one old defect the diff touches:

```json good review-findings
{
  "round": 1, "sha": "3f9c2ab", "mode": "full", "confidence": 4,
  "gates": [{ "gate": "lint", "status": "PASS", "notes": "" }, { "gate": "tests", "status": "PASS", "notes": "41 tests" }],
  "findings": [
    { "id": 1, "priority": "P1", "file": "src/invoices/total.ts", "line": 27, "text": "VAT is rounded per line; the contract says on the total, so a 3-line order is off by 0.01.", "fix": "Sum the net lines, then round once." },
    { "id": 2, "priority": "P3", "file": "src/invoices/total.ts", "line": 12, "text": "totalWithVat and withVat compute the same thing.", "fix": "Keep one and call it from both places." },
    { "id": 3, "priority": "P2", "file": "src/invoices/format.ts", "line": 5, "text": "formatMoney hard-codes two decimals.", "scope": "pre-existing", "ticket": "ACME-57" }
  ]
}
```

A later pass: the old P1 is fixed and said so, one new finding the fix introduced:

```json good review-findings
{
  "round": 2, "sha": "a81d0e4", "mode": "delta", "confidence": 5,
  "findings": [
    { "id": 1, "priority": "P1", "file": "src/invoices/total.ts", "line": 27, "text": "VAT is rounded per line.", "status": "resolved" },
    { "id": 4, "priority": "P3", "file": "src/invoices/total.ts", "line": 31, "text": "The new helper's name says nothing about rounding.", "fix": "Call it roundedVat.", "new": true }
  ]
}
```

## Bad

A priority outside P0–P4 — the tier, the verdict and the merge gate all follow from it:

```json bad review-findings $.findings[0].priority
{ "round": 1, "sha": "3f9c2ab", "mode": "full", "confidence": 4, "findings": [{ "id": 1, "priority": "P9", "file": "a.ts", "line": 3, "text": "x" }] }
```

A finding that points nowhere — a reader cannot act on it:

```json bad review-findings $.findings[0].file: required, missing
{ "round": 1, "sha": "3f9c2ab", "mode": "full", "confidence": 4, "findings": [{ "id": 1, "priority": "P1", "text": "The rounding is wrong." }] }
```

A pass that does not say what kind it is:

```json bad review-findings $.mode: required, missing
{ "round": 1, "sha": "3f9c2ab", "confidence": 4, "findings": [] }
```

Line 0 — lines start at 1:

```json bad review-findings $.findings[0].line
{ "round": 1, "sha": "3f9c2ab", "mode": "full", "confidence": 4, "findings": [{ "id": 1, "priority": "P2", "file": "a.ts", "line": 0, "text": "x" }] }
```
