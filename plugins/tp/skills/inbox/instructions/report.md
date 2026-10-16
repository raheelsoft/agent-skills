# The inbox report — what the session acts on

`state.mjs inbox <workroot> --render` prints it; this file is its format, for the session that reads it.

One header line, then the groups in this order, only the non-empty ones, one line per stop with the stop's own wording
(never paraphrased); the last line is the `act:` tail.

```
inbox <date>: <n> open · <k> resume by themselves · <q> questions · <a> approvals · <e> errors · <b> parked · <p> problems

answers queued (re-invoke; the resume command takes the answer):
- ABC-12 · merge · answered "merge" from office 10:12 · /tp:run-ticket ABC-12
resumes by itself (re-invoke):
- ABC-9 · run-ticket · usage pause, reset 14:00 passed · /tp:run-ticket ABC-9
questions (interview, then /tp:run-ticket <id> answers="…"):
1. ABC-15 · implement:api · waiting 42m · step 3 — index the title too, or only the body? … Default: body only
approvals (interview: go-ahead, or a change):
2. ABC-18 · plan · waiting 15m · approval needed: 4 steps, risks: access-control — approve (go-ahead) or send a change
errors (needs a fix first, then answers=retry):
- ABC-20 · start-ticket · error: clone failed · needs: load the deploy key (ssh-add) · /tp:run-ticket ABC-20 answers=retry
still parked (nothing to answer):
- ABC-21 · triage · blocked by ABC-5 (In Progress)
problems (an inconsistency the state script found; needs a fix, then answers=retry):
- ABC-22 · start-ticket is done but ticket.md is missing · /tp:run-ticket ABC-22 answers=retry
locks held elsewhere (not re-invoked):
- ABC-23 · locked by sess-2 since 09:40 (live) — wait, or `unlock --force` if that run is dead

day plan <date>: <what /tp:plan-day will start once these are answered, or "no plan">

act: run ABC-12 ABC-9 · ask 1 2 · retry ABC-20 ABC-22 · show ABC-21 ABC-23 · plan-day <date>
```

Numbering is shared by questions and approvals, in waiting order (oldest first), so the session's interview and the
person's `answers=` refer to the same numbers. A stop that is `nothing to answer` is never numbered. `dry=true` returns
the report with `act: none — dry run` and no day plan line.
