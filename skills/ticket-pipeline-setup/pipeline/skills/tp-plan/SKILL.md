---
name: tp-plan
description: Write a self-contained implementation plan for a ticket, have a fresh checker verify it in a bounded loop, and present the checked plan (open risks named) for the person's approval before anything is implemented.
user_invocable: true
---

Write `plan.md` for one ticket, prove it holds, and put it in front of the person.
A fresh agent plans — this skill's dedicated agent, which knows nothing but its
arguments (`skills/README.md` § Definitions, Dedicated agent) and keeps what it read
of the code through the loop's revise rounds, so none of them re-reads the repo; a second
fresh agent checks it the way code gets reviewed — the planner grades nothing of its
own — in a bounded, incremental loop; then the finished plan, with any risk the loop
could not remove named, is presented for the person's approval or changes. **Nothing is implemented without that approval**: a third agent
(`/tp-implement`) executes with nothing but the approved plan and the repo, so the plan
must stand on its own. Conventions, resume rule, output contract: `skills/README.md`
§ Definitions (Resume, Output contract, Asking the user).

## Input

- `<id>` — the ticket; work directory with `ticket.md` and `triage.md` (its evidence
  and scope notes are the planner's starting point). Not there yet → the earlier
  stages run first (`skills/README.md` § Definitions, Entry points).
- `answers=<text>` (optional) — the answer to what the plan is waiting on, recorded
  as a `note` first (§ Definitions, Resume) and routed by step 1.
- `findings=plan-check.json` (optional) — re-plan with the blocking findings (the
  re-plan first copies `plan.md` to `plan.prev.md`, the incremental check's baseline).
- `check-only=true` (optional) — run only the checker, on a plan edited by hand.
- `force=true` — re-plan a done plan (§ Definitions, Resume).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `triage.json.complexity`.

## Steps

### 1. Read the state, then plan

`state.mjs state <workdir>` first (§ Definitions, Resume): with `answers=`, route by
`stopped.question` — the approval wait and `answers=go-ahead` → step 3's approval
only; the approval wait and any other answer (a change request), or open questions
answered → re-plan below with the answer. Without `answers=`: a plan whose check
still says `revise` and whose `plan-check.json.round` is under the retry bound (a
planning agent died mid-loop) → back into step 2's loop before presenting again; any
other derived wait (open questions, the approval) → step 3 again, nothing re-run
(§ Definitions, Resume).
`check-only=true` → step 2 (a full check when `plan.prev.md` is missing or older
than the last `plan-check done`), then step 3. Otherwise `state.mjs log <workdir> plan started` and
**plan — this agent is the planner**: restricted to reading the worktree (searches,
read-only commands and type checks) and writing only `plan.md` and `plan.json`, from
the absolute work directory; `ticket.md`, `triage.md`, `answers.md`, the `findings`
file when given; each repo's worktree, branch, base and conventions file from
`ticket.json` (the conventions bind the plan); the template
(`instructions/plan-template.md`); the verification rules (`skills/README.md`
§ Verification rules — the plan may only plan checks the implementer is allowed to
run); the frontier (rule 8: the acceptance criteria and the code they name — search
by the ticket's nouns, the hits and one level of callers and callees; the plan lists
every file it will touch). It writes `plan.md` and `plan.json` (`{ status, flags,
steps, openQuestions, complexity }`, the planner's own rating confirming or revising
triage's with what the code showed). Independent investigations (each affected area,
the pattern to follow, the test setup) may be parallel read-only lookups inside this
agent, sequential at the depth that cannot spawn. A re-plan in step 2's loop (or with
`findings=`, a change request) is this same agent revising `plan.md` in place — the
blocking findings and nothing else, with the code it already read — after copying
the plan to `plan.prev.md`. Then: `state.mjs log <workdir> plan done "<n> steps -
risks: <flags>" plan.md` — before the check, so the check's entry comes after.

### 2. Check the plan

`state.mjs log <workdir> plan-check started`. Spawn the checker — the one agent this
skill spawns, because the check must be independent of the planner (§ Context
management, rule 2): a fresh writing agent, restricted to reading the worktree and
writing only `plan-check.json`,
rated `plan.json.complexity` with
the catching step, office id `<id>:plan-check:qa` with this agent as `parent` (the
join/leave commands in its prompt), prompt: the absolute work directory; `plan.md`, `ticket.md`; each
repo's worktree and conventions file; the criteria (`instructions/check-criteria.md`,
absolute path); the frontier (rule 8: the files the plan names and the acceptance
criteria, nothing wider); the tools it has (read and search; write only its one
file); the task — check every criterion and write `plan-check.json`
(`{ verdict, round, override: null, findings }`, `round` = this check's number for the
ticket's round; the plan's `complexity` is the planner's and is never rewritten); the
output contract. Then `state.mjs log <workdir> plan-check done "<verdict> - <n>
blocking, <m> advisory" plan-check.json`.

**Every check after the first is incremental** (`instructions/check-criteria.md` § An
incremental pass): the checker also gets the previous `plan-check.json` and the
previous plan, `plan.prev.md` — which every re-plan writes before it overwrites
`plan.md`. The loop:

- **ok**, or only advisory findings ("no significant issue remains") → step 3.
- **revise** → ask `node <.claude>/skills/_lib/model.mjs retry '{ rating:
  <plan.json.complexity>, kind: "logic", attempts: <revises so far>, claudeDir }'`
  (§ Failures and escalation — the bound by rating, `tiers.json.retries`): `retry` →
  step 1's re-plan with the findings (this agent addresses the blocking findings and
  nothing else, which logs `plan` again), then a fresh checker's incremental check;
  `escalate` → the loop ends with the findings still open: step 3 presents them as
  the plan's **open risks**, clearly marked, for the person to accept or send back.

