---
name: tp-plan-day
description: Plan a day's work and put it to the person first: pick tickets from the sprint or a seeded pool draw, check blockers and dependencies, estimate and schedule, present the plan for review (drop, add, keep only, reorder, lanes), then on the go-ahead start every unblocked, independent ticket in parallel through /tp-run-ticket — dependents as their prerequisites land — within the usage budget.
user_invocable: true
---

Turn "what runs today?" into running pipelines: select the day's tickets from the
tracker, prove each one is unblocked, work out which depend on which, write the plan
to `<.claude>/work/_day/<date>.json` as a **proposal the person reviews** — approve
it, or drop, add, keep only, reorder, cap the lanes — and, on the go-ahead, start
every ready ticket through `/tp-run-ticket`; then, each time one of them returns, start
what became ready. Nothing starts before the go-ahead (`approve=true` skips the
review for a person who wants the plan run as drawn). The selection is a dedicated
agent's; the interview and the launching are the session's (§ Where it runs).
`skills/README.md` defines the dedicated-agent rule, the work directory, the scripts
and the budget.

Invoking this skill carries `/tp-start-ticket`'s authorization for every ticket it starts
(assign, move to in progress, branch) and `/tp-run-ticket`'s for the stages that follow.
The planner itself only reads the tracker.

## Input

- `[<feature> …]` — feature names, quoted when they have spaces (`"Roles & Permissions"
  "Search inventory"`); none → the whole sprint or pool.
- `date=<YYYY-MM-DD>` — the day (default: today, local time); the plan's key and the
  draw's seed, so the same day plans the same way twice.
- `from=sprint|pool` — override the detection (step 1).
- `count=<n>` — at most n tickets (default: every qualifying sprint ticket; for the
  pool, `tiers.json.day.draw`, 6). `lanes=<n|all>` — runs at once (default: from the
  budget band, § Models and budget — `all` unless the usage window is tight: every
  ticket that is unblocked and waits on nothing runs in parallel).
- `hours=<n>`, `focus=<0–1>` — today's workday when it differs from `tiers.json.day`
  (a half day: `hours=4`; a meeting-heavy day: `focus=0.4`) — § Models and budget,
  Estimates.
- `replan=true` — select again for a day that already has a plan (tickets already
  started keep their place); the new selection is a proposal again. `dry=true` —
  write and report the plan, ask nothing, start nothing. `approve=true` — run the
  plan as drawn without the review.
- `merge=`, `retro=`, `tier=`, `owner=` — forwarded to every `/tp-run-ticket` this plan
  starts (never `until=`: a run that ends early keeps its lane busy).
- `answers=<text>` — the answer to this skill's last stop (§ Stops) — for the plan's
  review: `go-ahead`, or adjustments separated by ` | `: `drop <ids>`, `only <ids>`,
  `add <ids>`, `first <ids>`, `lanes=<n|all>`, `hours=<n>`, `focus=<0–1>` (step 6b).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `medium` (many lookups; two judgments — what matches a feature, what depends
  on what).

## Where it runs

Without `inline=true` the invocation spawns the dedicated agent as every skill does,
then acts on its report. A **proposal** (the report ends in the approval question,
step 6b) is the interview: the session shows the day's plan — `_day/<date>.md`, the
stop's `doc` — in the conversation first, then puts it to the person with the
runtime's question tool — one item, the approval question as it stands, `go-ahead` the
default choice and the adjustments as its free-text "other" (§ Definitions, Asking the
user: the plan is read in the thread, not squeezed into an option)
— and re-invokes `/tp-plan-day date=<date> answers=…`; an adjustment comes back as a new
proposal until the person says `go-ahead`. Then the `start:` line names the tickets
to run now, and the session invokes `/tp-run-ticket <ids…> checked=<the blocked check's
timestamp> [merge= retro= tier= owner=]`
— one
invocation, every id, so they run side by side in their own orchestrators — spawned
together, in one message, never one after another (`/tp-run-ticket`, Where it runs). The
orchestrators are spawned by the session, never by this skill's agent: one level
deeper, their stage agents would sit past the depth that can spawn (§ Definitions,
Depth). Whenever a run this plan started returns — its report or its stop — the
session invokes `/tp-plan-day date=<date>` again: with a plan on disk that invocation only
advances (step 7), so the next ready tickets start as lanes free and prerequisites
finish. A stop is interviewed and resumed exactly as `/tp-run-ticket` describes; the plan
keeps that ticket as running until its work directory says otherwise. `dry=true`
returns the plan with `start: none — dry run`. Where nobody can be interviewed (a
scheduled run — `skills/README.md` § Unattended runs, Scheduled runs) the session
launches the same way but awaits the runs in the foreground and prints every stop as
its row; the stops wait in the office inbox and `/tp-inbox`, and the next scheduled
advance picks up what was answered there.

