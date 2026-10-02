# ticket-pipeline-setup

Installs a ticket pipeline into a project: twenty-one Claude Code skills and an
unattended workflow runner that take a tracker ticket from pickup to accepted work.

```bash
npx @raheelsoft/agent-skills install ticket-pipeline-setup
```

Then, in a session at the project: **"set up the ticket pipeline here"**. The skill
copies the pipeline into `<project>/.claude/` and runs its integration interview.

## The problem it solves

Working a ticket end to end in one conversation fails in predictable ways.

- **Context rot.** The chat fills with diffs, install logs and gate output until
  judgment degrades, and the record of what was decided lives only in that chat.
- **One mind checking itself.** The same context plans, implements and reviews, so a
  plausible-but-wrong change sails through.
- **"Done" as a claim.** Nobody proves the acceptance criteria against the environment
  the change actually reached.
- **Nothing to resume from.** A question, a failed gate or a closed laptop loses the
  work; a second ticket collides on the same checkout.
- **Process baked into prompts.** Branch names, tracker fields and deploy pipelines end
  up in the instructions, so the process cannot move to the next project.
- **Cost nobody sees.** Agents re-read the same rules, re-run the same gates and
  re-create the same checkouts.

Here every stage runs in a fresh agent holding only its arguments and the few rules it
needs; the checker never inherits the planner's reasoning and the reviewer never the
author's; a gate, a test or a criterion walked against the released environment is what
"delivered" means; every stop is a logged question with its resume command; the
project's specifics come from its own conventions file; and gates run once per commit
against a cached baseline, skipping whatever the repo's git hooks already enforce.

## What you get

| Command | What it does |
|---|---|
| `/tp-run-ticket <ids…>` | one ticket (or several) end to end — pickup, triage, plan, implement, PR, review, merge, release, acceptance — one orchestrator agent per ticket, resumable at every stage |
| `/tp-plan-day` | picks the day's tickets from the sprint or a seeded pool draw, checks blockers and dependencies, **proposes the plan for your approval**, then starts every independent ticket in parallel |
| `/tp-status` · `/tp-inbox` · `/tp-eod` | where every ticket stands · everything waiting on you, as one interview · the day's close, with estimates against actuals |
| `/tp-verify` · `/tp-doctor` | the project's gates, run once per commit against a cached baseline · the preflight that says whether a run can start at all |
| `/tp-setup` | the integration interview — run it again any time to change which skills are active |

Individual stages are invocable on their own (`/tp-review <PR>`, `/tp-plan <id>`,
`/tp-create-ticket`), and each one picks up a ticket that is not started yet.

## How it works

- **Every skill runs in its own fresh agent**, and the invoking context holds only
  reports — so a long run does not degrade the session driving it.
- **The work directory is the state.** One directory per ticket: a `.md` for people and
  a `.json` contract per stage, an append-only log, and a dependency-free script that
  computes where a ticket stands and what runs next. Nothing is decided by re-reading a
  chat, so any run resumes and several run side by side.
- **One worktree per repo per ticket**, from pickup to the end of the run — your own
  checkout is never touched.
- **The model follows the task, under a ceiling you set**: each agent is spawned on the
  tier its own work needs, never above the largest model you allowed at install, within
  your usage budget, and tokens are recorded per stage.

## Configuration

`/tp-setup` writes `pipeline.json` (which skills this project uses — versioned) and
`tiers.json` (the ceiling, the runtime's models, the three tiers derived from them and
every tunable — per machine), and prints the permission lines to allow. It asks one
question about models: the **largest one the pipeline may use**. Pick Sonnet and it works
with Haiku and Sonnet; pick Opus and it adds Opus; the pipeline's agents never run above
the answer, and `/tp-doctor` warns when your own session does. Everything project-specific — base branch, branch and commit
conventions, merge strategy, gate commands, what a merge triggers, environments — lives
in each repo's own conventions file, never in a skill.

Full reference, once installed: `<project>/.claude/skills/README.md` (§ Configuration
for every file you set, § Using it for the workflows). `skills/flowcharts.md` draws
every path a run can take, with each branch mapped to the file that decides it.

## Requirements

Node 18+, git, and whatever the project already uses. The tracker and chat tool are
reached through whatever tools the runtime exposes; a file-backed fixture tracker ships
with it, so the whole pipeline can be exercised without touching a real one.
