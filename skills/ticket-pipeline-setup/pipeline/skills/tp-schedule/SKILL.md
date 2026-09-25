---
name: tp-schedule
description: Create, disable or list the scheduled tasks that run the pipeline unattended on weekdays: a probe first, then the morning (/tp-inbox, /tp-plan-day), advance and end-of-day (/tp-eod) tasks.
user_invocable: true
---

The pipeline on a timer. A scheduled run is a fresh session nobody watches
(`skills/README.md` § Unattended runs, Scheduled runs): it cannot interview anyone,
so it re-invokes only what resumes by itself, prints every stop as its row, and
leaves the rest in the office inbox and `/tp-inbox`. This skill only creates, disables
and lists those tasks — through the runtime's scheduler, found with the tool lookup
(§ Definitions, Runtime notes); without one it says so and does nothing.

## Input

- `on` — create or update the three tasks (after a passing probe); `off` — disable
  them (never delete: their run history stays); `status` — the tasks, their next and
  last runs, the probe.
- `hours=`, `focus=` — forwarded to the morning task's `/tp-plan-day` (a standing short
  day); the window itself comes from `tiers.json.day` (`start`, `end`,
  `advanceEvery` — § Models and budget).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `low` (a few scheduler calls and a file).

## Steps

### 0. Register; the scheduler
`state.mjs agent join <.claude>/work '{ "id": "schedule:<date>:lead", "level":
"lead", "role": "scheduler", "stage": "schedule", "rating": "low" }'`. Find the
scheduler with the tool lookup (a tool that creates a recurring or one-time task
from a prompt — `scheduled task`, `cron`, `schedule`); none → the report says
`no scheduler in this runtime — the day runs from a session (/tp-plan-day)` and step 3.
Read `tiers.json.day` (`start`, `end`, `advanceEvery`), the project slug
(`notify.json.project`, else the folder that holds `<.claude>`) and
`<.claude>/work/_schedule/tasks.json` / `probe.json` when they exist.

### 1. `on`
- **No passing probe** (`probe.json` missing, `ok: false`, or older than seven days):
  create the one-shot probe (`instructions/tasks.md` § Probe; fires in three minutes,
  the runtime notifying this session when it ran), record it in `tasks.json`
  (`{ project, timezone, tasks: { probe: <id> }, createdAt, updatedAt }`) and return
  `probe scheduled for <time> — run /tp-schedule on again once it has fired`. The probe
  proves what a scheduled session can do here: the tools it finds, the doctor, a dry
  plan.
- **A passing probe**: create or update `pipeline-<slug>-morning`,
  `pipeline-<slug>-advance` and `pipeline-<slug>-eod` from `instructions/tasks.md`
  with the cron lines it derives from the window (weekdays only), every prompt filled
  with the absolute `<.claude>`, the window and the slug; record their ids in
  `tasks.json`; report the three schedules in local time.

### 2. `off` / `status`
`off`: disable the three tasks through the scheduler (its update or disable
operation; the probe too), mark them `disabled` in `tasks.json`. `status`: list the
pipeline's tasks as the scheduler reports them (schedule, enabled, next run, last run
and its one-line summary), the probe's result, and the window; a run still marked
running with no activity for over ten minutes is reported **stuck** with its session
id — almost always a permission prompt nobody could answer (`instructions/tasks.md`
§ What the first probe found) — for the person to stop.

### 3. Report
What was created, disabled or listed; the window; where stops go (`the office inbox
and /tp-inbox`); then `state.mjs agent leave <.claude>/work schedule:<date>:lead done`
and the output contract lines.

## Stops
None for a question. `error: …` — the scheduler refusing a task (its message), the
probe reporting `ok: false` (its notes are `needs`): `answers=retry` once the person
has done what `needs` names.
