---
name: tp-status
description: Show where every ticket in the work directory stands — stage, rating, waits, lock, PR and verdict, time, tokens and cost, worktrees, retro, problems — computed by the state script.
user_invocable: true
---

One table for all tickets, or one ticket in detail. Everything comes from
`state.mjs` (`skills/README.md` § Definitions, The scripts); this skill formats, it doesn't infer.

## Input

- No argument → every work directory under `<.claude>/work/`.
- `<id>` → that ticket in detail.
- `problems` → only tickets whose state script reports a problem.
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `low` (run the state script, format its output). Nothing is logged; a
  checkpoint goes under `<.claude>/work/_scratch/`.

## Steps

### All tickets
`node <.claude>/skills/_lib/state.mjs all <.claude>/work` → one row per ticket
(every `_`-prefixed entry — `_office/`, `_scratch/`, `_day/` — is not one):

```
| Ticket | Title | Decision · rating | Estimate | Status | Next / waiting on | Run | PR · verdict · merged | Tokens · cost | Last event | Age |
```
`Estimate` is the row's `estimate` — `<focusedHours>h · <days>d` with `*` when the
pipeline made it (`source: pipeline`), followed by `actual <h>h` when `/tp-eod` recorded
the person's hours, empty when there is none (`skills/README.md`
§ Models and budget, Estimates).
`Status` is `in-progress`, `stopped` (with the stop's `kind` and the question in *Next
/ waiting on* — `blocked` shows `blockedBy` with each blocker's last recorded state
and `checkedAt`, and `unblocked` when all are resolved; an answer queued for the stop
shows as `answer queued (<by>, <when>)`),
`closed` (closed early — the `why` in *Next / waiting on*), `done` or `error` (a
directory the script could not read — its problem in *Next / waiting on*); a `done`
ticket whose `retro` is non-null shows `done · retro`. `Run` is the
lock (`skills/README.md` § Concurrency): `<owner> since <time>`, `stale` appended when
the script says so, empty otherwise. `Tokens · cost` is the row's `tokens` (the sum of
logged `tokens=<n>`; empty when the runtime reports none) and `cost` as `$<n>`, with
`+<m> unpriced` when tokens carried no tier or `tiers.json` names no price for it, and
`partial` when the run said so (§ Models and budget, Cost). Below the table: the
totals line (`state.mjs totals`: tokens, cost, today's share), tickets with problems (each problem on its own line), and tickets that are done
or abandoned but still hold a worktree (`worktrees` non-empty: the ticket's one
worktree per repo, kept for the whole run and removed by `/tp-accept`'s `done` or the
close-out of a closed or parked ticket — `skills/README.md` § Worktrees; a stopped
ticket keeps it on purpose and is not listed here) — for each, the exact cleanup:
`git -C <repo path> worktree remove <workdir>/wt/<entry>` with the repo path from
`ticket.json` (by name), then the directory. A stale lock is listed with
`state.mjs unlock <workdir> <owner>`; a live lock of a run the user declares dead
with `--force` (`skills/README.md` § Concurrency).

### One ticket
`state.mjs state <workdir>` and `state.mjs durations <workdir>` → the stage list with
status and timestamp, the current complexity rating (`complexity`), minutes per stage,
the stopped question if any with its `kind`, `resume` command and default, the
blockers as last recorded (`blockedBy`, `checkedAt`), any answer queued for the stop
(`state.mjs answer <workroot> <id> --peek`), the lock (owner,
since, last refresh, stale), the PRs, the worktrees, the retro's proposal count by
target (the script's `retro` field), the problems, and the tail of `progress.md` (last
ten lines).
Say what the next action is: the stage `/tp-run-ticket <id>` would run, the question
waiting for an answer, or — for a done ticket without a retro — that `/tp-retro <id>` is
available.

### Report
The table or the detail; nothing else. No fixes are made here — a problem is reported
with the file it concerns, and the user or the owning stage resolves it.
