# Models and budget

The ceiling, the tiers, ratings, usage bands, estimates and cost.

**Contents** — [Models and budget](#models-and-budget--the-model-follows-the-tasks-complexity) (rating a task · the ceiling · the session is the runtime's, not the pipeline's · the arithmetic · where the rating comes from · escalation, never silent degradation · estimates · cost · budget)

## Models and budget — the model follows the task's complexity

Every agent is spawned with an explicit model and effort chosen from **the complexity
of the task that agent will do**, rated at spawn time from evidence — never from the
skill's name, never from the model the person's session runs on.

**Rating a task** — `low`, `medium` or `high`; the highest column that applies wins:

| Signal | low | medium | high |
|---|---|---|---|
| Scope | one file, one command, one lookup | one area, ≤ ~5 files, an existing pattern to copy | several areas or repos, more files, an unfamiliar subsystem |
| Ambiguity | fully specified | clear goal, edge cases to work out | open questions, derived criteria, contradictions with current behaviour |
| Risk | none | revertable by reverting the PR | data model, access control, public contract, irreversible operation, a shared environment |
| Novelty | done before in this repo, the pattern sits next to it | a pattern exists elsewhere in the repo | nothing to copy |
| Cost of a wrong result | visible at once and cheap to redo | caught by the gates, the tests or the next stage | trusted silently by later stages: a decision, a plan, a merge, evidence |

Mechanical work — run a command and report its output, fetch a thing, format a table —
is `low` by definition. **Uncertain between two levels → the higher one.** Work whose
purpose is to catch what others missed — a plan check, a review, diff validation,
acceptance evidence — takes one effort step above its rating.

| Rating | Tier | Effort | Effort for catching work |
|---|---|---|---|
| `low` | fast — `tiers.json.low` | `low` | `medium` |
| `medium` | standard — `tiers.json.medium` | `medium` | `high` |
| `high` | strongest — `tiers.json.high` | `high` | `max` |

**The ceiling — the largest model the pipeline may use.** `/tp:setup` asks for it once,
from the runtime's current models (each family at its latest version), and records it in
`tiers.json` beside the **ladder** it was chosen from: `ceiling`, and `ladder` — the
runtime's models, smallest first, as its spawn argument names them (Claude Code's
aliases follow each family's latest version). Everything the pipeline spawns runs on the
ladder from its smallest model up to the ceiling, never above it; the three tiers
follow from it:

- `low` is the smallest model on the ladder, `high` is the ceiling, `medium` is the
  first step up from the smallest — never above the ceiling.
- A ceiling that is the smallest model puts it on all three tiers; one that is the
  second puts it on `medium` and `high`. When tiers share a model the rating still
  decides the effort, the review rounds, the retries and the estimate, and an
  escalation (`tier=<next rating>`) raises the effort rather than the model.
- A ladder with more models than tiers leaves the ones between `medium` and the
  ceiling unused; name a tier by hand (`model.mjs tiers <.claude> ceiling=<model>
  medium=<model>`) to use one.

`model.mjs pick` and the unattended runner never return a model above the ceiling — a
tier edited past it runs on the ceiling and `/tp:doctor` says so — and a per-model usage
window (Budget, below) applies to every tier that runs on that model. Change the ceiling
by running `/tp:setup` again; the current one is the preselected answer.

**The session is the runtime's, not the pipeline's.** Agents are spawned on the tiers
above; the session you talk to runs on whatever model you picked, so the pipeline can ask
for one within the ceiling and say when it is not. `/tp:setup` offers to start this
project's sessions on the ceiling (the runtime's `model` setting, written by
`model.mjs pin` — an initial selection, not a cap), and `/tp:doctor` warns when that
setting, or the model of the session that invoked it (`session=`), is above the ceiling.
A hard cap on what a session may select belongs to the runtime: in Claude Code it is
`availableModels` in an administrator's managed settings, which a project cannot set.