### 3. Present the plan for approval

The person approves every plan — the highest priority of this stage; the script
derives both waits as `stopped` on `plan` (nothing is logged here):

- **Open questions** in `plan.md` → return them as the report. Never implement
  around one.
- **Otherwise** → the report is the plan for approval: goal, approach, one line per
  step with its files, the risk flags (data-model, access-control, public-contract,
  cross-repo, irreversible), the check's verdict and advisory findings, the estimate,
  and — when the loop ended with findings open — an **Open risks** list, each finding
  verbatim with the step it concerns, which also goes into `plan.md` as its last
  section: the stop names that file as its `doc` and whoever approves reads it there,
  possibly in another session, so the file has to hold everything being accepted
  (`skills/README.md` § Definitions, Asking the user — the invoking context shows it
  before it asks). Then the question exactly as the state script
  phrases it (`state.mjs state` → `stopped.question`: `approval needed: <n> steps,
  risks: <flags> — … approve (go-ahead) or send a change`), so the person sees one
  wording on every pass. Before returning, comment on the ticket that a plan is
  ready for approval (the plan file is local — describe, don't link). Approval arrives as
  `answers=go-ahead`: record the `answers.md` line `go-ahead: <timestamp> — round
  <n> — <risk flags>` at the start of a line (`n` = `ticket.json.round`, so an
  earlier round's go-ahead never covers a new plan), set `plan-check.json.override`
  when the check still said `revise` (the person accepted the open risks), and log
  `plan note "approved"`; `/tp-implement` refuses any plan without that line. A change
  → it goes in `answers.md`, this agent re-plans with it (step 1's re-plan), the
  check runs incrementally (step 2), and the plan is presented again — the person's
  changes never count against the check's bound.

A plan the person edits is re-read from disk — the file is the plan; `/tp-plan <id>
check-only=true` re-checks it — in full, a hand edit leaving no `plan.prev.md`
baseline (step 1) — and presents it again.

### 4. Report

Step 3's presentation is the report; after an approval, one line: `approved — round
<n>, <n> steps, risks: <flags>`, and the next stage (`/tp-implement <id>`).

## Stops

**The approval is always a stop, and no agent may answer it.** Not the planner, not the
orchestrator, not a stage lead — however obvious the plan looks, however small the
change, and *even when the person's own instruction for the run already dictates exactly
what the plan says*. "The plan adds nothing beyond what I was told" is precisely the
judgement this stop exists to keep out of an agent's hands: the person asked for the
plan, not only the outcome, and a plan that merely restates an instruction is the
cheapest one for them to approve. Return the stop and let the session interview. Writing
a go-ahead into `answers.md` on the person's behalf — even with its provenance honestly
logged — is a breach of this rule, not a shortcut through it. (Standing instruction,
2026-09-25, after a run self-approved a one-line seed change.)

Derived by the script (logged `done`): open questions (`answers=1: … | 2: …`); the
approval — every plan, with any finding the check still holds open named
(`answers=go-ahead`, or `answers=<the change>`).
Logged: `hand-off budget spent — <next step>` (`answers=continue`); a checker that
returned nothing twice, or a failure past its fallback — `error: …`
(`skills/README.md` § Failures and escalation): `answers=retry` once the person has
done what `needs` names.
