# The inbox report — what the session acts on

One header line, then the groups below in this order, only the non-empty ones, one
line per stop in the form `<ticket or skill:slug> · <stage> · waiting <time> ·
<question> · resume: <command>`; the wording of a question is the stop's own,
never paraphrased. The last line is the `act:` tail.

```
inbox <date>: <n> open · <k> resume by themselves · <q> questions · <a> approvals · <e> errors · <b> parked · <p> problems

answers queued (re-invoke; the resume command takes the answer):
- ABC-12 · merge · answered "merge" from the office 10:12 · /tp-run-ticket ABC-12
- plan-day:2026-09-21 · plan-day · answered "go-ahead" from the office 09:20 · /tp-plan-day date=2026-09-21

resumes by itself (re-invoke):
- ABC-9 · run-ticket · usage pause, reset 14:00 passed · /tp-run-ticket ABC-9
- ABC-7 · triage · blocked by ABC-3 (Done, resolved), ABC-4 (Done, resolved) — unblocked · /tp-run-ticket ABC-7

questions (interview, then /tp-run-ticket <id> answers="…"):
1. ABC-15 · implement:api · waiting 42m · step 3 — index the title too, or only the body? title too | body only? Default: body only
2. ABC-16 · triage · waiting 2h 10m · 1. which repo? api | web? Default: api | 2. keep the flag? Default: yes

approvals (interview: go-ahead, or a change):
3. ABC-18 · plan · waiting 15m · approval needed: 4 steps, risks: access-control — approve (go-ahead) or send a change
4. plan-day:2026-09-21 · plan-day · waiting 5m · approval needed: day plan 2026-09-21 — 6 tickets — now: ABC-30, ABC-31 · then: ABC-32 after ABC-30 — approve (go-ahead), or adjust: … · /tp-plan-day date=2026-09-21 answers="…"

errors (needs a fix first, then answers=retry):
- ABC-20 · start-ticket · error: clone failed · needs: load the deploy key (ssh-add) · /tp-run-ticket ABC-20 answers=retry

still parked (nothing to answer):
- ABC-21 · triage · blocked by ABC-5 (In Progress) · re-checked <time>

problems (an inconsistency the state script found; needs a fix, then answers=retry):
- ABC-22 · start-ticket is done but ticket.md is missing · /tp-run-ticket ABC-22 answers=retry

locks held elsewhere (not re-invoked):
- ABC-23 · locked by sess-2 since 09:40 (live) — wait, or `unlock --force` if that run is dead

day plan <date>: <what /tp-plan-day will start once these are answered, or "no plan">

act: run ABC-12 ABC-9 ABC-7 · ask 3 · retry ABC-20 ABC-22 · show ABC-21 ABC-23 · plan-day <date>
```

Numbering is shared by questions and approvals, in waiting order (oldest first), so
the session's interview and the person's `answers=` refer to the same numbers. A
`nothing to answer` stop is never numbered. `dry=true` returns the same report with
`act: none — dry run` and no re-check line.
