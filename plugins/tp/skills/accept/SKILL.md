---
name: accept
description: Proves a ticket is delivered by walking every acceptance criterion against the released environment or the merged revision and recording pass, fail or manual with evidence. Use as the run's last stage, which removes the worktrees.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`) · `<skill>` = `${CLAUDE_SKILL_DIR}` (this skill's folder, where the `instructions/` and `examples/` files named below are). The JSON files this skill writes (`<artifact>.json` below) go through `node <lib>/state.mjs put <workdir> <artifact> …` — checked against `schemas/` first; `examples/accept-json.md` shows good ones and bad ones with the refusal they get — never through the file tools or a shell redirect: a hook refuses a raw write. Its `.md` documents are written the same way: `node <lib>/state.mjs doc <workdir> <name>`, the text on stdin or `--from <file>` (`--append` adds to the end); a long one is drafted under `<.claude>/worktrees/_out/<id>/`, the one place below `.claude/` an agent may write. Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

Stage 8 of the workflow (`reference/README.md`): the closing check. "Delivered" means a
check proved it — this stage is that check, run by an agent that did not write the code
(this skill's dedicated agent: fresh, holding nothing but its arguments), against the
criteria the ticket set before the work started. It is the run's last stage, so a
clean pass also ends the ticket's worktrees (§ Worktrees). Conventions and the state
script: `reference/definitions.md` (§ Definitions: Resume, Output contract, Asking the
user, The scripts).

## Input

- `<id>` — the ticket; `release[.repo].json` exists for every repo (the state script's
  `next` is `accept`) — or `/tp:release` is off for this project (§ Definitions, Active
  skills: then `where` defaults to `checkout`). Not released yet → the earlier stages
  run first (`reference/definitions.md` § Definitions, Entry points).
- `where=live|checkout` (optional). Default `live` when any `release[.repo].json` has an
  `env`; else `checkout`. `live` → the `env` recorded by release, per repo. `checkout` →
  per repo, **the ticket's own worktree moved to the merge commit** (`reference/work-directory.md`
  § Worktrees — its dependencies, generated code and caches are already there):
  `git -C <worktree> fetch <remote> <base>` then `git -C <worktree> checkout --detach
  <pr[.repo].json.merged>`; dependencies re-installed only when a lockfile changed
  between the branch head and the merge commit (`git diff --name-only <branch>
  <merged> -- <lockfiles>`), generated code regenerated (§ Toolchain; the commands
  are `skills/start-ticket/instructions/branch-and-pull.md` § 3, outputs to files —
  rule 11), logged as a `note`. A criterion proven by a command (a test, a query)
  runs the same way: its output to a file, the proving lines as the evidence.
  No worktree at the path `ticket.json` records (a merge run before this rule, a cleanup
  by hand) → create one at `<.claude>/worktrees/<id>/<repo-name>`, detached at the merge
  commit, and make it usable the same way — never a second checkout beside an existing one.
- `env=<name>` (optional) — with `where=live`, another documented environment than
  the one `release[.repo].json` recorded; one the docs don't name → `stopped "env
  <name> is not documented — walk <recorded env> (keep), or name another? Default:
  keep"`.
- `answers=<text>` (optional) — the answer to this stage's last stop (§ Stops;
  `reference/definitions.md` § Definitions, Resume). `continue=true` — resume from
  `checkpoint.accept.md`. `force=true` — re-run a done acceptance.
- `inline=true` — `reference/definitions.md` § Definitions (Dedicated agent); this agent's
  rating: from the criteria (count, live-environment reads, derived criteria), with
  the catching step.

## Steps

