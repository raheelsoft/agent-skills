---
name: status
description: Shows where every ticket in the work directory stands — stage, rating, waits, lock, PR and verdict, quality, time, tokens and cost, worktrees, retro, problems — computed by the state script. Use to see the state of the work.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`). It writes nothing. Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

One table for all tickets, or one ticket in detail — both printed by `state.mjs` (`reference/definitions.md` § Definitions, The
scripts). It runs **in the invoking context**: no agent is spawned to run one command and copy its output
(§ Definitions, Dedicated agent).

## Input

- No argument → every work directory under `<.claude>/work/`.
- `<id>` → that ticket in detail.
- `problems` → only tickets whose state script reports a problem.

## Steps

### All tickets
`node <lib>/state.mjs table <.claude>/work` (`… table <.claude>/work problems` for the argument `problems`) prints the
whole board — one row per ticket (every `_`-prefixed entry — `_office/`, `_scratch/`, `_day/` — is not one), the totals
line, the problems, the worktrees that done or closed tickets still hold with the command that removes each, and stale locks
with their `unlock` command. Relay it as it is; the columns and what fills them are described under
`state.mjs table` in `reference/definitions.md`. Nothing is recomputed here.

### One ticket
`node <lib>/state.mjs show <id>` prints it — the stage list with status, time and minutes, the stop with its `kind`, `resume`
command and default, the blockers as last recorded, any queued answer, the lock, the PRs, the worktrees, the problems, the last ten lines of
`progress.md` and the next action. Relay it as it is.

### Report
The table or the detail; nothing else. No fixes are made here — a problem is reported
with the file it concerns, and the user or the owning stage resolves it.
