# Plan Template

The reader is an implementer with this file and the repository — no conversation, no
memory of the planning. Every claim about the current code carries a `path:line`; every
step names its files. Never write "as discussed" or "as before".

```markdown
# Plan — <ticket id>: <title>

status: ready | open-questions
risk flags: <none | data-model | access-control | public-contract | cross-repo | irreversible>
repos: <one line per repo — absolute path · branch · base> (order = execution order)

## Goal
<The problem in one sentence a non-engineer understands, then the acceptance
criteria as a numbered checklist copied from `ticket.json.acceptanceCriteria` — the
same numbering `/tp-accept` proves.>

## Current behaviour
<How it works today, with evidence: `path:line` for each relevant piece — the entry
point, the data model, the rule that is wrong or missing, the existing pattern to
follow. What was checked and found *not* to be involved.>

## Approach
<The chosen approach in 3–6 sentences and why it wins; then each rejected alternative
in one line with the reason.>

## Steps
Ordered; each step is one coherent, verifiable change. Format:

### Step <n> — <name>
- Files: `path` (new | edit) …
- Change: <what, precisely — signatures, fields, rules; no code dumps>
- Pattern: `path:line` <the existing code to mirror, if any>
- Checkpoint: <how the implementer proves this step works before moving on — a type
  check, a unit test, a request against a listening port, a query on a disposable
  data copy>
- Commit: <yes — message subject | no, folded into step m>

## Verification
- Gates: the project's own (`/tp-verify base=<base branch>`).
- Tests: <which existing tests cover this; which new ones the project's conventions
  expect, with file paths>.
- Manual: numbered steps a person follows in a running instance — screen or command,
  actions, expected result. Data setup if any (on a disposable copy).

## Risks and rollback
- <risk> → <mitigation>; rollback: <revert the PR | reverse the data change | manual step>.

## Open questions
<empty when status is ready — otherwise numbered questions only the user can answer,
each with the default the plan assumes if unanswered>

## Out of scope
<what was deliberately left out and where it belongs (a follow-up, another ticket)>
```

Rules for the planner:
- Read the conventions file first; a plan that violates it is wrong before it starts.
- Size steps for a checkpoint after each; a step without a checkpoint is two steps.
  Steps run sequentially in one working tree; cross-repo work is ordered by repo.
- Prefer the existing pattern over a new abstraction; if a new one is needed, say why
  the existing one cannot be extended.
- Plan only checks the implementer may run (`skills/README.md` § Verification rules).
- Keep it as short as the change allows; a small ticket gets a one-screen plan.
