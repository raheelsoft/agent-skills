# ticket.json — good and bad

Written by the pickup with `node <lib>/state.mjs put <workdir> ticket`; later changes to it (a stacked branch, a
re-branch on a new round) go through `put … --merge`, and the blockers and actual hours through their own
`state.mjs` commands. `acceptanceCriteria` is what `/tp:accept` proves, word for word.

## Good

```json good ticket
{
  "id": "ACME-42",
  "title": "Show the order total with VAT on the invoice page",
  "link": "https://tracker.example.com/ACME/issue/ACME-42",
  "round": 1,
  "stackedOn": null,
  "dependsOn": null,
  "acceptanceCriteria": ["The invoice page shows the total including VAT", "A zero-rated order shows 0% VAT, not a blank"],
  "derived": false,
  "complexity": "medium",
  "repos": [
    { "name": "shop-web", "path": "/work/shop-web", "worktree": "/work/shop/.claude/worktrees/ACME-42/shop-web", "branch": "feat/acme-42-invoice-vat", "base": "main", "conventions": "/work/shop-web/CLAUDE.md" }
  ]
}
```

Stacked on a sibling ticket's open PR; the criteria were derived because the ticket had none (`derived`):

```json good ticket
{
  "id": "ACME-43",
  "title": "Round VAT once, on the total",
  "link": null,
  "round": 1,
  "stackedOn": { "ticket": "ACME-42", "branch": "feat/acme-42-invoice-vat", "pr": 218 },
  "dependsOn": null,
  "acceptanceCriteria": ["A three-line order's VAT equals the VAT of its net total, to the cent"],
  "derived": true,
  "complexity": "low",
  "repos": [
    { "name": "shop-web", "path": "/work/shop-web", "worktree": "/work/shop/.claude/worktrees/ACME-43/shop-web", "branch": "feat/acme-43-round-once", "base": "feat/acme-42-invoice-vat" }
  ]
}
```

## Bad

A repo with nowhere to work — the branch is how the next stages find the change:

```json bad ticket $.repos[0].branch: required, missing
{
  "id": "ACME-42", "title": "x", "round": 1, "acceptanceCriteria": ["a"], "complexity": "low",
  "repos": [{ "name": "shop-web", "path": "/work/shop-web", "worktree": null, "base": "main" }]
}
```

Criteria as one block of text — accept proves them one by one:

```json bad ticket $.acceptanceCriteria: expected array, got string
{
  "id": "ACME-42", "title": "x", "round": 1, "acceptanceCriteria": "The page shows VAT. Zero-rated shows 0%.", "complexity": "low",
  "repos": [{ "name": "shop-web", "path": "/work/shop-web", "worktree": null, "branch": "b", "base": "main" }]
}
```

A ticket that touches no repo has nothing to implement:

```json bad ticket $.repos: needs at least 1 item
{ "id": "ACME-42", "title": "x", "round": 1, "acceptanceCriteria": ["a"], "complexity": "low", "repos": [] }
```

A rating nobody defines — the three are `low`, `medium`, `high`:

```json bad ticket $.complexity: expected one of "low" | "medium" | "high"
{
  "id": "ACME-42", "title": "x", "round": 1, "acceptanceCriteria": ["a"], "complexity": "huge",
  "repos": [{ "name": "shop-web", "path": "/work/shop-web", "worktree": null, "branch": "b", "base": "main" }]
}
```
