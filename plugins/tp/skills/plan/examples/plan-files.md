# plan.md and plan.json — good and bad

`plan.md` follows `instructions/plan-template.md`; `plan-lint.mjs` checks its structure, counts, files and
citations before the checker is spawned, so what the checker spends its time on is whether the plan is
*right*, not whether it is well-formed. `plan.json` is written with `node <lib>/state.mjs put <workdir> plan` and
holds counts, not the steps.

## Good

```json good plan
{ "status": "ready", "flags": ["public-contract"], "steps": 3, "openQuestions": 0, "complexity": "medium" }
```

A small ticket gets a one-screen plan with the template's headings:

```markdown good plan
# Plan — ACME-42: Show the order total with VAT on the invoice page

status: ready
risk flags: public-contract
repos: `/work/shop/.claude/work/ACME-42/wt/shop-web` · `feat/acme-42-invoice-vat` · `main`

## Goal
The invoice page shows what the customer pays, VAT included.

1. The invoice page shows the total including VAT
2. A zero-rated order shows 0% VAT, not a blank

## Current behaviour
The total is `sum(lines)` in `src/invoices/total.ts:12-20`; the page renders it unchanged at `src/invoices/page.tsx:40`. VAT is computed for the PDF only, in `src/invoices/pdf.ts:55-70`.

## Approach
Move the PDF's VAT rule into `total.ts` and use it from both places, so the page and the PDF cannot disagree. Rejected: computing VAT in the page — it would be a second copy of a rule that changes.

## Steps

### Step 1 — Move the VAT rule next to the total
- Files: `src/invoices/total.ts` (edit), `src/invoices/vat.ts` (new)
- Change: `vatOf(lines)` returns the VAT on the net total, rounded once; `totalWithVat(lines)` adds it.
- Pattern: `src/invoices/pdf.ts:55-70` (the rule as it is today)
- Checkpoint: `npx tsc --noEmit` passes; `npx vitest run src/invoices/total.test.ts` covers a 3-line order.
- Commit: yes — `feat(invoice): compute VAT with the total`

### Step 2 — Use it in the PDF and the page
- Files: `src/invoices/pdf.ts` (edit), `src/invoices/page.tsx` (edit)
- Change: both call `totalWithVat`; the PDF's own VAT code goes.
- Pattern: `src/invoices/page.tsx:40`
- Checkpoint: `npx tsc --noEmit`; the existing PDF test still passes.
- Commit: no, folded into step 3

### Step 3 — Show 0% for a zero-rated order
- Files: `src/invoices/page.tsx` (edit), `src/invoices/page.test.tsx` (new)
- Change: the VAT line renders `0%` when the rate is 0, not nothing.
- Checkpoint: `npx vitest run src/invoices/page.test.tsx` — a zero-rated order shows `0%`.
- Commit: yes — `feat(invoice): show VAT on the page, 0% when zero-rated`

## Verification
- Gates: the project's own (`/tp:verify base=main`).
- Tests: `total.test.ts` and `page.test.tsx` as above.
- Manual: 1. Open an invoice of a three-line order: the total includes VAT. 2. Open a zero-rated one: `0%`.

## Risks and rollback
- The PDF and the page now share one rule → a mistake shows in both; rollback: revert the PR.

## Open questions
none

## Out of scope
Per-line VAT display — the ticket asks for the total only.
```

## Bad

Steps as a list instead of a count — the steps live in `plan.md`:

```json bad plan $.steps: expected integer, got array
{ "status": "ready", "flags": [], "steps": [{ "n": 1, "name": "Move the rule" }], "openQuestions": 0, "complexity": "medium" }
```

Ready, yet with questions open (the person is never asked):

```json bad plan "ready" but openQuestions is 2
{ "status": "ready", "flags": [], "steps": 3, "openQuestions": 2, "complexity": "medium" }
```

A step that commits into a step that is not there — the work would never be committed:

```markdown bad plan commits
## Steps

### Step 1 — Move the VAT rule next to the total
- Files: `src/invoices/total.ts` (edit)
- Change: `vatOf(lines)` returns the VAT on the net total.
- Checkpoint: `npx tsc --noEmit` passes.
- Commit: no, folded into step 9
```

A step with no checkpoint is two steps — nothing proves it before the next one starts:

```markdown bad plan step-fields
## Steps

### Step 1 — Move the VAT rule next to the total
- Files: `src/invoices/total.ts` (edit)
- Change: `vatOf(lines)` returns the VAT on the net total.
- Commit: yes — `feat(invoice): compute VAT with the total`
```

The implementer has the plan and the repository, not the conversation:

```markdown bad plan placeholders
## Current behaviour
The rounding is done as discussed with the team.
```
