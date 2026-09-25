---
name: tp-run-ticket
description: Run tickets end to end in one orchestrator agent per ticket — pick up, triage, plan, implement, PR, review and merge, release, accept (retro optional) — each stage in its own agent, with a run lock, one notification per stop and resumable state on disk.
user_invocable: true
---

Orchestrate `/tp-start-ticket → /tp-triage → (/tp-plan →) /tp-implement → /tp-create-pr → /tp-merge →
/tp-release → /tp-accept (→ /tp-retro)` for a ticket. The orchestrator holds only each stage's short
report; everything else is in the work directory. `skills/README.md` defines the files,
the dedicated-agent rule, the resume rule, the state script and what is logged where.

Invoking this skill carries each stage skill's own authorization statement, exactly as
if that skill were invoked alone. Its stops are the stage skills' stops (each skill's
`## Stops`, or the waits the script derives for triage and plan) plus its own: a lock
held by another run, a problem from the state script, a usage pause.

## Input

- `<id>` (ticket id or URL, normalised to the tracker's identifier form), several ids
  (`A B C`), or `next` (self-selection per `/tp-start-ticket`) — `next count=<n>` picks up
  to n tickets that are unblocked and independent of each other and runs them in
  parallel (`/tp-plan-day` is the fuller form: blockers, dependencies, the day's plan).
- `round=<n>` → a new round after a failed acceptance (passed to `/tp-start-ticket`).
- `checked=<iso>` → forwarded to `/tp-start-ticket`: the caller's blocker verdict, so the
  pickup does not fetch the same states again (`blocked-check.md` § Freshness).
- `mode=direct|plan` → `/tp-triage`. `promote=<branch>` → `/tp-release`, never inferred.
  `where=live|checkout`, `env=<name>` → `/tp-accept`. `retro=true` → `/tp-retro` at the end.
- `merge=auto|ask` → `/tp-merge` (precedence: `skills/README.md` § Review scope and
  rounds, Merging).
- `until=start-ticket|triage|plan|implement|create-pr|merge|release|accept` → stop
  after that stage (no close-out, no `done` message); `until=create-pr` opens the PR
  and leaves it unreviewed. A stage skill used as an entry point runs this with its
  own stage as `until=` (`skills/README.md` § Definitions, Entry points).
- Any stage skill's own argument — `repo=`, `update=true`, `check-only=true`,
  `findings=`, `step=`, `force=true` — is forwarded to that stage, so an entry point
  keeps its options; the arguments above are forwarded to the stages named.
- `owner=<string>` → the run-lock owner (`skills/README.md` § Concurrency); the
  invoking session passes its own name or id and every orchestrator it spawns uses it.
- `tier=<low|medium|high>` → the minimum rating for every agent of this run,
  forwarded to every stage (`strong` = `high`).
- `answers=<text>` → the answer to the stopped stage's question, routed by the state
  (§ Definitions, Resume).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent): passed by the
  orchestrator spawn below and by a stage skill's entry-point invocation
  (§ Definitions, Entry points); this agent's rating: `medium` (orchestration and
  relaying reports).

## Where it runs

Without `inline=true` this invocation does three things and nothing else: the
**preflight** (§ Using it, Preflight owns the rule and the exit codes); `/tp-notify
setup` when `<.claude>/notify.json` does not exist (`skills/README.md`
§ Observability); then it spawns one **orchestrator agent per ticket** — **all in one
message**, in the background, the session being the one context the runtime wakes
for that (§ Definitions, Runtime notes) — for one id or for `A B C` alike, each told
to run this skill for its single id with the same options, `owner=<this session's
name or id>` and `inline=true`, and to return the final report or the stop. Tickets
never wait for each other: one orchestrator per id, spawned together, never one after
another. `next count=<n>` first asks `/tp-start-ticket next count=<n> pick=true` (its
dedicated agent; the picks only, nothing taken) for the ids, then spawns the same
way; a shortlist it cannot settle is the interview. It relays each
report as it arrives; a stop becomes the interview and the re-invocation `/tp-run-ticket
<id> answers=…` (§ Definitions, Asking the user — a fresh orchestrator; the state on
disk resumes it). Tickets never share a worktree or a work directory, so they run
side by side, each in its one worktree per repo from pickup to the close-out
(§ Worktrees). Where nobody can be interviewed — a scheduled run (`skills/README.md`
§ Unattended runs, Scheduled runs) — the session spawns the orchestrators in one
message and awaits them in the foreground, prints every stop as its row (the state
already carries the resume command) and re-invokes nothing that needs a person; the
stops wait in the office inbox and `/tp-inbox`.

