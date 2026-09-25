---
name: tp-implement
description: Implement a ticket from its approved plan (or the triage approach for direct work) in a fresh agent: step by step with checkpoints, a commit per step, gates at the end, deviations reported.
user_invocable: true
---

Execute the work for one ticket in a **fresh agent** — never the agent that wrote the
plan. That agent is this skill's own dedicated agent (`skills/README.md`
§ Definitions, Dedicated agent): spawned for exactly this, holding nothing but its
arguments, so it implements itself — no second agent is spawned to do the same job.
Fresh eyes on the plan catch the plan's mistakes, and the invoking context stays
small. Conventions, resume rule, output contract: § Definitions (Resume, Output
contract, Asking the user).

## Input

- `<id>` — the ticket; work directory with `ticket.json` and either `plan.json`
  (`status: ready`, a check that says `ok` or a `revise` with `override`, **and the
  person's go-ahead line in `answers.md`** — the state's `next` is not `implement`
  without it) or
  `triage.json` with `decision: direct` and an approach in `triage.md`. Preconditions
  are the state script's: `next` is this stage (it stays at `plan` while the plan
  lacks its go-ahead line for this round) and no `problems`; an
  earlier `next`, or no work directory, → the earlier stages run first
  (`skills/README.md` § Definitions, Entry points).
- `answers=<text>` — the answer to the last stop's question; the run resumes at
  `stopped.step` (§ Definitions, Resume).
- `step=<n>` — override the step to resume from.
- `force=true` — re-run a done implementation (§ Definitions, Resume).
- `repo=<name>` — cross-repo tickets: which repo this run covers; default the first
  whose `implement:<name>` stage is not done.
- `continue=true` — start from `checkpoint.implement[.<repo>].md`.
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `plan.json.complexity`, or `triage.json.complexity` for direct work
  (`state.mjs state` → `complexity`).

## Steps

### 1. Read the state, log, take the work
`state.mjs state <workdir>` then `state.mjs log <workdir> <stage> started` (stage
`implement`, or `implement:<name>` for a cross-repo ticket). This agent is the
implementer — one repo per invocation, in `ticket.json` order (the one stage that
still takes an agent per repo: here the split is the point, since an implementer holds
one repo's code and nothing of the other's — `skills/README.md` § Context management,
rule 9), never two agents on
one worktree — and what it works from is exactly this, nothing else:
- the absolute work directory; `plan.md` or `triage.md` § Approach; `ticket.md`;
  `answers.md`; the checkpoint when resuming; the state script path and the stage name
  to log with; the step to start from;
- the repo's worktree (its working directory for everything — the one checkout the
  ticket keeps for its whole run, § Worktrees), branch and base, its conventions file
  (its rules bind the code), the commit convention and any attribution trailer the
  session specifies (§ Commits);
- constraints: only that worktree and branch; the verification rules (§ Verification
  rules); no edits to files the plan doesn't name without recording a deviation; no
  ticket or PR operations (`/tp-create-pr`'s and `/tp-merge`'s jobs); its frontier
  (§ Context management, rule 8): the plan's files and the criteria before the change,
  `git diff` after it — the gates it runs at the end go through `/tp-verify base=<base>`
  on the change; its tools: edit and shell in the worktree, the state, model and
  gates scripts, `git`, the skill tool (for `/tp-verify`);
- the protocol below and the output contract.

### 2. Protocol
Between steps ask `model.mjs compact` (rule 7) and on `checkpoint` write
`checkpoint.implement[.<repo>].md` — steps done with their commits, decisions, the next
step, open questions — log the `note`, and return `continue: <path>` (the spawner
re-runs this skill with `continue=true`, § Definitions, Dedicated agent); a `stop`
from `compact` is the stop the rule names.

**Direct work first writes its own `plan.md` and `plan.json`** — its working notes,
one job per § Context management, rule 9 — with the full shape (`status: ready`,
`flags` from `triage.json`, `steps`, `openQuestions: 0`, `complexity`): a short plan
using the template's headings (§ Goal with the ticket's
numbered criteria, § Steps with 2–4 steps each with files and a checkpoint,
§ Verification incl. manual steps, § Risks and rollback and § Out of scope from
triage's flags and scope notes) — so the record and the hand-offs to `/tp-create-pr`,
`/tp-release` and `/tp-accept` are the same as for planned work. Then, for each step:
1. `state.mjs log <workdir> <stage> note "step <n> started"`.
2. Make the change as planned; when the plan is wrong for the code as it is, choose the
   smallest deviation that keeps the step's intent, and record it.
