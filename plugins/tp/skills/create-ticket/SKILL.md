---
name: create-ticket
description: Creates well-formed tracker tickets from a request, a bug report, a spec excerpt or a review's pre-existing defects, with duplicate check, discovery brief, criteria, labels and relations. Use when a ticket must be written; it is the only skill that creates tickets.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`) · `<skill>` = `${CLAUDE_SKILL_DIR}` (this skill's folder, where the `instructions/` and `examples/` files named below are). Its checkpoint and any other document it writes in the work directory go through `node <lib>/state.mjs doc <.claude>/work/_scratch <name>` (the text on stdin or `--from <file>`; a draft or a command's output goes under `<.claude>/worktrees/_out/`, in a name that carries its slug or date — the one place below `.claude/` an agent may write): a hook refuses a raw write. Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

Write a ticket the rest of the workflow can act on without re-reading the original
conversation. This is the only skill that creates tickets (`reference/procedures.md`
§ Tickets) — because the user invoked it, or because `/tp:review` found pre-existing
defects in code a PR touches or depends on (`from=review`, all of a pass's defects in
one invocation — one dedicated agent, one ticket each; step 1 says what a duplicate
does then). The discovery is this agent's own reading (§ Definitions, Dedicated
agent).

## Input

Free text: a bug report (with whatever reproduction exists), a change request, a spec
excerpt, or a pre-existing defect `/tp:review` found in code a PR touches (file, line at
the base revision, what is wrong, the PR link). Optional hints: repo,
iteration/sprint, priority, parent ticket, related tickets.

- `from=review` — passed by `/tp:review` (local or remote mode) with one or several
  numbered defects: each gets steps 1–4 on its own, a duplicate is reported, never
  asked about (step 1), and the report is one line per defect.
- `answers=comment|create` — the decision after a duplicate was found (step 1).
- `inline=true` — `reference/definitions.md` § Definitions (Dedicated agent); this agent's
  rating: from the request — a reproduction with a known area is `low`, a spec excerpt
  spanning areas is `high`. No token is part of the ticket text.

## Steps

### 1. Check for an existing ticket
Search the tracker for the same problem (key nouns, error text, screen name). A match
→ with `from=review`: the report is the existing ticket id, nothing is created and
nothing asked (two PRs touching the same code never file it twice); on a person's
request: `stopped "matches <id> — comment
on it (comment), or create a distinct ticket linked as related (create)? Default:
comment"` — create nothing until `answers=comment` or `answers=create` comes back.

### 2. Discovery — this agent, read-only on the repo
Locate the code involved (read and search only; frontier: the request's nouns → the
hits and one level of callers and callees, rule 8) in each repo, with its conventions
file: the entry points and files (`path:line`), the existing pattern to follow,
whether shared state, access control, a public contract or a second repo is involved,
what could not be found — ≤ 10 lines of brief per ticket. Independent areas may be
parallel read-only lookups inside this agent, sequential at the depth that cannot
spawn; a review's several defects share one reading of the code they touch.

### 3. Draft the ticket
`instructions/ticket-template.md`. Classify it (defect vs change request vs feature) by
whether existing behaviour is broken, not by the wording; title per the tracker's
convention (prefix, component); repo target from discovery; acceptance criteria as a
checklist; the discovery result as the implementation brief; labels, priority,
iteration and relations (parent, blocked-by, related) from the hints and the tracker's
existing conventions. No personal data (`reference/procedures.md` § Personal data).

### 4. Create it
Create the ticket with the tracker (`reference/definitions.md` § Definitions, Tracker) in its backlog/unstarted state,
unassigned unless the user said otherwise; add the relations. If the tracker rejects a
field (a label that doesn't exist, a quota), create without it and say so.

### 5. Report
The ticket link, its classification and repo target, and anything the discovery
could not find (so the brief's gaps are visible) — one line per ticket with
`from=review`. Suggest `/tp:run-ticket <id>` or
`/tp:start-ticket <id>` as the next step; don't start it unasked.

## Stops
A duplicate on a person's request (`answers=comment|create`); the tracker or a
lookup failing past its fallback — `error: …` (`reference/failures-and-stops.md`
§ Failures and escalation; the state in `_scratch/create-ticket-<slug>.md`):
`answers=retry` once the person has done what `needs` names. With `from=review`
nothing stops (step 1).
