# implement.json — good and bad

Written once per repo with `node <lib>/state.mjs put <workdir> implement` (`implement.<repo>` on a cross-repo
ticket), after the last commit and the gates. `done` of `total` is how far the plan got; `stopped` is `null` when it ran
to the end and `{ step, question }` when it stopped for the person; `deviations` is a count or one line each.

## Good

Ran to the end, one deviation worth the reviewer's attention:

```json good implement
{
  "repo": "shop-web", "done": 3, "total": 3,
  "commits": ["3f9c2ab feat(invoice): compute VAT with the total", "a81d0e4 feat(invoice): show VAT on the page"],
  "gates": { "lint": "PASS", "types": "PASS", "tests": "PASS", "build": "PASS" },
  "deviations": ["step 2 also touched src/invoices/format.ts: the formatter hard-coded two decimals"],
  "stopped": null, "complexity": "medium"
}
```

A repo whose own hooks run the gates records `HOOK`, not `PASS`; nothing deviated, so a count will do:

```json good implement
{ "repo": "shop-web", "done": 2, "total": 2, "commits": ["9be1c07 fix(invoice): round VAT once"], "gates": { "lint": "HOOK", "types": "HOOK" }, "deviations": 0, "stopped": null, "complexity": "low" }
```

Stopped for the person at step 2 — the question is the one the report returns:

```json good implement
{
  "repo": "shop-web", "done": 1, "total": 3, "commits": ["3f9c2ab feat(invoice): compute VAT with the total"], "gates": {},
  "deviations": 0, "stopped": { "step": 2, "question": "The PDF rounds per line and the plan says on the total. Change the PDF too, or keep its rounding? Default: change it." },
  "complexity": "medium"
}
```

## Bad

`stopped` is `null` or the question, not a flag — the state script reads the question from it:

```json bad implement $.stopped
{ "repo": "shop-web", "done": 3, "total": 3, "commits": ["3f9c2ab"], "gates": { "lint": "PASS" }, "deviations": 0, "stopped": false, "complexity": "low" }
```

Gates as a list — it is a name → result map:

```json bad implement $.gates
{ "repo": "shop-web", "done": 3, "total": 3, "commits": ["3f9c2ab"], "gates": [{ "name": "lint", "status": "PASS" }], "deviations": 0, "stopped": null, "complexity": "low" }
```

More steps done than the plan has:

```json bad implement 4 steps done of 3
{ "repo": "shop-web", "done": 4, "total": 3, "commits": ["3f9c2ab"], "gates": { "lint": "PASS" }, "deviations": 0, "stopped": null, "complexity": "low" }
```

A rating written as prose — it is one of `low`, `medium`, `high`, or `higher` when the work proved harder than the plan's rating:

```json bad implement $.complexity
{ "repo": "shop-web", "done": 3, "total": 3, "commits": ["3f9c2ab"], "gates": { "lint": "PASS" }, "deviations": 0, "stopped": null, "complexity": "as rated" }
```