3. Run the step's checkpoint — its output to a file, read by exit code, summary line
   and first failing lines (§ Context management, rule 11; a test run or a build is
   never streamed into this context); a failing checkpoint is fixed before moving on;
   one that cannot run as planned is recorded as a deviation. A checkpoint the repo's
   hooks already run at the commit is not run twice (§ Verification rules): the commit
   in step 4 is that check.
4. Commit when the plan says so (§ Commits) — its output to a file, its exit code read:
   the repo's pre-commit hook runs the project's gates on this commit, so a rejected
   commit is a gate failure to fix here, never bypassed (§ Verification rules).
5. `state.mjs log <workdir> <stage> note "step <n> done - <deviation, if any>" <commit>`.

**Stop** (`state.mjs log <workdir> <stage> stopped "step <n> — <reason and question>"`,
phrased with its choices and default — § Definitions, Asking the user) instead of
pushing on when a deviation changes the approach, a step needs a decision only the
person can make, or the change would touch shared state, access control or a public
contract the plan didn't foresee. A step's checkpoint that still fails after the
retries `model.mjs retry '{ rating, kind: "logic", attempts, claudeDir }'` allows is
not a question but the error stop of `skills/README.md` § Failures and escalation:
the checkpoint written first, `stopped "error: step <n> — …"`, the error form
returned, `answers=retry` afterwards. **Harder than rated** → checkpoint and return
`complexity: higher — <reason>` (§ Models and budget, Escalation).

After the last step, the gates — **reuse, hooks, then run** (§ Verification rules owns
all three; this stage only applies them): a result recorded for this head and base is
the table; else, when the repo's hooks own every gate, the commits above are the gate
run and the table is their `HOOK` rows; else `/tp-verify path=<worktree> base=<base
branch>` (its dedicated agent under the office id `<id>:<stage>:qa:verify`, this agent
as `parent`; `inline=true` when this agent cannot spawn — § Definitions, Depth), which
records its result for the commit `/tp-create-pr` will find. Failures are fixed in the
implementation, never by weakening a gate or a hook.

Finally append to `plan.md`:
```
## Implementation summary
steps: <done>/<total>   commits: <shas>
deviations: none | <one line each>
gates: <one line per gate: name PASS/FAIL (+ first lines on FAIL)>
manual steps: <numbered, for user-facing changes; else "none">
```
and write `implement.json` (`implement.<name>.json` for a cross-repo ticket):
`{ repo, done, total, commits, gates, deviations, stopped, complexity }` — `complexity`
the rating it experienced, `higher` when it escalated. Then, while the change is
still in this context, **draft the PR description**: `pr-body.md` (`pr-body.<name>.md`
on a cross-repo ticket) in the work directory, in the format of `/tp-create-pr`'s
`skills/tp-create-pr/instructions/description-format.md` (its `examples/` show the bar) — the problem
from `ticket.md`, the solution as this agent made it, the manual steps from `plan.md`
§ Verification — so `/tp-create-pr` checks and posts it instead of spawning an agent to
read the whole diff again (`skills/README.md` § Context management, rule 9). Never
posted from here: the PR is `/tp-create-pr`'s.

### 3. Output contract
The Implementation summary block verbatim, `pr-body drafted` (or why not), `stopped at
step n — <question>` when it stopped, and the two contract lines (§ Definitions,
Output contract).

### 4. Record and report
`state.mjs log <workdir> <stage> done "<done/total> steps - gates <summary>" <commits>`
(a stop was already logged at the step). Report the summary.

## Stops
`step <n> — <question>` (a deviation that changes the approach, a decision only the
person can make, a checkpoint failing after its retry bound, unforeseen shared state /
access control / public contract): `answers=<decision>`. `hand-off budget spent —
<next step>`: `answers=continue`. `error: …` (§ Failures and escalation):
`answers=retry` once the person has done what it names.
