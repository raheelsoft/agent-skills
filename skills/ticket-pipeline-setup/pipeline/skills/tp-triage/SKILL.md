---
name: tp-triage
description: Decide from evidence whether a ticket is implemented directly, planned first, needs input, is closed or is blocked — a fresh read-only agent sizes the change and records the decision with its evidence.
user_invocable: true
---

Decide **direct**, **plan**, **needs-input**, **close** or **blocked** for one ticket
and record why. The decision is made by a fresh agent — this skill's dedicated agent,
which knows nothing but its arguments (`skills/README.md` § Definitions, Dedicated
agent) — from what it finds in the ticket and the code, not from the invoker's
impression of the task; no second agent is spawned to do the same reading.
Conventions: `skills/README.md` § Definitions (Resume, Output contract, Asking the
user).

## Input

- `<id>` — the ticket. No work directory yet (`<.claude>/work/<id>/`, written by
  `/tp-start-ticket`) → the pickup runs first (`skills/README.md` § Definitions, Entry
  points).
- `mode=direct|plan` (optional) — the user's override; the agent still runs so
  `triage.md` carries the evidence, but the decision is the override.
- `answers=<text>` (optional) — the person's answers to an earlier `needs-input`
  (§ Definitions, Resume); appended to `answers.md` and logged as a `note` before the
  agent runs again.
- `force=true` — re-run a done triage (§ Definitions, Resume).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `ticket.json.complexity`.

## Steps

### 1. Read the state, log, size the change
`state.mjs state <workdir>` then `state.mjs log <workdir> triage started` (§ Definitions,
Resume). This agent does the sizing itself, restricted to reading the worktree and
writing only `triage.md` and `triage.json` (its tools: read and search in the
worktrees, write only its two files), from: the absolute work directory; `ticket.md`,
`answers.md`; each repo's worktree and conventions file from `ticket.json`; the
criteria file (`instructions/criteria.md`). The task — locate the code the ticket
touches (its frontier: the acceptance criteria and the code they name —
`skills/README.md` § Context management, rule 8), estimate the blast radius, check
every criterion, rate the ticket's complexity from the same evidence
(`instructions/criteria.md` § Complexity), write `triage.md` in the template below
and `triage.json` (`{ decision, confidence, override, flags, questions, blockedBy,
complexity, why }` — `why` for `close`: what delivers or supersedes the ticket, for
`blocked`: what must land first, with the blockers' ids in `blockedBy`; `estimate`
is added by step 3). Independent areas may be parallel read-only lookups inside this
agent, sequential at the depth that cannot spawn.

### 2. Read the decision
- **direct** → the ticket plus the `approach` lines are enough; next `/tp-implement`.
- **plan** → `/tp-plan`, then `/tp-implement` in a different agent.
- **needs-input** → the `questions` are the report — after this agent has tried one
  bounded read-only lookup per question it could answer from the repo; the stage still
  logs `done` and the script derives the wait; `/tp-triage <id> answers=…` re-runs.
- **close** → the ticket's premise is gone (`instructions/criteria.md` § Close): the
  `why` names the merged change or the ticket that covers it. The stage logs `done`;
  the script reports the ticket **closed** (`next: null`) and `/tp-run-ticket` goes to its
  close-out. The tracker status stays the person's call (§ Tickets) — the report says
  what to close it as. A new round (`round=`) or `force=true` reopens it.
- **blocked** → other tickets must land first (`instructions/criteria.md` § Blocked):
  copy `blockedBy` into `ticket.json.blockedBy` as rows `{ id, state: null, resolved:
  false, soft: false, checkedAt: null }` (the pickup's blocked-check states when it
  found them soft), add the blocked-by relations in the tracker when it has them and
  they are missing, and comment on the ticket that it is parked and on what. The
  stage logs `done`; the script derives the stop `blocked by <ids> — nothing to
  answer — resumes when they are resolved` (`kind: blocked`) and `/tp-run-ticket` parks
  the ticket in its close-out (worktrees removed, `repos[].discarded`). It resumes by
  itself: `/tp-inbox` and `/tp-plan-day` re-check the blockers (`blocked-check.md`
  § Re-check) and re-invoke `/tp-run-ticket <id>` once all are resolved (§ Definitions,
  Resume).

A `mode=` override wins; the report says so.

### 3. Record and report
Refine the estimate with the evidence (§ Models and budget, Estimates): `model.mjs
estimate '{ rating: <triage's>, repos, flags: <the risk flags>, unclear: <criteria
partly or missing>, novelty: <no existing pattern>, claudeDir }'` → `triage.json.
estimate`; when `ticket.json.estimate.source` is `pipeline`, replace it there and in
the tracker's estimate field — a person's estimate (`source: tracker`) is only
reported against, never changed. `state.mjs log <workdir> triage done "<decision>
(<confidence>) - <complexity>" triage.md`. Report the decision, confidence, the rating,
the estimate (hours, days), the two or three strongest pieces of evidence, and the
next stage — nothing else; the detail is in `triage.md`.

## `triage.md`

```markdown
# Triage — <id>: <title>
decision: direct | plan | needs-input | close | blocked
confidence: high | medium | low
why: <close — the merged change, PR or ticket that delivers or supersedes this one; blocked — what must land first>
blocked by: <blocked only — the ticket ids, the same as triage.json.blockedBy>
override: none | user forced <direct|plan>

## Evidence
- areas/files likely touched: <paths> (<n> files, <m> areas)
- entry points: <path:line> … — where the change starts; the planner and the implementer start from these, not from a search
- shared state (data model, migrations, seeds, config): yes/no — <where>
- access control / security-sensitive: yes/no — <where>
- public contract (API, CLI, event, schema consumers): yes/no — <where>
- second repo or service: yes/no
- existing pattern to follow: <path> | none found
- acceptance criteria: clear | partly | missing — <what is missing>

## Approach (direct only — 1–3 lines an implementer can act on)
## Scope notes (plan only — what the planner must resolve)
## Questions (needs-input only, numbered, each with its choices and the default assumed if unanswered — in `triage.json` as strings or `{ text, choices, default }`)
## Risk flags
none | data-model | access-control | public-contract | cross-repo | irreversible
```

## Stops
`blocked` — derived by the script, nothing to answer: the ticket resumes by itself
once its blockers are resolved (`/tp-inbox`, `/tp-plan-day`; or `/tp-run-ticket <id>` by hand
after `state.mjs blockers` recorded them resolved).
`needs-input` — the numbered questions, each with its default (derived by the script,
which renders a structured `{ text, choices, default }` as one line — write them that
way or as plain strings, never anything the script would show as `[object Object]`;
`answers=1: … | 2: …`, a blank answer takes the default); `hand-off budget spent —
<next step>` (`answers=continue`); `error: …` — a lookup or a read that failed past its
fallback (`skills/README.md` § Failures and escalation):
`answers=retry` once the person has done what `needs` names.
