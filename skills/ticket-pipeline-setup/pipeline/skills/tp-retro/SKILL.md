---
name: tp-retro
description: After acceptance, compare the plan with what happened — deviations, review findings the check missed, questions asked, time — and propose edits to the conventions file, ticket template or instructions. Proposals only.
user_invocable: true
---

The improvement loop, optional and after the fact: the work directory holds the plan,
the check, the implementation summary, the review, every stop and answer, and the
timings — enough to see where the process, not just the code, was wrong. A fresh agent
— this skill's dedicated agent, `skills/README.md` § Definitions, Dedicated agent — reads it and
proposes changes; the user decides which land. Conventions and the state script:
`skills/README.md` § Definitions (Resume, Output contract, The scripts).

## Input

- `<id>` — a ticket whose `accept` stage is `done` or `stopped`, or which the user
  declares abandoned. Runs from `/tp-run-ticket … retro=true`, or by hand. No work
  directory → nothing to compare; the report says so (`skills/README.md`
  § Definitions, Entry points).
- `answers=<text>` — the answer to this skill's last stop (§ Stops). `continue=true`
  — resume from `checkpoint.retro.md`. `force=true` — re-run a done retro
  (§ Definitions, Resume).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `medium` (bounded analysis of a finished record).

## Steps

### 1. Read the state, log, read the record
`state.mjs state <workdir>` then `state.mjs log <workdir> retro started`
(`skills/README.md` § Definitions, Resume). This agent reads the record itself — no
second agent for the same reading (tools: read, the hosting platform's CLI reads, the
state script; write only `retro.md`, `retro.json` and `checkpoint.retro.md`; it asks
`model.mjs compact` between the questions below, rule 7): from the work directory,
the files the questions name — `plan.md` (§ Implementation summary), `plan-check.json`,
`implement[.repo].json`, `answers.md`, `accept.json`, `ticket.json` (estimate,
actual) and the `· stopped ·` lines of `progress.md` (a `grep`, not the file whole;
never the checkpoints, PR bodies or `diff-validation.md`); the PR's review comment(s) and round
comments (URL from `pr[.repo].json`; read through the hosting platform's CLI/API);
each repo's conventions file; the output of `state.mjs durations <workdir>`,
`state.mjs usage <workdir>` and `model.mjs calibrate '{ workroot, claudeDir }'` (the
estimates' drift so far) — and answers the questions below. It writes both files and reports the
proposal count by target, plus the two contract lines (§ Definitions, Output
contract).

### 2. What it answers
- **Plan vs reality** — every deviation in `plan.md` § Implementation summary and every
  stop in `progress.md` (its `· stopped ·` lines): was it foreseeable from the code (a planning miss), from the
  ticket (a ticket-writing miss), or genuinely new?
- **Check vs review** — findings in the PR review the plan check could have caught from
  the plan alone; gate failures after implementation that a checkpoint should have
  caught.
- **Questions asked** — every entry in `answers.md`: was the answer project-wide (belongs
  in the conventions file), ticket-shaped (belongs in the ticket template or
  `/tp-create-ticket`'s discovery), or a one-off?
- **Time** — minutes per stage vs the ticket's estimate (`ticket.json.estimate`, a
  person's hours — the agents' minutes are a different scale, so compare shape, not
  magnitude); when the person recorded actual hours (`ticket.json.actual`, `/tp-eod`),
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
- **ticket template / `/tp-create-ticket` discovery** → the field or question to add;
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
hosting platform unreachable past its fallback (`skills/README.md` § Failures and
escalation): `answers=retry` once the person has done what `needs` names. No work directory → not a stop: the report says there is
nothing to compare.
