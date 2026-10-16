---
name: eod
description: Reports the end of the day: what finished, what waits on what, estimates against minutes and actual hours, tokens and cost, carry-over and estimate drift, and records the person's hours per finished ticket. Use at the end of a working day.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`). Its checkpoint and any other document it writes in the work directory go through `node <lib>/state.mjs doc <.claude>/work/<_day|_scratch> <name>` (the text on stdin or `--from <file>`; a draft or a command's output goes under `<.claude>/worktrees/_out/`, in a name that carries its slug or date — the one place below `.claude/` an agent may write): a hook refuses a raw write. Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

Close the day: one report a person can read tomorrow morning, and the one fact only
a person knows — the hours they actually spent on each ticket that finished today —
recorded so `model.mjs calibrate` can teach the estimates (`reference/models-and-budget.md`
§ Models and budget, Estimates). The numbers are the scripts'; this skill writes the
prose, asks the one question, and sends the line.

## Input

- `date=<YYYY-MM-DD>` — the day (default: today, local time).
- `answers=<text>` — the actual hours, numbered as the report asked them
  (`answers="1: 5 | 2: skip | 3: "` — blank takes the estimate, `skip` records
  nothing), or `retry` for an error stop (`retry` is not hours: go to step 2).
- `dry=true` — write the report, ask nothing, send nothing.

## Where it runs

**In the invoking context** — no agent is spawned to run one script and relay its report (`reference/definitions.md`
§ Definitions, Dedicated agent). This context runs the steps below and puts the actuals question to the person with
the interactive question tool (one item per finished ticket, the estimate as the default, `skip` as a choice), then
runs step 1 with the answers. Where nobody can be interviewed (a scheduled run), the report is printed as it is and the
question waits in the office inbox (a `_scratch/eod-<date>.stop.json` stop, answerable there).

## Steps

### 1. With `answers=` — record and finish
`node <lib>/day.mjs eod <.claude>/work <date> --answers "<the answers text>"` records them from
`_scratch/eod-<date>.stop.json` (a positive number of hours → `state.mjs actual … source: "person"`; blank → the
estimate's hours; `skip` → nothing), removes the stop, and writes the report again so it and the drift reflect
them. Then step 4.

### 2. The day's numbers and the report
`node <lib>/day.mjs eod <.claude>/work <date> --render` (add `--dry` for `dry=true`) writes
`_day/<date>.eod.json` (`done`, `inProgress`, `stopped`, `parked`, `errors`, `perTicket`, `missingActuals`,
`totals`, `budget`, `plan`, `carryOver`, `calibrate`) and **the report `_day/<date>.eod.md` itself** — done,
in progress, stopped, parked, errors, the per-ticket table (estimate `*` when the pipeline made it), today's
tokens and cost, tomorrow's carry-over, the drift line — and, unless dry, the stop that asks for the missing
hours (`_scratch/eod-<date>.stop.json`). The report is the script's: relay it, do not rewrite it.

When the project's tracker has a time-tracking field the person fills: first run the same command without
`--render` for `missingActuals`, read those tickets' field in this agent (a tracker call — no sub-agent, rule 9),
record each with `node <lib>/state.mjs actual <.claude>/work/<id> '{ "focusedHours": <n>, "source": "tracker", "by": "eod" }'`,
and only then `--render`, so the question leaves them out.

### 3. Return
The script's JSON names the report's path and, when hours are missing, the question (`asks`): return the path and
the `asks` line as the first line — the stop (§ Definitions, Asking the user) — not the report's text.

### 4. Send and report
`/tp:notify "<the script's notify line>" level=info` (muted unless the project's `levels` include `info`; its one-line
result goes in the report). then the report's path and its first lines.

## Stops
The actuals question (`answers="1: <h> | 2: skip | …"`; derived from
`_scratch/eod-<date>.stop.json`, listed by `/tp:inbox` and the office until answered);
`error: …` — the day script refusing the work root, a lookup that returned nothing
twice (`reference/failures-and-stops.md` § Failures and escalation): `answers=retry`.
