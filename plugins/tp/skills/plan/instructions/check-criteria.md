# Plan Check Criteria

Verify against the worktree, not against the plan's own claims. Every finding names the
step (or `—` for the plan as a whole) and is one line. `blocking` means implementing
as written would fail, break a convention, or leave an acceptance criterion unmet;
everything else is `advisory`.

`node <lib>/plan-lint.mjs` has already run (SKILL.md step 2) and passed with no blocking
finding: the template's sections and header, that a step's files exist or are declared
`(new)`, that every cited `path:line` names a real file with that many lines, that
`plan.json` agrees with `plan.md`, that the criteria in § Goal number the ticket's, that each has a well-formed check in § Verification, and
the commit folds. Do not re-check those; the table's rows below are the judgment that
remains — whether the code says what the plan claims, not whether the file is there.

| Check | Blocking when |
|---|---|
| **Evidence is real** | a `path:line` in § Current behaviour doesn't say what the plan claims (that it exists is the script's) |
| **Files exist or are declared new** | a step lists a file in the wrong form for what it does: a rename written as an edit, a generated file written as new, a file the script could not see (outside the worktrees) |
| **Coverage** | an acceptance criterion in § Goal has no step that produces it, or its named check (§ Verification, `Criteria checks`) would not really prove it — a test that cannot fail for the criterion's reason (that every criterion has a check is the script's) |
| **Convention conflicts** | a step contradicts the conventions file (layering, naming, the access-control mechanism, test expectations, forbidden patterns) |
| **Pattern fidelity** | § Approach says "follow `path:line`" but the steps diverge from what that pattern actually does |
| **Risk flags** | the steps touch shared state, access control, a public contract, a second repo or something irreversible and the header's `risk flags` doesn't say so |
| **Checkpoints** | a step's checkpoint cannot be run under the verification rules (needs a server/browser the implementer may not start, or the user's data), or doesn't actually test the step |
| **Ordering** | a step depends on a later step's output; or a commit boundary splits a change that can't compile halfway |
| **Scope** | the plan implements something the ticket puts out of scope, or leaves an in-scope requirement to "a follow-up" without saying so in § Out of scope |
| **Self-containment** | the implementer would need something not in the plan or the repo to proceed ("as discussed", an undefined value, a missing data setup) |

Advisory examples: a step that could be smaller; a checkpoint that could be stronger;
an alternative in § Approach the plan rejected too quickly; a risk with no rollback.

The check does not redesign the plan. When the approach is wrong in a way the planner
should reconsider, say so as one blocking finding on `—` with the reason and, at most,
the direction to look — the planner does the rework.

## An incremental pass

From the second check on (SKILL.md step 2), the input is the previous `plan-check.json`
and `plan.prev.md` beside the new `plan.md`. Verify only: each previous finding —
resolved (one line saying how) or still open (what is still wrong), keeping its
number — and the steps the diff shows changed, against the table above, for defects
the change introduced. Unchanged steps are not re-read; a new blocking finding is
raised only for something the change caused. `ok` when nothing blocking remains;
advisory findings alone never hold a plan.
