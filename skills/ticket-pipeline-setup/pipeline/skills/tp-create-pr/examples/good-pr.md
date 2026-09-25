# Good PR Examples

## Example 1 — Bug fix

**Title:** Scope the dashboard's active-item count to the individual user

```markdown
## Problem
The dashboard's active-item count was scoped to the whole team, not the individual —
everyone on a team saw the same inflated number instead of their own.

Ticket: ABC-142

## Solution
Added the missing owner filter to the dashboard query so it matches the per-user scope
used everywhere else on the page. No schema change.

## How to verify
1. Sign in as two test users on the same team (the project's documented test accounts).
2. Open both dashboards side by side.
3. Each shows a different count matching only its own items.

Gates: types, lint, build clean.
```

## Example 2 — Feature

**Title:** Enforce record ownership on the edit and reassign actions

```markdown
## Problem
Any user could edit or reassign a record owned by someone else — nothing tied those
actions to the record's actual owner, so ownership was cosmetic rather than enforced.

Ticket: ABC-118

## Solution
Added an ownership guard on the edit and reassign endpoints, checked against the
authenticated user's id and the project's permission set — not a role name — so a
manager's explicit override permission still works and any new role holding it
qualifies without a code change.

## How to verify
1. As test user A, try to edit a record owned by test user B — expect 403.
2. As a manager, reassign the same record — it succeeds.
3. The list view updates live.

Gates: types, lint, build clean.
```
