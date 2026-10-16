---
name: retro
description: Compares the plan with what happened after acceptance — deviations, review findings the check missed, questions asked, time — and proposes edits to the conventions file, ticket template or instructions; proposals only. Use after a ticket is accepted.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`) · `<skill>` = `${CLAUDE_SKILL_DIR}` (this skill's folder, where the `instructions/` and `examples/` files named below are). The JSON files this skill writes (`<artifact>.json` below) go through `node <lib>/state.mjs put <workdir> <artifact> …` — checked against `schemas/` first; `examples/retro-json.md` shows good ones and bad ones with the refusal they get — never through the file tools or a shell redirect: a hook refuses a raw write. Its `.md` documents are written the same way: `node <lib>/state.mjs doc <workdir> <name>`, the text on stdin or `--from <file>` (`--append` adds to the end); a long one is drafted under `<.claude>/worktrees/_out/<id>/`, the one place below `.claude/` an agent may write. Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

The improvement loop, optional and after the fact: the work directory holds the plan,
the check, the implementation summary, the review, every stop and answer, and the
timings — enough to see where the process, not just the code, was wrong. A fresh agent
— this skill's dedicated agent, `reference/definitions.md` § Definitions, Dedicated agent — reads it and
proposes changes; the user decides which land. Conventions and the state script:
`reference/definitions.md` § Definitions (Resume, Output contract, The scripts).

## Input

- `<id>` — a ticket whose `accept` stage is `done` or `stopped`, or which the user
  declares abandoned. Runs from `/tp:run-ticket … retro=true`, or by hand. No work
  directory → nothing to compare; the report says so (`reference/definitions.md`
  § Definitions, Entry points).
- `answers=<text>` — the answer to this skill's last stop (§ Stops). `continue=true`
  — resume from `checkpoint.retro.md`. `force=true` — re-run a done retro
  (§ Definitions, Resume).
- `inline=true` — `reference/definitions.md` § Definitions (Dedicated agent); this agent's
  rating: `medium` (bounded analysis of a finished record).

## Steps

### 1. Read the state, log, read the record
`state.mjs log <workdir> retro started` (`reference/definitions.md` § Definitions, Resume), then
`node <lib>/state.mjs retro-facts <workdir> --claude <.claude>` — the script gathers what a retrospective counts and
quotes: the `· stopped ·` lines, every question answers.md holds with its answer, the plan's implementation summary
(steps, commits, deviations), the criteria that ended `manual`, the plan check's findings, the review rounds and what
they left open, minutes and tokens per stage, the estimate against the actual hours, and the counts. This agent reads
that, not the files behind it (tools: read, the hosting platform's CLI reads for the PR's review comments, the state
script; write only `retro.md` and `checkpoint.retro.md` (through `state.mjs doc`), and `retro.json` through `state.mjs
put`, which computes `questions` and `manualCriteria` from the record itself). It also reads each repo's conventions file
and `model.mjs calibrate '{ workroot, claudeDir }'` (the estimates' drift so far), asks `model.mjs compact` between the
questions below (rule 7), and answers them. It writes both files and reports the proposal count by target, plus the two
contract lines (§ Definitions, Output contract).

### 2. What it answers
- **Plan vs reality** — every deviation in `plan.md` § Implementation summary and every
  stop in `progress.md` (its `· stopped ·` lines): was it foreseeable from the code (a planning miss), from the
  ticket (a ticket-writing miss), or genuinely new?
- **Check vs review** — findings in the PR review the plan check could have caught from
  the plan alone; gate failures after implementation that a checkpoint should have
  caught.
- **Questions asked** — every entry in `answers.md`: was the answer project-wide (belongs
  in the conventions file), ticket-shaped (belongs in the ticket template or
  `/tp:create-ticket`'s discovery), or a one-off?
- **Time** — minutes per stage vs the ticket's estimate (`ticket.json.estimate`, a
  person's hours — the agents' minutes are a different scale, so compare shape, not
  magnitude); when the person recorded actual hours (`ticket.json.actual`, `/tp:eod`),
  this ticket's actual/estimate ratio against the rating's median so far
  (`calibrate`) — one ticket never changes the base, the drift line says how far the
  rating is from a proposal; a stage far outside the norm and
  why (waiting on a deploy, a revise loop, a resume).
- **Acceptance** — criteria that ended `manual`: could a documented test account,
  fixture or endpoint have made them provable?

### 3. Proposals
Each proposal is one concrete change with its target and the evidence line(s) it comes
from:
- **conventions file** → the exact text to add (a rule, a path, a pipeline name, an
  environment URL) — lands as a small PR through the normal flow;
- **ticket template / `/tp:create-ticket` discovery** → the field or question to add;
- **standing instructions** → a rule the user keeps outside the repo;
- **skill** → flagged for the user only; the skills are shared and never edited from a
  ticket.

Never applied by this stage. `retro.json`:
```
{ deviations: n, reviewFindingsMissedByCheck: n, questions: n, manualCriteria: n,
  proposals: [{ target: "conventions"|"ticket-template"|"standing"|"skill", text, evidence }] }
```

### 4. Record and report
`state.mjs log <workdir> retro done "<n> proposals"`. The report is the proposals
grouped by target, one line each. Applying any is the user's own action afterwards;
`conventions` proposals they accept become a ticket round or a direct small PR, as they
prefer.

## Stops
`hand-off budget spent — <next question>` (`answers=continue`); `error: …` — the
hosting platform unreachable past its fallback (`reference/failures-and-stops.md` § Failures and
escalation): `answers=retry` once the person has done what `needs` names. No work directory → not a stop: the report says there is
nothing to compare.