## Steps (inside the dedicated agent)

### 0. Preflight, register; plan or advance
The **preflight** first (§ Using it, Preflight owns the rule and the exit codes; the
`/tp-doctor` it may invoke is a dedicated agent with this one as `parent`, `inline=true`
when this agent cannot spawn) — nothing is planned before it. Then
`state.mjs agent join <.claude>/work '{ "id": "plan-day:<date>:lead", "level": "lead",
"role": "day planner", "stage": "plan-day", "rating": "medium" }'` — no ticket, so the office seats it in
the meeting room. Without `answers=`, `state.mjs answer <.claude>/work plan-day:<date>
--consume` first: exit 0 → the queued answer (typed in the office, § Definitions,
Asking the user) is this invocation's `answers=`. With `answers=` → step 6b's routing
(`_scratch/plan-day-<date>.input.json` holds what was gathered, so nothing is fetched
twice; any other stop resumes from `_scratch/plan-day-<date>.md`).
`<.claude>/work/_day/<date>.json` exists and no `replan=true` → step 7 (an unapproved
plan there is the proposal again, step 6b). Otherwise steps 1–6.

### 1. Sprint or pool
`from=` given → that. Otherwise ask the tracker for the team's active iteration — the
concept differs per tracker (cycle, sprint, iteration, a milestone with dates), and a
team without one often runs sprints as **labels** (`Sprint 4`, dates in the label's
description, the conventions file or the tickets' due dates): when the tracker has no
iteration object, read the label set. One whose dates include the day and that holds
open tickets → `sprint` (keep its name and dates for the plan). None — no iterations
at all, or a gap between two (the last one ended, the next has not begun) → `pool`,
and the report names the next sprint and when it starts. `from=sprint` on a gap day
takes the next sprint when its tickets are already assigned, else the last one's
leftovers.

### 2. Candidates
`instructions/selection.md` § Scope and § Candidates: the tracker project(s), team or
board the conventions file or the person's standing instructions name — the scope
`/tp-start-ticket next` uses; none named → `stopped "which tracker project or team?"`.
Sprint → every ticket in the iteration; pool → every open ticket in scope, narrowed by
any standing scope (one repo, a ticket kind) before anything is drawn. Keep tickets in
a not-started state; a container ticket contributes its children, not itself. A ticket
with a work directory is **in flight** — listed with its state, never selected again.
**Two passes, and the first spawns nothing** (`skills/README.md` § Context management,
rules 4, 9 and 12; the same shape as `/tp-start-ticket`'s blocker reads). First, **this
agent's own tracker list**, in one message for the whole scope: id, title, state,
assignee, labels, parent, priority, the tracker's estimate and the blocked-by ids with
their states — everything `instructions/selection.md` § Candidates calls metadata. The
filters above, the feature filter of step 3 and the pool draw of step 4 all run on that
alone, so a ticket someone else owns, one already in flight, one in the wrong state and
one the day will not reach are dropped before a word of them is read.
Only then, **for the tickets still standing — the ones this day will actually plan** —
fetch what a list cannot give (prose dependencies, repo hints, the estimate signals) in
one batch of `low`-rated read-only agents: several tickets per agent, spawned in one
message and awaited in the foreground (§ Definitions, Runtime notes), each given the
tracker's read tools by name (§ Definitions, Tracker), the office id
`plan-day:<date>:qa:<n>` (a lookup is `qa`) with this agent as `parent`, the join/leave
commands and the row format of § Candidates. A morning that weighs nineteen tickets to
plan five reads five, in one agent, not nineteen in four — an agent costs its floor
before it reads anything (rule 9), and a sprint whose list already answers everything
needs none at all.

### 3. Feature filter
Only with feature names: `instructions/selection.md` § Matching a feature. A name that
matches nothing is a stop: `stopped "no <sprint|pool> ticket matches <name> — drop it,
take it from the pool, or name the ids?"` (`answers=drop|pool|<ids>`).

### 4. Blocked check
`skills/tp-start-ticket/instructions/blocked-check.md` on every candidate, the blockers
fetched in the same batch (a blocker whose recorded state is fresh is not fetched again
— that file's § Freshness). Keep the verdict's timestamp: it goes to the runs as
`checked=` (§ Where it runs), so no pickup repeats this check. Per ticket: **blocked** (an unresolved blocker outside the
candidates) → skipped, with the blocker named and its ids passed as `blockedBy` (the
plan keeps the candidate whole, so a later advance can re-queue it — § Re-check);
**soft-blocked** → skipped, listed; a
blocker that is itself a candidate or in flight is not a blocker but a dependency
(`after`); **not blocked** → kept. A dependency stated in prose ("depends on ABC-142",
"after the export work") is an `after` edge when its target is a candidate or in
flight, a note in the report otherwise. Nothing is assigned, moved or branched here.

### 5. Rate and estimate
Each kept ticket gets the pickup rating (`/tp-start-ticket` step 9's rule — from the
ticket alone; `/tp-start-ticket` rates again when it runs), the tracker's priority, when
it has one, as a number (lower first), and its **hours** — the person's focused hours
as § Models and budget, Estimates defines them: the tracker's estimate when the
ticket has one (converted as that section says, `hoursSource: "tracker"`), else the
four signals (`repos`, `flags`, `unclear`, `novelty`, read the same way as at pickup)
for the script to estimate from. A ticket in flight takes its hours from its
`ticket.json.estimate` (`hoursSource` = its `source`), for its attention share.

### 6. The plan
Write the gathered input to `<.claude>/work/_scratch/plan-day-<date>.input.json`
first (the re-plan after an adjustment reads it instead of fetching again), then
`node <.claude>/skills/_lib/day.mjs plan <.claude>/work '{ date, from, iteration,
features, band, lanes?, count?, hours?, focus?, stackable, claudeDir, dry, review,
drop?, only?, first?, tickets: [{ id, title, rating, priority, after, blocked, soft,
hours?, hoursSource?, repos, flags, unclear, novelty }] }'` — `review: true` unless
`approve=true` or `dry=true` (the plan is a proposal: nothing starts, `proposed`
names what would, `question` is the approval stop, written to
`_scratch/plan-day-<date>.stop.json` by the script so the inbox and the office list
it); `band` from `model.mjs budget` on the usage reading;
`stackable` true when the conventions file stacks dependent tickets on one branch
(`/tp-start-ticket` step 7, case 1). The script skips anything that waits on a ticket
outside the day, draws the pool with the date as the seed (a dependent only with its
prerequisites), orders the sprint by priority then by what unblocks the most, puts
what the previous day's plan left unfinished first, batches by dependency, and then
**schedules the person's days** as § Using it, A day at a time describes (the
arithmetic is `day.mjs`'s header). Today's `start` is **every ready ticket** —
unblocked, no unfinished prerequisite — up to the lanes, which by default cap nothing:
independent tickets run in parallel, and a dependent starts the moment its
prerequisites are on the base (or open, when the project stacks). The person's days
are the attention forecast for the report, never a gate on the pipeline. It writes
`_day/<date>.json` and `.md` (the day table).
Exit 1 with `cycle` → `stopped "<ids> depend on each other — leave out which?"`
(`answers=<id>`; re-run with that id marked `blocked: "cycle — left out"`).

### 6b. The review — the person approves or adjusts the plan
The report is the plan (step 8's content) followed by the script's `question`,
verbatim — `approval needed: day plan <date> — <n> tickets — now: A, B · then: C
after A — approve (go-ahead), or adjust: drop <ids> | only <ids> | add <ids> | first
<ids> | lanes=<n|all>` — as this skill's stop (kind `approval`, default `go-ahead`;
§ Stops). Nothing is launched. On the re-invocation with `answers=`:
- `go-ahead` → `node <.claude>/skills/_lib/day.mjs approve <.claude>/work <date> '{
  by: "person"|"office", band, claudeDir }'` — the plan is approved, the stop
  removed, and its `start` is the report's `start:` line (the session launches).
- adjustments, separated by ` | ` → re-plan from `_scratch/plan-day-<date>.input.json`
  with them applied — `drop <ids>` and `only <ids>` and `first <ids>` go to the
  script as `drop`, `only`, `first`; `lanes=`, `hours=`, `focus=` as themselves;
  `add <ids>` fetches those tickets exactly as step 2 (with their blockers, one
  batch) and appends them to the input, blocked-checked as step 4 — then step 6
  again with `review: true`: the adjusted plan is the new proposal, presented the
  same way (its stop replaces the old one; an answer queued for the old proposal is
  stale by construction). An id the tracker does not know → the question again with
  `unknown: <ids>` in front.
- anything else → the question again, prefixed `not understood: <text>`.

### 7. Advance (a plan exists)
First the **blocker re-check**: `skills/tp-start-ticket/instructions/blocked-check.md`
§ Re-check as written — it owns the gather, the lookup, the recording and the
freshness that skips a blocker an `/tp-inbox` minutes earlier already checked. This
invocation's part: the lookup's office id is `plan-day:<date>:qa:<n>`, and the rows for
this plan's skipped candidates go into the advance below as `recheck`. Then `day.mjs advance <.claude>/work <date> '{ band, claudeDir, recheck }'`
— the band read again, because the budget has moved since the morning. An unapproved
plan advances nothing: the script returns the proposal and its `question` again,
which is this invocation's report (step 6b) — the re-check is still recorded. The script
refreshes every planned ticket from its work directory (running, stopped with its
question, done, failed — a ticket with no work directory half an hour after its
start), records the re-check, re-queues and schedules a candidate whose blockers are
all resolved (`unblocked`), frees the lanes, and returns what starts now — every
dependent whose prerequisites just landed, in parallel — what waits and on what,
`resumable` and `finished`. Every `resumable` ticket — a usage pause
whose reset has passed, a parked ticket the state now reports `unblocked` — is
re-invoked (`/tp-run-ticket <id>`) and counts as running (§ Work directory, the grammar;
§ Definitions, Resume). The re-check is the one tracker read of an advance; the
selection itself is never re-fetched — `replan=true` is the way to change it. A
ticket with a queued answer (the row's `answer`, from the office) is re-invoked the
same way; `/tp-run-ticket` takes the answer (§ Definitions, Resume).

### 8. Report
Mode and iteration; the day (`8h at 65% = 5.2h`); features; candidates → planned /
in flight / skipped (each with its reason) / not drawn; the day table (`day 1 · A
5.2h · day 2 · A 0.8h, B 4h`), hours marked `*` when the model estimated them; the
batches (`now: A B · then: C after A · D after B, C`);
what is stopped and its question; `re-checked: <id> still blocked by <ids and
states> · <id> unblocked → queued|resumed` (advance only); `approved: <when> (<by>)`
or the proposal's `proposed: <ids>`; `start: <ids>` or `start: none — <why>`; the
plan's path — and, for a proposal, the approval question last (step 6b). Then `state.mjs agent leave <.claude>/work plan-day:<date>:lead done` and the
output contract lines (§ Definitions, Output contract).

## Stops
**The plan's review** — every plan, kind `approval`: `approval needed: day plan
<date> — …` (`answers=go-ahead`, or `drop <ids> | only <ids> | add <ids> | first
<ids> | lanes=<n|all> | hours=<n> | focus=<0–1>`, several joined by ` | `; the stop
file is the script's, `_scratch/plan-day-<date>.stop.json`, removed by `approve`).
Nothing names the tracker scope (`answers=<project or team>`); a feature name with no
match (`answers=drop|pool|<ids>`); a dependency cycle (`answers=<id to leave out>`); a
usage pause (`stopped "usage at <n>% of <window> — resume after <reset>"` — the plan is
written first, so `/tp-plan-day date=<date>` after the reset only advances); `error: …`
— the tracker unreachable past its fallback, `day.mjs` refusing its input, a fetcher
that returned nothing twice (`skills/README.md` § Failures and escalation; the state
in `_scratch/plan-day-<date>.md`): `answers=retry` once the person has done what
`needs` names. This skill logs to no ticket: a stop is written to
`_scratch/plan-day-<date>.md` — and, so the inbox and the office list it,
`_scratch/plan-day-<date>.stop.json` (`skills/README.md` § Work directory; removed
when the re-run resumes) — and returned, the office record leaves `stopped`, and
the re-run with `answers=` resumes there.
