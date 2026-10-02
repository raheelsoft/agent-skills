---
name: ticket-pipeline-setup
description: Installs a complete ticket-to-accepted-work pipeline into a project — twenty-one Claude Code skills plus an unattended workflow runner that take a tracker ticket through pickup, triage, planning, implementation, pull request, unbiased review, merge, release and acceptance, each stage in its own fresh agent, every fact recorded on disk so any run resumes and several tickets run in parallel. Framework- and tracker-agnostic: the skills carry no project names, no branch names and no tool names — those come from the repo's own conventions file. Includes a day planner that proposes the day's tickets for approval and launches the independent ones in parallel, a virtual office and status board, an inbox that batches everything waiting on a person, quality gates that run once per commit against a cached baseline and skip whatever the repo's own git hooks already enforce, and an integration interview that picks which of the skills a project actually wants. Use when the user asks to set up or install the ticket pipeline, to automate a ticket workflow end to end, to run tickets unattended or overnight, to plan a day of tickets, or to add tracker-driven development to a repo.
---

# Ticket Pipeline Setup

Installs the ticket pipeline into a project's `.claude/` directory and runs its
integration interview. The pipeline itself is documented in
`pipeline/skills/README.md` — the authority for every rule it follows. Read that by
reference (`node <target>/.claude/skills/_lib/ref.mjs <target>/.claude "<Section>"`),
never end to end: it is large on purpose.

## What gets installed

| | |
|---|---|
| `skills/tp-*/` | twenty-one skills: `tp-run-ticket`, `tp-start-ticket`, `tp-triage`, `tp-plan`, `tp-implement`, `tp-create-pr`, `tp-verify`, `tp-review`, `tp-merge`, `tp-release`, `tp-accept`, `tp-retro`, `tp-plan-day`, `tp-inbox`, `tp-eod`, `tp-schedule`, `tp-status`, `tp-doctor`, `tp-notify`, `tp-create-ticket`, `tp-setup` |
| `skills/_lib/*.mjs` | the dependency-free scripts the skills share: state, day planning, models and budget, gates, hooks, generated code, the README-by-reference reader, the skill catalogue |
| `skills/README.md` | every rule, stated once — the skills point at it rather than repeating it |
| `skills/flowcharts.md` | every path the pipeline can take, each branch mapped to the file that decides it |
| `workflows/` | the same pipeline as a script for the runtime's workflow tool, for runs nobody watches |
| `tests/` | the scripts' own test suite (`node --test`), plus a simulation bed with a fixture tracker |
| `office/` | optional: a local page showing every agent at work, the day's board and the inbox |

The `tp-` prefix is deliberate — `status`, `plan`, `review`, `doctor` and `schedule`
are names a runtime command, a plugin or a personal skill already uses, and a
collision does not announce itself.

## Steps

### 1. Find the target

Ask the user which directory the pipeline should serve when it is not obvious: the
folder holding the repo, or the **parent** folder when several repos are worked
together as one ticket (the skills find the git checkouts at or under where the
session runs). The pipeline lives in `<target>/.claude/`.

### 2. Copy the payload

Copy this skill's `pipeline/` directory into `<target>/.claude/`, preserving the
tree — `skills/`, `workflows/`, `tests/`, `office/`, `launch.json` and `.gitignore`.

If `<target>/.claude/` already exists, **merge, do not replace**: copy the directories
above and leave anything else in place. If a `skills/tp-*` folder is already there,
tell the user what version is installed before overwriting anything, and never touch
`work/`, `tiers.json`, `notify.json`, `office.json`, `tracker.json` or
`settings.local.json` — those are the install's own state and configuration.

The bundled `launch.json` holds only the `office` and `office-sim` configurations, which
assume the session runs in `<target>`. If the project already has `.claude/launch.json`
(its own dev servers, usually), add those two configurations to it instead of replacing
it.

The bundled `.gitignore` keeps that state out of version control. If the project
already has `.claude/.gitignore`, add the missing lines instead of replacing it.
`pipeline.json` — which skills the project uses — **is** versioned; everything else
listed there is per machine.

### 3. Run the interview

Invoke `/tp-setup` (the freshly installed skill, in the invoking context — it asks the
user questions). It picks which skills the project activates by group, asks for the
largest model the pipeline may use — the **ceiling**, which every agent it spawns stays
at or below — and derives the three tiers from that answer, offers to start the
project's sessions on that model, offers to put the project's own gate commands into
its git hooks, writes `pipeline.json` and `tiers.json`, prints the permission lines the
selection needs, and ends with the preflight.

If the runtime has not picked up the new skills yet, say so and ask the user to start a
fresh session before running `/tp-setup`.

### 4. Tell the project about itself

The skills carry nothing project-specific. Point the user at the **conventions file**
in each repo (`AGENTS.md`, `CONTRIBUTING.md` or `CLAUDE.md`) and offer to draft the
section the pipeline reads: the base branch PRs target, branch and commit conventions,
merge strategy and who reviews, the gate commands, what a merge triggers, operator
follow-ups, environments and test data. Anything missing is asked once at the moment
it matters and recorded in the ticket's `answers.md`.

### 5. Check it

```
node <target>/.claude/skills/_lib/doctor.mjs run <target>/.claude   # or /tp-doctor
node --test '<target>/.claude/tests/*.test.mjs'
```

Then hand over the three commands that matter: `/tp-run-ticket <id>` for one ticket end
to end, `/tp-plan-day` for a day of them, `/tp-status` for where everything stands.
`<target>/.claude/skills/README.md` § Using it has the rest.

## Report

What was installed and where, which skills the interview switched on, what the
preflight said, and anything the user must still do — a conventions file section, a
permission line, a chat tool for notifications.
