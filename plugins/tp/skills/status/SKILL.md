---
name: status
description: Shows where every ticket in the work directory stands — stage, rating, waits, lock, PR and verdict, quality, time, tokens and cost, worktrees, retro, problems — computed by the state script. Use to see the state of the work.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`). Its checkpoint and any other document it writes in the work directory go through `node <lib>/state.mjs doc <.claude>/work/_scratch <name>` (the text on stdin or `--from <file>`; a draft or a command's output goes under `<.claude>/worktrees/_out/`, in a name that carries its slug or date — the one place below `.claude/` an agent may write): a hook refuses a raw write. Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

One table for all tickets, or one ticket in detail. Everything comes from
`state.mjs` (`reference/definitions.md` § Definitions, The scripts); this skill formats, it doesn't infer.

## Input

- No argument → every work directory under `<.claude>/work/`.
- `<id>` → that ticket in detail.
- `problems` → only tickets whose state script reports a problem.
- `inline=true` — `reference/definitions.md` § Definitions (Dedicated agent); this agent's
  rating: `low` (run the state script, format its output). Nothing is logged; a
  checkpoint goes under `<.claude>/work/_scratch/`.

## Steps

### All tickets
`node <lib>/state.mjs table <.claude>/work` (`… table <.claude>/work problems` for the argument `problems`) prints the
whole board — one row per ticket (every `_`-prefixed entry — `_office/`, `_scratch/`, `_day/` — is not one), the totals
line, the problems, the worktrees that done or closed tickets still hold with the command that removes each, and stale locks
with their `unlock` command. Relay it as it is; the columns and what fills them are described under
`state.mjs table` in `reference/definitions.md`. Nothing is recomputed here.

### One ticket
`state.mjs state <workdir>` and `state.mjs durations <workdir>` → the stage list with
status and timestamp, the current complexity rating (`complexity`), minutes per stage,
the stopped question if any with its `kind`, `resume` command and default, the
blockers as last recorded (`blockedBy`, `checkedAt`), any answer queued for the stop
(`state.mjs answer <workroot> <id> --peek`), the lock (owner,
since, last refresh, stale), the PRs, the worktrees, the retro's proposal count by
target (the script's `retro` field), the problems, and the tail of `progress.md` (last
ten lines).
Say what the next action is: the stage `/tp:run-ticket <id>` would run, the question
waiting for an answer, or — for a done ticket without a retro — that `/tp:retro <id>` is
available.

### Report
The table or the detail; nothing else. No fixes are made here — a problem is reported
with the file it concerns, and the user or the owning stage resolves it.
