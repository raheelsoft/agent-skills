# The scheduled tasks — prompts and schedules

Every prompt is self-contained: a scheduled run starts fresh, with nothing but the
prompt. `<.claude>` is the absolute path; `<slug>` the project's label; `<start>`,
`<end>`, `<every>` come from `tiers.json.day`; `<stamp>` is the run's own start time
(ISO), so every launch has its own lock owner.

## The common preamble (every task starts with it)

> You are a scheduled, unattended session for the ticket pipeline installed at
> `<.claude>` (`<.claude>/skills/README.md` is the authority). Nobody can be
> interviewed here: never put a question to a person and never wait for one — a stop
> is printed as its row (the ticket, the stage, the question, the resume command) and
> stays in the office inbox and `/tp-inbox` for a person to answer later. Before
> anything, load the pipeline's tools: the scripts under `<.claude>/skills/_lib`
> (run with node), git, the hosting platform's CLI, the tracker's tools by name
> through the tool lookup (or `<.claude>/skills/_lib/tracker.mjs` when `<.claude>/tracker.json`
> names a fixture — README § Definitions, Tracker). Every `/tp-run-ticket` you start carries
> `owner=schedule:<task>:<stamp>` and is awaited in the foreground — spawn the
> orchestrators the plan's `start` line names in one message and wait for them; when
> they return, `/tp-plan-day date=<today>` again, until nothing more starts or every
> lane waits on a person. Never `unlock --force`; never create a ticket; never answer
> a stop on anyone's behalf. Local time now is what the runtime says; `<today>` is
> today's date in that time zone.
> **A permission prompt here is a hang** — nobody can approve it and the run never
> ends: run only what the runtime's allowlist covers, exactly as it names it — the
> pipeline's scripts by their absolute path (`node <.claude>/skills/_lib/<script>.mjs
> …`, never a relative path after a `cd`), `git`, the hosting CLI's `pr`/`run`/`api`
> reads, the tracker's tools by name — and never a command outside it, however small;
> when a step would need one, skip the step, note it in your output, and go on. The
> shell's own `node` may be broken by an interactive shell setup: when `node` fails to
> start, use the binary the doctor's `node` line names (`<.claude>/work/_doctor.json`)
> or `$HOME/.nvm/versions/node/<version>/bin/node` — never edit shell configuration.

## Probe — one-shot, three minutes from `/tp-schedule on`

`taskId: pipeline-<slug>-probe`, `fireAt: <now + 3 min>`, `notifyOnCompletion: true`.

> [preamble] Then, in order: 1. invoke the `tp-doctor` skill (`/tp-doctor`) and keep its
> one-line result; 2. invoke `/tp-plan-day date=<today> dry=true` and keep its `start:`
> line; 3. write `<.claude>/work/_schedule/probe.json` as JSON: `{ "at": "<now ISO>",
> "ok": <true when the doctor reported no failure and the dry plan returned>,
> "tools": { "agent": <true when you have a tool that spawns agents>, "question":
> <true when you have an interactive question tool>, "scheduler": true }, "doctor":
> "ok"|"fail", "plan": "ok"|"error", "notes": ["<one line per thing that did not
> work, with its message>"] }`. Return one line: `probe <ok|failed> — <the notes>`.

## Morning — weekdays at `<start>` (+3 min)

`taskId: pipeline-<slug>-morning`, `cronExpression: "<start minute + 3> <start hour> * * 1-5"`.

> [preamble] If local time is past `<end>`, return `skipped: fired late (<time>)`.
> Otherwise: 1. `/tp-inbox` — re-invoke what resumes by itself, print the rest; 2.
> `/tp-plan-day date=<today> owner=schedule:pipeline-<slug>-morning:<stamp>` [`hours=`
> `focus=` when the person set them] — the plan is a proposal nobody here can
> approve: print it with its approval question as a row (it waits in the office inbox
> and `/tp-inbox`; the person answers there, and the next advance takes the answer);
> only when the person set `approve=true` for the schedule, launch the `start`
> tickets in the foreground as the preamble says and keep advancing; 3. return the
> plan's day table, what started, what stopped (as rows) and what waits.

## Advance — every `<every>` minutes between `<start>` and `<end>`, weekdays

`taskId: pipeline-<slug>-advance`, `cronExpression: "*/<every> <start hour>-<end hour - 1> * * 1-5"`.

> [preamble] If local time is before `<start>` or past `<end>`, return `skipped:
> outside the window (<time>)`. If `<.claude>/work/_day/<today>.json` does not
> exist, return `skipped: no plan for today — the morning task makes it`. Otherwise:
> 1. `/tp-inbox` — re-invoke what resumes by itself (a usage pause past its reset, a
> parked ticket whose blockers landed, an answer queued from the office — the day
> plan's `go-ahead` or adjustment included: `/tp-plan-day date=<today>` takes it), print
> the rest; 2. `/tp-plan-day date=<today> owner=schedule:pipeline-<slug>-advance:<stamp>`
> — the advance: launch what the freed lanes allow, in the foreground, and keep
> advancing (a plan still awaiting approval starts nothing: print its question as a
> row); 3. return what started, what stopped (as rows) and what waits.

## End of day — weekdays at `<end>` (+5 min)

`taskId: pipeline-<slug>-eod`, `cronExpression: "<end minute + 5> <end hour> * * 1-5"`.

> [preamble] If local time is before `<end>`, return `skipped: fired early`. Invoke
> `/tp-eod date=<today>` and return its report; the actual-hours question it leaves is
> for a person (`/tp-inbox`, the office) — never answer it.

## What the first probe found (2026-09-20)

A scheduled session that runs a command outside the allowlist — the first probe ran
`node skills/_lib/model.mjs …` by a relative path after a `cd` — waits on a
permission prompt nobody can answer and never ends; its lock owner is unique, so it
blocks nothing but itself, and `/tp-schedule status` shows it as still running. The
preamble's allowlist paragraph is the fix; `/tp-schedule status` reports a run without
activity for over ten minutes as **stuck**, with its session id, for the person to
stop.

## Guards

A task the runtime fires late (the app was closed) runs into these guards and
skips; nothing is repaired retroactively — the next window's task does the day's
work. Two launches never share a lock owner (`<stamp>`), so a run the scheduler
ended mid-way holds a lock the next run sees as another owner's until it goes stale
(six hours) — `/tp-inbox` names it; releasing it early is the person's word.
