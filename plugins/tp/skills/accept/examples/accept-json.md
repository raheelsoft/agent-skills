# accept.json — good and bad

Written by `/tp:accept` with `node <lib>/state.mjs put <workdir> accept`. One entry per acceptance criterion, in the ticket's
numbering, with its result — `pass`, `fail` or `manual` (a person must look) — and the **evidence**: what a reader can
re-check without trusting the walker. `passed`, `failed` and `manual` equal the count of each result.

## Good evidence, and what is not

A request and what came back, a query and its row, a file and a line — something to repeat:

```json good accept
{
  "where": "live",
  "targets": [{ "repo": "shop-web", "env": { "name": "staging", "url": "https://staging.shop.example.com" }, "checkout": null }],
  "criteria": [
    { "n": 1, "text": "The invoice page shows the total including VAT", "result": "pass", "evidence": "GET /invoices/1 → 200; the page's total 120.00, net 100.00, VAT 20.00 (rendered text, 14:02 UTC)" },
    { "n": 2, "text": "A zero-rated order shows 0% VAT, not a blank", "result": "manual", "evidence": "needs an order with a zero-rated item; none exists on staging and creating one is not allowed — steps for the person: open /invoices/zero-rated in the staging admin" }
  ],
  "passed": 1, "failed": 0, "manual": 1
}
```

"Looks fine", "tests pass" and "works as expected" are not evidence — they cannot be repeated. A criterion that cannot be
proven where the walk is allowed to look is `manual`, with the steps, never a `pass` on belief.

## Bad

The counts say two passes; one criterion passed (a hand-typed total that is wrong goes unnoticed):

```json bad accept $.passed: 2 but 1 criteria have result "pass"
{
  "where": "checkout", "targets": [{ "repo": "shop-web", "env": null, "checkout": "/work/shop-web" }],
  "criteria": [{ "n": 1, "text": "The page shows VAT", "result": "pass", "evidence": "src/invoices/page.tsx:40 calls totalWithVat" }],
  "passed": 2, "failed": 0, "manual": 0
}
```

A result the walk never gives (`passed` is not `pass`):

```json bad accept $.criteria[0].result
{
  "where": "live", "targets": [], "criteria": [{ "n": 1, "text": "The page shows VAT", "result": "passed", "evidence": "GET /invoices/1 → 200" }],
  "passed": 1, "failed": 0, "manual": 0
}
```

A criterion with no evidence at all:

```json bad accept $.criteria[0].evidence: required, missing
{
  "where": "live", "targets": [], "criteria": [{ "n": 1, "text": "The page shows VAT", "result": "pass" }],
  "passed": 1, "failed": 0, "manual": 0
}
```
