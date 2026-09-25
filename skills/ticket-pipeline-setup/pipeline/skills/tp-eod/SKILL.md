---
name: tp-eod
description: End-of-day report: what finished, what waits on what, estimates against minutes and actual hours, tokens and cost, carry-over and estimate drift; records the person's hours per finished ticket.
user_invocable: true
---

Close the day: one report a person can read tomorrow morning, and the one fact only
a person knows — the hours they actually spent on each ticket that finished today —
recorded so `model.mjs calibrate` can teach the estimates (`skills/README.md`
§ Models and budget, Estimates). The numbers are the scripts'; this skill writes the
prose, asks the one question, and sends the line.

## Input

- `date=<YYYY-MM-DD>` — the day (default: today, local time).
- `answers=<text>` — the actual hours, numbered as the report asked them
  (`answers="1: 5 | 2: skip | 3: "` — blank takes the estimate, `skip` records
  nothing), or `retry` for an error stop.
- `dry=true` — write the report, ask nothing, send nothing.
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `medium` (a bounded summary of the day's record).

## Where it runs

The dedicated agent writes the report and returns it; **the session** puts the
actuals question to the person with the interactive question tool (one item per
finished ticket, the estimate as the default, `skip` as a choice) and re-invokes
`/tp-eod date=<date> answers="…"`, which records them and finishes. Where nobody can be
interviewed (a scheduled run), the report is printed as it is and the question waits
in the office inbox (a `_scratch/eod-<date>.stop.json` stop, answerable there).

## Steps (inside the dedicated agent)

### 0. Register
`state.mjs agent join <.claude>/work '{ "id": "eod:<date>:lead", "level": "lead",
"role": "end of day", "stage": "eod", "rating": "medium" }'`.

### 1. With `answers=` — record and finish
`_scratch/eod-<date>.stop.json` holds the numbered tickets the report asked about.
For each answered number: a positive number of hours → `state.mjs actual
<.claude>/work/<id> '{ "focusedHours": <n>, "source": "person", "by": "eod" }'`;
blank → the estimate's hours the same way; `skip` → nothing. Remove the stop file,
re-run step 2 so the report and the drift reflect them, then step 4.

### 2. The day's numbers
`node <.claude>/skills/_lib/day.mjs eod <.claude>/work <date> '{ claudeDir }'` →
`_day/<date>.eod.json`: `done` (merged, released or accepted today), `inProgress`,
`stopped` (kind, waiting time, question, resume), `parked`, `errors`, `perTicket`
(rating, estimate, actual, the pipeline's minutes, tokens, cost), `missingActuals`,
`totals` (today's tokens and cost), `budget`, `plan` and `carryOver`, `calibrate`
(the drift line). A ticket in the tracker with a time-tracking field the person
filled: one `low` lookup (`eod:<date>:qa:1`) reads it and it is recorded with
`source: "tracker"` before anything is asked.

### 3. The report — `_day/<date>.eod.md`
```
# End of day — <date>
done: <n> — <id> <title> (<stage> <time>) …
in progress: <id> at <stage> … | stopped: <id> · <stage> · <kind> · waiting <t> — <question> …
parked: <id> blocked by <ids and states> … | errors: <id> — needs <…> …
| Ticket | Rating | Estimate | Actual | Pipeline | Tokens · cost |   ← perTicket; estimate `*` when the pipeline made it
today: <tokens> tokens · $<cost> (<unpriced> unpriced) · budget <band> <pct>% at <time>
tomorrow: <carryOver> — <the plan's why>
estimates: <calibrate.drift>
```
Then, when `missingActuals` is non-empty and not `dry=true`: write
`_scratch/eod-<date>.stop.json` (`{ id: "eod:<date>", skill: "eod", slug: "<date>",
kind: "question", question: "1. <id> <title> — hours you spent? (estimate <h>h)
Default: <h> | 2. …", at, resume: "/tp-eod date=<date> answers=\"…\"" }`) and return
the report with that question as its first line — the stop (§ Definitions, Asking
the user).

### 4. Send and report
`/tp-notify "<date> · end of day · <done> done · <stopped> stopped · <tokens> tokens ·
$<cost>" level=info` (muted unless the project's `levels` include `info`; its one-line
result goes in the report). `state.mjs agent leave <.claude>/work eod:<date>:lead
done`, then the report's path and its first lines, and the output contract lines.

## Stops
The actuals question (`answers="1: <h> | 2: skip | …"`; derived from
`_scratch/eod-<date>.stop.json`, listed by `/tp-inbox` and the office until answered);
`error: …` — the day script refusing the work root, a lookup that returned nothing
twice (`skills/README.md` § Failures and escalation): `answers=retry`.