No skill, script or test names a model: `<.claude>/tiers.json` holds the ceiling, the
ladder and the three tiers (Install step 2) and tunes the rules — `budget: { economy, stop }`
(percent used; 70 / 90), `thresholds: { medium, high }` (the score `rate` needs; 2 / 4),
`review` (§ Review scope and rounds), `compact` (rule 7), `retries` (§ Failures and
escalation), `estimate` and `day` (Estimates, `/tp:plan-day`; `day.start`, `day.end`,
`day.advanceEvery` — the scheduled day, § Unattended runs), `prices` (Cost below),
`doctor` (§ Using it, Preflight), `gates` and `hooks` (§ Verification rules —
`gates.mjs` and `hooks.mjs` read them), `checks` (the freshness of a blocked check:
`blockedFreshMinutes`, 60 — `/tp:start-ticket`'s `blocked-check.md` § Freshness); each
script's header lists its keys and defaults.

**The arithmetic** is `model.mjs`, always called with `claudeDir`:
- `rate '<signals>'` — the numbers a stage has (`steps`, `flags`, `files`, `lines`,
  `repos`, `criteria`, `round`, `retries`, `unclear`, `mechanical`) → a rating with
  reasons. **The higher of the rubric's rating and `rate`'s wins.**
- `budget '<reading>' <.claude>/tiers.json` — the usage windows → `ample`, `economy`
  (70 %+, or past half a window and on pace to exhaust it), `stop` (90 %+), with the
  binding window and its reset; a per-model window is matched by name to every tier
  that runs on that model.
- `tiers <.claude> ceiling=<model> [ladder=<smallest>,…,<largest>]` — writes the ceiling,
  the ladder and the three tiers they give; the only writer of a model name.
  `ceiling '{ claudeDir, session? }'` — what the pipeline may use, what in the files
  disagrees with it, where the project's starting model and a named session model sit.
  `pin <.claude>` — the ceiling as the project's starting model, unless that is already
  within it.
- `pick '{ rating, catching?, mechanical?, floor?, usage?, claudeDir }'` → `{ action:
  run|economy|stop, rating, model, effort }` — floor, catching step, economy step-down
  and the stops, in one place — and records the reading it was handed in
  `<.claude>/work/_budget.json`, the gauge the office and `/tp:eod` show (a reading
  without windows never overwrites one). Every spawner passes its `model` and `effort`
  verbatim.
- `rounds`, `compact` — the review loop and the compaction rule (their sections).
- `retry '{ rating, kind, attempts }'` → `retry | fallback | escalate` with the wait —
  the auto-resolve bound by rating (§ Failures and escalation).
- `estimate '{ rating, repos, flags, unclear, novelty }'` → the person's focused hours,
  calendar hours, days and points, with the basis (Estimates below).
- `calibrate '{ workroot }' [--apply]` → per rating, the median actual/estimate ratio
  of the tickets whose hours a person recorded and the base hours it proposes
  (Estimates below); nothing is written without `--apply`.
- `day.mjs plan|advance` — `/tp:plan-day`'s arithmetic: the person's days are scheduled
  from the estimates (Estimates below); how many tickets run at once follows the
  budget band (`tiers.json.day.lanes`: `ample` all, `economy` 1, `stop` 0, `unknown`
  all — every unblocked, independent ticket in parallel unless the usage window is
  tight) and a pool day draws `draw` (6) tickets; a dependent ticket starts once its
  prerequisite's code is on the base branch.

**Where the rating comes from** — rated once at pickup, refined by each stage; the
state script reports the current one (`complexity`: the plan's, else triage's, else the
pickup's). Each skill's `inline=true` line names its dedicated agent's rating.

| When | Rating |
|---|---|
| Pickup | `/tp:start-ticket` rates the ticket alone into `ticket.json.complexity`; the pickup steps are bounded (`medium`), their lookups mechanical (`low`) |
| Triage | `/tp:triage`'s agent runs on the pickup's rating and writes `triage.json.complexity` from the same evidence as its decision |
| Plan | the planner runs on triage's rating and confirms or revises it in `plan.json.complexity` (risk flags, step count); the checker one effort step up, and never rewrites the rating |
| Implementation | on the plan's rating (triage's for direct work); the implementer records the rating it experienced in `implement[.repo].json.complexity` — `higher` when it escalated (a record, never fed to `pick`) |
| PR, diff validation, review | the ticket's rating raised by the diff (`rate` on `git diff --stat`, generated code excluded); the review one effort step up; the reviewer gets the rating as `tier=`, never the work directory |
| Release | the change's rating; a follow-up that mutates a shared environment is `high` whatever the ticket was |
| Acceptance | from the criteria: count, live-environment reads, derived criteria; one effort step up |
| Retro, status, orchestration, gates, lookups, notify | bounded analysis is `medium` (`/tp:verify`: the toolchain, the table); running, fetching, formatting and sending are `low` — and are commands or tool calls, not agents (rule 4) |

The dedicated agent takes the rating of the skill's most demanding work; its
sub-agents are rated for their own tasks — a `high` ticket's `/tp:implement` agent runs
on the strongest tier while the `/tp:verify` under it runs `medium`. `tier=` is a floor
the person or an escalation sets, and it floors every agent of the invocation, gate
runners included; a stage's own rating is never passed down as `tier=` — with one
exception: `/tp:review` has no work directory to read a rating from, so `/tp:merge` hands
it the change's rating as `tier=` (the table above).

**Escalation, never silent degradation.** An agent that finds its task harder than
rated — an unexpected design decision, a second area, a risk nobody named — does not
push through: it checkpoints (rule 7) and returns `complexity: higher — <reason>`. The
nearest spawner re-spawns the remaining work with `tier=<next rating> continue=true`
before accepting any result — once per rating step, and a spawner that already
re-spawned its sub-agent reports `as rated` upward, so one signal never escalates
twice. The unattended runner's field for the same signal is `escalate: true`, and it
escalates one step per invocation.

**Estimates — a person's hours, not an agent's minutes.** A ticket's estimate is what
the work would take a person, so that plans, sprints and the tracker's numbers mean
what a team expects — whatever the agents do in parallel. `model.mjs estimate '{
rating, repos, flags, unclear, novelty, claudeDir }'` computes it: the base focused
hours of the rating (`tiers.json.estimate.base`: `low` 2, `medium` 6, `high` 16) ×
the multipliers the ticket's signals add (`+25 %` per repo beyond the first, `+15 %`
per risk flag — data model, access control, public contract, irreversible — `+30 %`
for unclear or derived criteria, `+20 %` when nothing exists to copy) × `1 +
overhead` (`35 %`: the debugging, review rounds, verification and rework every
estimate forgets). The same effort then reads in the person's workday
(`tiers.json.day`: `hours` 8 at `focus` 0.65 = 5.2 focused hours a day, the rest
being meetings, breaks, mail and admin; `switch` 0.5 h lost per extra ticket in a
day; `slack` 0.5 h a day may run over; `attend` 25 % — the share of a running
ticket's estimate the person still spends answering, reviewing and testing while the
pipeline works it): as calendar hours, workdays and tracker points. **The signals**,
read the same way wherever an estimate is made: `repos` — the repos the ticket names
(its title prefix, labels, brief); `flags` — risk named by labels or wording (data
model, access control, public contract, irreversible; a second repo counts through
`repos`); `unclear` — criteria missing or derived; `novelty` — the brief names no
pattern to follow (at pickup, unknown counts as false; triage decides from the code).
**The tracker's own estimate wins** wherever it exists (`source: "tracker"`, never
overwritten): hours are taken as focused hours; points × `estimate.unitHours` (unset
= one focused day, `hours × focus`) — the same `days`, `points` and `basis` fields are
then derived from those hours. `/tp:start-ticket` estimates from the ticket alone and
writes the tracker's estimate field, in the tracker's unit, when it is empty;
`/tp:triage` refines it with what the code showed and updates a pipeline-made estimate;
`/tp:plan-day` schedules with these hours (§ Using it, A day at a time); `/tp:status` shows
them; `/tp:retro` compares the time spent with them. Every number lives in `tiers.json`,
none in a skill. **The base hours learn from actuals:** `/tp:eod` records the person's
hours per finished ticket (`ticket.json.actual`, through `state.mjs actual`);
`model.mjs calibrate` compares them with the pipeline's own estimates — a person's
tracker estimate is never a sample — and proposes new `estimate.base` values from the
median ratio per rating once `estimate.minSamples` (3) exist; `/tp:eod` and `/tp:retro`
print the drift, and only `calibrate --apply`, run by the person, writes it. The
pipeline's minutes per ticket are reported beside it as shape, never as hours.