Inside the orchestrator the stage skills are invoked normally — without `inline=true`
— so each stage runs in its own dedicated agent, rated per its own `inline=true` line
from the ticket's current `complexity`, with the office id `<id>:<stage>:lead` and
`parent` = the manager's id (§ Definitions, Office presence); the orchestrator acts
on each stage's report as § Definitions, Dedicated agent says (re-spawn on a
checkpoint or `complexity: higher`, once on nothing returned, relay a stop or an error
form unchanged), forwards `tier=` to every stage, and logs the stage lead's tokens
when the runtime reports them (`state.mjs log <workdir> <stage> note "lead
tokens=<n> tier=<rating>"` — the rating the lead ran at, § Definitions, Dedicated
agent). It holds only reports, so it rarely checkpoints itself; when `compact`
says so, `checkpoint.run-ticket.md` records the stage lines so far. It prints nothing:
it collects one line per stage and returns them with the final report or the stop.

## Steps (one ticket, inside its orchestrator agent)

### 0. Register, resume check and lock
`state.mjs agent join <.claude>/work '{ "id": "<id>:run-ticket:manager", "level":
"manager", "role": "orchestrator", "stage": "run-ticket", "ticket": "<id>", "rating":
"medium" }'` — the manager's desk, first of
all (the ticket id is known before the work directory exists). No work directory for
the normalised id → a first run: step 1, passing `answers=`
through (a stop before the directory exists — a soft-block, a cancelled ticket, a
`next` shortlist — is answered there). Otherwise read `state.mjs state <workdir>
--brief` — the decision fields, a tenth of the full state; the stages read the full
form themselves — first and decide: `round=` above `ticket.json.round` → step 1 regardless of the state
(the earlier stages re-run as stale); the ticket `closed`, or `next: null` (done),
without such a `round=` or `force=true` → refuse — `already done|closed; round=<n+1>
or force=true to re-run` — with no lock and nothing logged; `problems` → an error
stop (§ Work directory, the grammar): the report, `needs:` the fix; `stopped` without
`answers=` → `state.mjs answer <.claude>/work <id> --consume` first: exit 0 → the
queued answer is this run's `answers=` (§ Definitions, Resume — its `answers.md` line
says `from the office`); exit 3 → the stop is the report, with one line that a stale
answer was set aside; otherwise the stop is the report — except a usage pause
(`stopped "usage at …"`) whose reset time has passed, and a blocked ticket (`kind:
blocked`) the state reports `unblocked`, which both run as if answered — a parked
ticket whose repo rows say `discarded` first re-runs `/tp-start-ticket <id> force=true`
(its worktrees went at parking, so this is the one case that creates them again —
from the base that now holds the blockers' work; the stages after it re-run as
stale). Only when a stage will run:
`state.mjs lock <workdir> <owner>` (a live lock held by another owner → that is the
stop, without unlocking), `state.mjs log <workdir> run-ticket started`, then run
`next` — with `answers=` when given (`repo=` is `next`'s suffix for `/tp-implement`,
the one stage with an agent per repo; the others cover every repo left in their own
agent, so pass no `repo=` and expect `next` to come back past all of them —
`skills/README.md` § Context management, rule 9; `next: plan-check` → `/tp-plan <id>
check-only=true`); note which stages the state skipped.

### 1. `/tp-start-ticket <id> [round=…] [answers=…]`
Line `1/8 start-ticket · <branch> in <repo>` (one per repo). On a first run, take the
lock and log `run-ticket started` right after this stage returns — it created the
work directory.

### 2. `/tp-triage <id> [mode=…] [answers=…]`
Line `2/8 triage · <decision> (<confidence>)`. `close` → the line carries the `why`
and the run goes straight to step 9 as a closed ticket. `blocked` → the line carries
the blockers and the run goes to step 9 as a parked ticket.

### 3. `/tp-plan <id> [answers=…]` — only when triage says plan
Line `3/8 plan · <n> steps · risks: <flags> · check <ok|revise>`. Every plan ends in
the approval stop — the person reads the checked plan itself (the stop's `doc`, open
risks named: `skills/README.md` § Definitions, Asking the user) and answers
`go-ahead` or sends changes — before step 4 runs.