### 1. Read the state, log, collect the criteria
`state.mjs state <workdir>` then `state.mjs log <workdir> accept started`. The
criteria are `ticket.json.acceptanceCriteria`
(numbered by position; `derived: true` when `/tp:start-ticket` had to derive them from the
description). Empty → `stopped` asking the user for them; record the answer in
`ticket.json` and `answers.md`. `plan.md` § Verification and its Implementation summary
say *how* each can be exercised. Environment facts (URL, CLI, how the project supplies
test credentials or fixtures) come from `release[.repo].json.env`, the conventions file
and docs, then `answers.md`; missing → `stopped` with the question. Credentials reach the
agent only through the project's documented mechanism (an env file, a secret store) —
never pasted into a prompt.

### 2. Walk the criteria — this agent
This agent is the walker (`reference/definitions.md` § Definitions, Dedicated agent — fresh,
no second agent for the same walk; its tools: read and search, a shell for requests,
queries and CLI reads, write only `accept.md` and its checkpoint (through `state.mjs doc`), and `accept.json` through `state.mjs put`;
frontier: the criteria alone — rule 8), with what step 1 collected: the criteria
list, the manual steps, per repo the environment and how to reach it (or the checkout
path), and the constraints — `live` is **read-only** (requests, queries, CLI reads;
no browser or emulator unless the user allowed it; a criterion that can only be
proven by writing to the live environment is `manual`); `checkout` may run the
project's tests and commands within the verification rules (§ Verification rules: a
disposable copy for anything shared); no real customer data in the evidence. For
every criterion: `pass | fail | manual`, with evidence (the request and the relevant
part of the response, the command and its output line, the query and its result) or,
for `manual`, the exact numbered steps a person follows; a criterion harder than the
rating → checkpoint and `complexity: higher` (§ Models and budget, Escalation: the
remaining criteria one rating up).

Criteria that are independent may be checked in parallel (read-only lookups inside
this agent; sequential at the depth that cannot spawn). Between criteria ask
`model.mjs compact` (rule 7); on `checkpoint` write `checkpoint.accept.md` with the
results so far and return `continue: <path>`; with `continue=true` resume at the
first criterion without a result.

### 3. Files
`accept.json` — `node <lib>/state.mjs shape accept` is the form (`examples/accept-json.md` has good and bad ones). `put` computes
`passed`, `failed` and `manual` from the criteria, refuses a set that is not exactly the ticket's
`acceptanceCriteria` and a `pass` or `fail` with no evidence, and writes `accept.md` — the same record as a table —
itself.


### 4. Decide
- Any **fail** → `state.mjs log … stopped "<n> criteria failed: <numbers> — start
  round <n+1> (round), or leave it (leave)? Default: round"`; the failed criteria with their
  evidence are the report. `answers=round` → the invoking context starts the new
  round (`/tp:run-ticket <id> round=<n+1>`, § Worktrees); `answers=leave` → the ticket
  stays stopped for the person.
- No fails → `state.mjs log … done "<passed> pass - <manual> manual"`, then the
  run's cleanup — this is the last stage (§ Worktrees): per repo `node <lib>/worktree.mjs remove '{ "repo", "id", "branch",
  "base", "claudeDir" }'` takes the worktree and its merged local branch (`skills/start-ticket/instructions/branch-and-pull.md`
  § 4; a worktree another ticket's `ticket.json` still names stays, and the result says so); log `note "worktrees removed"`. The `manual` criteria go to the person as numbered steps;
  the ticket's status is theirs. A fail keeps the worktrees: the next round
  re-branches them.

### 5. Report
Comment the table on the ticket (evidence summarised, no personal data), append it to
`report.md`, and report: pass / fail / manual counts, the failed criteria if any, and
the manual steps.

## Stops
No acceptance criteria (`answers=<the criteria, one per line>` — recorded in
`ticket.json`); a missing environment fact (`answers=<the URL / CLI / how credentials
are supplied>`); an undocumented `env=` (`answers=keep|<name>`); `<n> criteria
failed` (`answers=round|leave`); `hand-off budget
spent` (`answers=continue`); `error: …` — an environment unreachable or a checkout
that cannot be made usable past its fallback (`reference/failures-and-stops.md` § Failures and
escalation): `answers=retry` once the person has done what `needs` names.
