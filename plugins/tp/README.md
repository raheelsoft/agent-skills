# tp — the ticket pipeline

Takes a tracker ticket from pickup through triage, plan, implementation, pull request, unbiased review, merge, release
and acceptance. Every stage runs in its own agent, every fact is on disk so any run resumes, and several tickets run in
parallel. The project's specifics — tracker, branch names, gates, who reviews, what a merge triggers — are read from the
project, never written into the skills.

## Use it

```
/plugin marketplace add raheelsoft/agent-skills
/plugin install tp@raheelsoft
```

Then, in the project: `/tp:setup` (the interview: which skills the project uses, the largest model the pipeline may
use, the gates in its git hooks) and `/tp:run-ticket <id>`. `/tp:doctor` says what is missing before a run does.
The project keeps only its configuration and the work directory in `.claude/`; the skills, scripts, hooks and schemas
belong to the plugin.

## Where to read more

[`reference/README.md`](reference/README.md) is the overview and the index of the rules; [`reference/flowcharts.md`](reference/flowcharts.md)
draws every path a ticket can take.

## What is in this folder

| Folder | What it holds |
|---|---|
| `skills/` | The twenty-one skills, one folder each (`/tp:<name>`), with their `instructions/` and `examples/` |
| `agents/` | The role agents a skill spawns by type: plan checker, diff validator, reviewer, researcher, implementer |
| `hooks/` | The deterministic gates — what is refused, what is clamped, what a stopping agent still owes |
| `lib/` | The scripts the skills call: state, contracts, gates, models, the day planner, doctor |
| `schemas/` | JSON Schemas for every file a stage hands the next one, with valid examples |
| `reference/` | The rules, by topic |
| `workflows/` | The unattended runner |
| `office/` | A local page over the work directory: who is working on what, and what waits for a person — a stop can be answered there |
| `evals/` | Cases that run the plugin for real; they cost tokens, so they run on demand |
| `tests/` | The free checks: `node --test tests/*.test.mjs` |

## Develop it

`node --test tests/*.test.mjs` from this folder, and `claude plugin validate --strict plugins/tp` from the repository root,
run on every pull request. The evals (`evals/README.md`) are run by hand before a release.
