---
name: tp-inbox
description: Everything waiting on a person in one pass: every open stop with its kind, age and resume command; re-invokes what resumes by itself, re-checks blockers, hands the rest over as one interview.
user_invocable: true
---

One list of every open stop, and one round of answers for all of them. The state
script already classifies each stop and names its resume command (`skills/README.md`
§ Definitions, Asking the user); this skill gathers them, re-checks the blockers of
parked tickets, resumes what needs nobody, and returns the rest as a report the
session interviews from — in batches, once — before re-invoking each ticket with its
answer. Nothing is decided here; nothing is answered on anyone's behalf.

## Input

- No argument → every open stop under `<.claude>/work/` (tickets, day plans, the
  `_scratch` stops of skills without a work directory).
- `<id>` → only that ticket's stop.
- `date=<YYYY-MM-DD>` → the day plan to advance afterwards (default: today).
- `dry=true` → list only: nothing is re-invoked, no blocker re-check.
- `answers=<text>` — the answer to this skill's own error stop (§ Stops).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `medium` (one batch of lookups and a bounded classification), `low` with
  `dry=true`.

## Where it runs

The dedicated agent gathers and re-checks; **the session acts on its report**
(§ Definitions, Asking the user): it re-invokes `/tp-run-ticket <ids…>` in one
invocation for everything the report lists under *resumes by itself* and *answers
queued* (a queued answer is taken by `/tp-run-ticket` step 0, never read here), puts the
*questions* and *approvals* to the person with the interactive question tool — at most
four per call, each with its choices and the default first, `nothing to answer` items
shown rather than asked, and each item whose stop names a `doc` shown in the
conversation first (§ Definitions, Asking the user) — then re-invokes each answered ticket with `/tp-run-ticket <id>
answers="…"`, asks `retry?` for each *error* once the person has done what `needs`
names, asks `release it? (unlock)` for a lock whose run the person declares dead (only
then `state.mjs unlock <workdir> <owner> --force`), and finally `/tp-plan-day
date=<date>` when a plan exists for the day, so the freed lanes fill. Where nobody can
be interviewed (a scheduled run — § Unattended runs), the session re-invokes what
resumes by itself and prints the rest; the stops stay in the office inbox for a person
to answer there. A live lock held by another run is never re-invoked past: the report
names its owner and the ticket waits.

## Steps (inside the dedicated agent)

### 0. Register
`state.mjs agent join <.claude>/work '{ "id": "inbox:<date>:lead", "level": "lead",
"role": "inbox", "stage": "inbox", "rating": "medium" }'` — no ticket, so the office
seats it in the meeting room.

### 1. Gather
`node <.claude>/skills/_lib/state.mjs inbox <.claude>/work` → every open stop with
`kind`, `default`, `resumable`, `needs`, `resume`, `answer` (queued) and `lock`; plus
`day.mjs status <.claude>/work [<date>]` for the plan's `stopped`, `resumable`,
`waiting` and `skipped` (the skipped-blocked candidates carry their blockers). With
`<id>`, keep that ticket only.

### 2. Re-check the blockers
Not with `dry=true`. Run `skills/tp-start-ticket/instructions/blocked-check.md` § Re-check —
it owns the gather, the lookup, the recording and the resume, including the freshness
that leaves out a blocker checked minutes ago. This invocation's part of it: the
lookup's office id is `inbox:<date>:qa:<n>` with this agent as `parent`; the plan's
candidates are recorded with `dry: true` (the real advance is the session's
`/tp-plan-day` afterwards); and the inbox is read again at the end, so `resumable`
reflects what landed. Nothing to gather → say when the last check was.

### 3. Report
`instructions/report.md` — the groups, one line per stop, and the `act:` tail the
session executes. Then `state.mjs agent leave <.claude>/work inbox:<date>:lead done`
and the output contract lines (§ Definitions, Output contract).

## Stops
None of its own for a question — the report *is* the list of questions. `error: …`
— the state script refusing the work root, a lookup that failed past its fallback
(`skills/README.md` § Failures and escalation; the state in
`_scratch/inbox-<date>.md`): `answers=retry` once the person has done what `needs`
names. With `dry=true`, never an error for a missing lookup tool: the list is returned
without the re-check and says so.