**Cost — what a ticket spent.** Every token note carries the tier its agent ran on
(§ Definitions, Dedicated agent: `tokens=<n> tier=<rating>`); `tiers.json.prices`
maps each tier to a blended price in currency per million tokens, set once at
Install — without it every token is `unpriced`. `state.mjs usage` and `totals` price
them (`cost`, `unpriced`, `partial` for an unattended run), `/tp:status`, the office and
`/tp:eod` show them. The person's own session is never counted, and the runtime reports
no input/output split, so a cost is an approximation, never an invoice.

**Budget — the limits are never hit, and judgment is never traded for them.** Read the
usage before every spawn when the runtime reports it and hand it to `pick`. `ample` →
the rating alone decides. `economy` → `low` and `medium` work runs in the fewest agents
that keep the contract (commands and lookups already spawn none — rule 4; here also
one validator round, one describer, one operator for the follow-ups a doc line
groups), and `medium` work whose contract is a lookup or a format runs on the fast
tier; `high` work keeps
its tier (`pick` still says `economy`, so the agent count shrinks). `stop` → no new
agent starts: the running agent logs the usage pause (grammar above), and the run
resumes after the reset with no answer. A per-model window at its limit for the tier a
task needs is the same stop — never a downgrade of judgment work. Paid extra usage
stops the same way unless a standing instruction says to spend it.
