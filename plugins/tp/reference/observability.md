# Observability and unattended runs

What is visible and where, and the same pipeline run as a script or on a schedule.

**Contents** — [Observability](#observability--what-is-visible-where) (the office) · [Unattended runs](#unattended-runs) (scheduled runs)

## Observability — what is visible, where

- `progress.md` + the JSON files hold every stage's state, facts and timings; `/tp:status`
  renders them for all tickets — stage, waiting-on, rating, lock, PR and verdict,
  tokens, worktrees, problems.
- The ticket gets an estimate when it has none (§ Models and budget, Estimates) and a
  comment at pickup, plan ready, PR opened (with manual steps),
  every update round, merged, released, accepted; its status goes in progress at pickup and in review when
  the PR opens; done is the person's call (§ Tickets).
- The PR carries the description, the review comment with its trailer, one comment per
  update round. Each skill ends with a short report.
- `/tp:notify` is the outbound voice: one line per stop and at the end of a run to the
  channel `<.claude>/notify.json` names, with the project label in front. The channel
  is asked for once: whenever `<.claude>/notify.json` does not exist, the context
  invoking any entry point — `/tp:run-ticket`, `/tp:plan-day` or a stage skill — runs
  `/tp:notify setup` first, in the session where a person can name it (an unattended run
  records the tool and leaves the channel unset); no chat tool → nothing sent,
  nothing fails.
- **The office** shows who is at work right now: Team (`office.json`) → one room per
  project (repo) → a pod per active ticket → desks — the manager lane on top, leads and
  reviewers in a pod, engineers and QA beneath their lead; a desk carries the agent's
  name (from the pools in `office.json`, stable per agent id), level, role, stage and
  rating, and its state: working, stopped with the question, done, gone; an agent
  with no ticket (`/tp:plan-day`) sits in the meeting room. Presence
  comes from the agents themselves (§ Definitions, Office presence) through
  `state.mjs agent join|leave`; `state.mjs office <.claude>/work` is the JSON the page
  polls. Around the floor: the **inbox** — every open stop with its kind, waiting
  time, what it needs and its resume command (copied with one click); an answer typed
  there is queued in `work/_inbox/` for that exact stop and taken by the next
  `/tp:run-ticket <id>` (§ Definitions, Asking the user; the server accepts it from the
  page only, never in demo mode) — with a count in the page title, a desktop
  notification per new stop once the person allows them (the `alerts` button) and the
  dock badge in the Electron shell; the **day board** — the latest `_day/<date>.json`
  with live statuses (`day.mjs status`, never written by the office; marked as an
  earlier day's plan when older than today): the day table, the load bar, every
  ticket's chip, what waits and why; the **ticket drawer** (click a ticket) — links,
  rating and estimate against the recorded actual, the stop with its resume command,
  stages with minutes, PRs and verdicts, blockers as last checked, tokens and cost,
  and the ticket's own `plan.md`, `ticket.md`, `triage.md`, `report.md`, `accept.md`
  or `retro.md` read-only; the **budget gauge** — the last usage reading `pick`
  recorded (`_budget.json`) with its age; the **doctor chip** — the last preflight
  (§ Using it, Preflight); and the **totals** — tokens and cost, today and all time.
  Serve it with `node <plugin>/office/serve.mjs --work <.claude>/work` (port 4820;
  `--sim` plays a demo of every panel) or open the Electron wrapper in
  `<plugin>/office/electron`.
- `/tp:retro` turns the record into proposals for the person to apply or not.

## Unattended runs

The plugin's `workflows/run-ticket-unattended.js` is the same pipeline as a script for the runtime's
workflow-script tool: one agent per stage per ticket, each the stage skill's dedicated agent
(it invokes the skill with `inline=true`), stages chained per ticket with no barrier
between tickets. Opt-in: it spawns many agents, so the person starts it explicitly;
`/tp:run-ticket` in a session is the interactive default. The script's header documents
its arguments (`claudeDir` — the project's `.claude`, `pluginRoot` — `${CLAUDE_PLUGIN_ROOT}` of the
skill that starts it, `tickets`, `tiers` — the contents of `tiers.json`, required
because a script reads no files — `options`, `answers`, `owner`), its rows and how a
stopped ticket resumes (`resumeFromRunId` + `answers[<id>][<stage>]`, the stage from
the row; `answers=resume` after a usage pause; `retry` after an error row, whose
`resume` and `needs` fields say what to do) — the session that started the script
interviews the person with a stopped row's question as it would for any stop
(§ Definitions, Asking the user) and resumes the run with the answer; only a schedule
nobody watches prints the row instead. What differs from the interactive run: the
stage agent's rating is the `complexity` the previous stage reported (`options.tier`
floors it and is the only `tier=` passed down), `escalate: true` is its name for
`complexity: higher` and escalates one step per invocation, hand-offs are capped per
rating from `tiers.compact.handoffs` and the cap is a `needs_input` row answered with
`continue`, `options.merge` carries `merge=`, a done and not-stale stage is never
re-invoked (except `start-ticket` on a new round), every planned ticket's first run
ends as a `needs_input` row at `plan` — the approval — resumed with
`answers[<id>].plan = "go-ahead"`, the script re-spawns only a stage
that returned nothing (a stage's own auto-resolve happens inside it; the script cannot
classify an error), the stage leads' own tokens are never recorded — their sub-agents'
are, as in any run — so the close-out logs `run-ticket note "tokens partial — stage
leads unrecorded"` and the ticket's totals show `partial`, and `/tp:notify setup` runs
record-only because nobody can answer. It has no lanes and no dependency order —
`/tp:plan-day` is session-only; to run a day plan unattended, launch one batch of its
`batches` at a time — or schedule the day (below).

**Scheduled runs.** `/tp:schedule on` creates, through the runtime's scheduler, three
tasks for the project: a **morning** task at `tiers.json.day.start` (`/tp:inbox`, then
`/tp:plan-day` for today), an **advance** task every `day.advanceEvery` minutes until
`day.end` (`/tp:inbox`, then the plan's advance), and an **end-of-day** task at
`day.end` (`/tp:eod`) — weekdays only, each prompt self-contained
(`skills/schedule/instructions/tasks.md`). A scheduled session is fresh and
unwatched: it cannot interview anyone, so it re-invokes only what resumes by itself
(a usage pause past its reset, a parked ticket whose blockers landed, an answer
queued from the office), prints every other stop as its row, and leaves it in the
office inbox and `/tp:inbox` for a person; it spawns the day's orchestrators in one
message and **awaits them in the foreground** (a scheduled session that ends its turn
may end its background children with it), under a lock owner of its own per launch
(`schedule:<task>:<stamp>`), never `until=`. A task the runtime fires late (the app
was closed) skips outside its window rather than repairing the day. Before any
recurring task exists, a one-shot **probe** (three minutes after `/tp:schedule on`)
runs `/tp:doctor` and a dry `/tp:plan-day` in exactly that setting and records what a
scheduled session can do here (`work/_schedule/probe.json`); `/tp:schedule on` a second
time creates the tasks only when it passed. `/tp:schedule off` disables them;
`/tp:schedule status` lists them with their last runs.