### 4. `/tp-implement <id> [repo=<name>] [answers=…]` — once per repo, in `ticket.json` order
Line `4/8 implement · <repo> · <done>/<total> steps · gates <result>`.

### 5. `/tp-create-pr <id> [repo=<name>] [answers=…]` — once, every repo inside it
Line `5/8 create-pr · <PR url> · gates <result>`.

### 6. `/tp-merge <id> [repo=<name>] [merge=…] [answers=…]` — once, every repo inside it
Line `6/8 merge · <repo> · review <verdict> ×<passes> · <merged sha | stopped: …>`.
Dependent PRs merge in `ticket.json` order.

### 7. `/tp-release <id> [repo=<name>] [promote=<branch>] [answers=…]` — once, every repo inside it
Line `7/8 release · <repo> · run <status> · <n> follow-ups · smoke <result>`.

### 8. `/tp-accept <id> [where=…] [env=…] [answers=…]`
Line `8/8 accept · <passed> pass · <failed> fail · <manual> manual`. A stage whose
skill is off (§ Definitions, Active skills) is not in the state's `next` and gets no
line: the run goes on to the next active stage, or to the close-out. A failed
criterion is a stop; `answers=round` → the session starts `/tp-run-ticket <id>
round=<n+1>`.

### 9. Close out
The run's one cleanup moment (§ Worktrees): a **finished** ticket's worktrees went
with `/tp-accept`'s `done`; any still under `wt/` (a stage run before that rule, a
`done` that stopped short) go now (`/tp-start-ticket`'s `branch-and-pull.md` § 4).
A **closed** ticket (the state's `closed`, from triage's `close`): remove its
worktrees and delete the never-pushed branches (§ 4; a stacked ticket's shared
worktree stays), comment on the ticket with the `why` and what to close it as — the
status stays the person's (§ Tickets) — then the lines below with `run-ticket done
"closed: <why>"` and `level=done`; no retro.
A **parked** ticket (the state's stop `kind: blocked`, from triage's `blocked`): the
same worktree and branch removal, each repo row marked `discarded: "parked — <why>"`
in `ticket.json`, `state.mjs log <workdir> run-ticket note "parked: <what was
removed> — blocked by <ids>"`, then the order of § Stops with the stop as the report
(`level=stop`; no `run-ticket done`, so the ticket stays open): it resumes through
`/tp-inbox` or `/tp-plan-day` once the blockers are resolved (step 0).
`/tp-retro <id>` when `retro=true` (off for this project → one line saying so, nothing
run — § Definitions, Active skills). Append to `report.md`: deviations from the plan and
the implementation summary from `plan.md`, the stage durations and token totals
(`state.mjs durations`, `state.mjs usage`), and every stop with how it was resolved.
A stage's report ending in a checkpoint or `complexity: higher` was already handled
when it arrived (§ Where it runs).
`state.mjs log <workdir> run-ticket done "<one line>"`, `state.mjs unlock <workdir>
<owner>`, `/tp-notify "<id> · done · <outcome> <PR>" level=done` (sent by this agent
itself — `/tp-notify` spawns none, § Definitions, Dedicated agent), `state.mjs agent leave
<.claude>/work <id>:run-ticket:manager done`. Return the stage lines and the report. The ticket's status and the work directory stay as they are — the
person's call; `accept.md` is the evidence for closing it.

## Stops

A stage's stop ends the orchestrator exactly as `skills/README.md` § Stops and
notifications says (unlock → `/tp-notify … level=stop` → `state.mjs agent leave
<.claude>/work <id>:run-ticket:manager stopped` → return the stage lines so far and
the stop text **verbatim**, prefixed `run-ticket › <stage> ›` — the choices and the
default are the stage's own, never added here; the session interviews from it). A
stage's error form ends it the same way with `level=error`, the chain as the report
(§ Failures and escalation), after `state.mjs agent leave <.claude>/work
<id>:<stage>:lead gone` for a stage agent that died. Between stages: read each stage's
report only, never its raw output; a usage pause is `run-ticket stopped "usage at <n>%
of <window> — resume after <reset>"` and the same order. `until=` ends after the named
stage with the stage lines so far, the named stage's report and the work-directory
path, releasing the lock, with no message and no `run-ticket done`.
