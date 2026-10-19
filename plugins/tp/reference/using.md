# Using it

Install, run, resume, schedule, simulate: how a person uses the pipeline.

**Contents** — [Using it](#using-it) ([Install](#install) · [One ticket, one command](#one-ticket-one-command) · [Stage by stage](#stage-by-stage) · [When it stops](#when-it-stops) · [Several tickets, or nobody watching](#several-tickets-or-nobody-watching) · [A day at a time](#a-day-at-a-time) · [Simulation](#simulation) · [Preflight](#preflight) · [End of day](#end-of-day) · [After acceptance](#after-acceptance))

## Using it

### Install

1. Add the marketplace and install the plugin at **project scope**, so its skills and
   hooks belong to this project and travel with it:
   ```
   /plugin marketplace add raheelsoft/agent-skills
   /plugin install tp@raheelsoft
   ```
   (To try it without installing: `claude --plugin-dir <agent-skills>/plugins/tp`.) The
   plugin carries everything that is the same for every project — the skills, the
   scripts, this reference, the unattended workflow, the office, the tests — and a
   project keeps only its own configuration and state in `<project>/.claude/`:
   `pipeline.json` (which skills it uses — versioned), `tiers.json`, `notify.json`,
   `office.json`, `tracker.json`, `settings.local.json` and `work/`. Add every one of
   them but `pipeline.json` to `.gitignore` (per machine): `.claude/work/`,
   `.claude/worktrees/`, `.claude/tiers.json`, `.claude/notify.json`, `.claude/office.json`,
   `.claude/tracker.json`, `.claude/settings.local.json`. `<project>` is the folder that
   holds your repo, or the parent folder of several repos worked together (the skills
   find the git checkouts at or under where the session runs).
2. Run **`/tp:setup`** — the integration interview (`skills/setup/SKILL.md`). It asks,
   one question per group, which skills to activate (§ The skills: the core is
   preselected, `/tp:schedule` is not; a dependency left out is added and named), asks
   once for **the largest model the pipeline may use** and writes `tiers.json` from it —
   the only place a model name is ever written (§ Models and budget, The ceiling) — with
   the offer to start this project's sessions on that model, offers to put each
   repo's own gate commands in its **pre-commit and pre-push hooks**, which is what
   makes those gates free for the pipeline (§ Verification rules), asks which documentation
   sites the planning researcher may read (none by default), writes
   `pipeline.json`, prints the permission lines the selection needs, runs
   `/tp:notify setup` when notifications are on, and ends with `/tp:doctor`.
   `/tp:setup all=true` takes every skill without asking and `ceiling=<model>` answers
   the ceiling; `/tp:setup` again changes either; `/tp:setup status` shows the selection.
   Have available: `git`; Node 18+ (the scripts); the hosting platform's CLI or tool;
   a connection to your tracker; optionally a chat tool the session can post to.
   The permission lines `/tp:setup` prints — the pipeline's own commands, allowed once so
   no agent waits on a prompt for them — go in the runtime's permission settings
   (`<.claude>/settings.json`, `permissions.allow`; adjust the command syntax to your
   runtime); the full set is:
   ```
   Bash(node <lib>/*)   Bash(node <plugin>/office/*)   Bash(node --test *)
   Bash(git status*) Bash(git diff*) Bash(git log*) Bash(git show*) Bash(git fetch*) Bash(git rev-parse*)
   Bash(git merge-base*) Bash(git branch*) Bash(git worktree *) Bash(git checkout *) Bash(git switch *)
   Bash(git add *) Bash(git commit *) Bash(git merge *) Bash(git push *)
   Bash(<hosting CLI> pr *) Bash(<hosting CLI> run *) Bash(<hosting CLI> api *)
   Bash(<the gate commands the conventions file names>)
   Edit(//<absolute path of .claude>/worktrees/**)
   ```
   The first two name the plugin's own folder, which moves when the plugin updates:
   `/tp:doctor` flags a rule that no longer matches and `/tp:setup` prints the new line.
   The `Edit` line names this project's `worktrees/` (the absolute form, with the leading
   `//`): the run edits its checkouts and sends command output to files there without a
   prompt, which is the write the runtime lets an agent make below `.claude/`.
   Add the tracker's and chat tool's read tools as the runtime lists them (§ Definitions,
   Tracker — a fixture tracker needs none). Everything
   else stays a prompt (§ Definitions, Tools and permissions). In `tiers.json`, set
   `prices` (§ Models and budget, Cost — without it costs stay empty) and
   `doctor.checks` (§ Using it, Preflight — the hosting CLI's auth check, e.g. `{ "name":
   "hosting CLI", "run": ["<cli>", "auth", "status"] }`); `gates` (§ Verification
   rules: `lockMinutes` 30, `keepBases` 10, `keepResults` 50) needs no setting.

   **Writes under `.claude/`.** The runtime treats anything below a `.claude` folder as its
   own configuration: its file tools (Write, Edit), a shell redirect and a `mkdir` there ask a
   person, and no permission rule, no hook and no accept-edits mode answers in their place —
   only a person at the prompt, or the runtime's bypass mode. The exception is
   `.claude/worktrees/`, which it keeps for git worktrees. The pipeline is built to that: the
   state script alone writes the work directory (`put`, `log`, `lock`, `doc`), and the two
   things an agent writes with its own tools — a ticket's checkouts and the output of its
   commands — live in `<.claude>/worktrees/` (§ Worktrees). So an unattended run (`claude -p`,
   the workflow script, a scheduled task) needs a mode that lets it edit files and redirect
   output (`acceptEdits`), or the allowlist above with its `Edit` line — and no bypass. A
   raw write to the work directory is refused by a hook, with the command that takes it.
3. Tell it about the project in the **conventions file** (the first of `AGENTS.md`,
   `CONTRIBUTING.md`, `CLAUDE.md` in each repo) and your standing instructions. The
   skills look there for: the base branch PRs target; branch and commit conventions;
   merge strategy and whether a passing review may merge without asking; who reviews;
   the gate commands or package scripts; what a merge triggers (pipeline name, how to
   list its runs, typical duration); operator follow-ups after a merge; environments
   (name, URL, a health/version endpoint); how to make a disposable copy of shared
   data; test accounts or fixtures for acceptance; the priority order of ticket kinds
   when the pipeline picks the next ticket. Anything missing is asked once, recorded in
   the ticket's `answers.md`, and `/tp:retro` later proposes moving recurring answers into
   the conventions file.
4. Check the scripts on your Node: `node --test '<plugin>/tests/*.test.mjs'`. What is on
   and off, and any inconsistency in `pipeline.json`, is `/tp:setup status` (also a
   `/tp:doctor` check).
5. Optional — the office (§ Observability): `<.claude>/office.json` names the team, the
   projects always drawn and the name pools; `node <plugin>/office/serve.mjs --work
   <.claude>/work` serves it at `http://127.0.0.1:4820/` (`--sim` for a demo loop of
   every panel — the inbox, the day board, the drawer, the gauge); `cd
   <plugin>/office/electron && npm install && npm start -- --work=<.claude>/work` opens
   the same page as a desktop window, with the number of stops waiting on a person as
   the dock badge.
6. A project that ran the pipeline from a copy in its own `.claude/` (`skills/`,
   `workflows/`, `tests/`, `office/`) removes those folders once the plugin is on;
   `work/`, `tiers.json`, `pipeline.json` and the other files keep working as they are.
   A `pipeline.json` that names a skill `tp-merge` is read as `merge`, and a command an
   older run stored with the old hyphenated prefix is shown with the namespace
   (`/tp:run-ticket …`).
   `node <lib>/setup.mjs migrate <.claude>` lists what is left of the copy, which
   permission lines name it and which `launch.json` entries start its office (`--fix`
   points them at the plugin's office, and again after an update moved the plugin).



Every file below sits in `<project>/.claude/` unless it says otherwise. `/tp:setup`
writes the first two and prints the allowlist; the rest you set once, or never.

| File | Written by | Versioned | What it holds |
|---|---|---|---|
| `pipeline.json` | `/tp:setup` | yes — the project's choice | which of the skills this project uses; an absent file means all of them |
| `tiers.json` | `/tp:setup`, then by hand | no — per machine | `ceiling` (the largest model the pipeline may use), `ladder` (the runtime's models, smallest first) and the three tiers `low`/`medium`/`high` derived from them — **the only place a model name is written** (§ Models and budget, The ceiling). Also every tunable, each with a working default: `prices` (§ Models and budget), `budget`, `retries`, `compact`, `review`, `day`, `estimate`, `checks`, `doctor`, `gates`, `hooks`, `codegen`, `research` (`{ allow: [<documentation domains the researcher may read>], maxFetches: 8 }` — empty `allow` means the codebase alone; `/tp:setup` asks, or `setup.mjs research <.claude> allow=<domains\|none>`) |
| `notify.json` | `/tp:notify setup` | no — per install | the chat tool and the channel one line per stop goes to; without it notifications are a silent no-op |
| `settings.json` | you; `/tp:setup` writes only the deny rules | yes — the team's | the plugin enabled at project scope, and one `Skill(skill:tp:<name>)` deny rule per skill that is off. Those rules are the only part `/tp:setup` writes, and it owns only rules of exactly that shape: every other key and rule is yours. `/tp:doctor` flags a rule that no longer matches `pipeline.json`; `setup.mjs sync` regenerates them |
| `settings.local.json` (or your runtime's settings) | you, from the list `/tp:setup` prints; `model` by `/tp:setup` when you accept its offer | no | the permission allowlist — the commands the skills may run without asking — and the `model` a session in this project starts on (§ Models and budget, The ceiling) |
| `office.json` | you, optional | no | the office's team name, the projects always drawn, the name pools (§ Observability) |
| `tracker.json` | you, only for a dry run | no | `{ "kind": "fixture", "path": "<abs>" }` — points the skills at the file-backed tracker instead of a real one (§ Simulation) |
| `hosting.json` | you, only for a dry run | no | `{ "kind": "fixture", "path": "<abs>" }` — points the skills at the file-backed hosting platform (`lib/hosting.mjs`, pull requests over the repos' own remotes) instead of a real one (§ Simulation) |
| each repo's **conventions file** (`AGENTS.md`, `CONTRIBUTING.md` or `CLAUDE.md`) | you | yes — it is the repo's | everything project-specific: base branch, branch and commit conventions, merge strategy and who reviews, the gate commands, what a merge triggers, operator follow-ups, environments, test data. The skills carry none of this |
| each repo's `.husky/` hooks | `/tp:setup` | yes — the team's | the gates the repo enforces itself, which the pipeline then does not re-run (§ Verification rules) |

Nothing else is configuration. A skill reads the project's facts from the conventions
file and your standing instructions, and everything a run produces goes in the work
directory (§ Work directory), never into settings.

### One ticket, one command

```
/tp:run-ticket ABC-123
```

runs in an orchestrator agent and returns one line per stage —

```
1/8 start-ticket · feat/inline-search in api
2/8 triage · plan (high)
3/8 plan · 4 steps · risks: access-control · check ok · approved
4/8 implement · api · 4/4 steps · gates PASS
5/8 create-pr · <PR url> · gates PASS
6/8 merge · api · review PASS WITH WARNINGS ×2 · merged 3f2a9c1
7/8 release · api · run succeeded · 1 follow-up · smoke pass
8/8 accept · 5 pass · 0 fail · 1 manual
```

— the plan line is where every planned ticket first stops: the checked plan is put to
you for approval (`go-ahead`) or changes, and the run continues from your answer —
followed by what shipped, the PR, the verdict, the deploy, the acceptance table and
the manual steps left for a person. `/tp:status` shows where it is meanwhile. The
ticket's status is yours to close; `accept.md` is the evidence. A fresh project is
asked once for its notification channel (§ Observability). Options are the skill's
Input (`/tp:run-ticket`): `mode=direct|plan`, `promote=`, `where=`, `env=`, `retro=true`,
`until=`, `round=`, `tier=`, `merge=auto|ask`, `owner=`, `answers=`, plus any stage's
own argument, forwarded to it.

### Stage by stage

Every command in the table above works on its own, from wherever the ticket is: a
stage invoked ahead of the ticket's state brings it there first (§ Definitions, Entry
points) — `/tp:merge ABC-123` on a fresh ticket runs pickup, triage, plan, implement and
the PR before the merge; `/tp:implement ABC-123` on a triaged ticket runs the plan when
triage asked for one, stops for its approval, then runs itself. Each spawns the skill's agent and relays its
report — a stop as an interview. `/tp:create-pr` also works on any branch without a
ticket; `/tp:review` on any PR; `/tp:verify` in any checkout.

### When it stops

A stage stops for something a person must decide or fix — a soft-blocked ticket, an
open question in the plan, **the plan itself** (every checked plan is presented for
approval or changes before anything is implemented), an implementer that cannot choose, an
ambiguous conflict, a review loop that stopped converging, a merge that needs a yes, a
failed deploy, a failed criterion, a usage limit, a lock held by another run. The stop
is logged with the exact question, the lock is released, `/tp:notify` sends one line, and
the report carries it (a lock held elsewhere is only reported — nothing is logged or
unlocked in a ticket another run drives). A failure nobody could auto-resolve is the
same shape with `error:` in front, `needs:` naming what you must fix and
`answers=retry` to go on (§ Failures and escalation). In a session the stop reaches
you as an interview — each question with its choices and the default — and the run
resumes by itself with what you chose. When the question is about a document — a
plan, a day's plan — that document is put in front of you in the conversation first,
so you can read it and quote it back as a change; an interview's options are for
choosing, not for reading (§ Definitions, Asking the user). To answer
later, or from another session:

```
/tp:status ABC-123                                # what it is waiting on
/tp:run-ticket ABC-123 answers="1: … | 2: …"      # or the stage itself: /tp:implement ABC-123 answers="…"
```

Resume is automatic: only what isn't done runs (§ Definitions, Resume).
`/tp:status problems` lists tickets whose state is inconsistent — an error stop naming
the fix; `answers=retry` once it is made. `/tp:inbox` is the same for everything at once:
every open stop across tickets and days with its kind and resume command; what can go
on by itself (an answer queued from the office, a usage pause past its reset, a parked
ticket whose blockers landed) is re-invoked, the rest is put to you in one interview.

### Several tickets, or nobody watching

`/tp:run-ticket A B C` runs each ticket in its own agent, worktree and work directory —
the orchestrators are spawned together, so the tickets run in parallel from the first
minute; `/tp:run-ticket next count=3` picks three that are unblocked and independent of
each other and does the same; `/tp:plan-day` is the full form (blockers, dependencies,
the day's plan, § A day at a time). For a batch nobody will watch, the same chain
exists as a script for the runtime's workflow-script tool (the plugin's
`workflows/run-ticket-unattended.js`, run as `/tp:run-ticket-unattended`, opt-in —
§ Unattended runs).

### A day at a time

```
/tp:plan-day                                   # today's sprint tickets — or a draw from the open pool
/tp:plan-day "Roles & Permissions" count=3     # only that feature, at most three tickets
```

picks the day's tickets — the current sprint when the team runs one, otherwise a
random draw from the open pool, seeded by the date — keeps only what nothing outside
the day blocks, orders the rest by what depends on what, **puts the plan to you
first** — `approval needed: day plan <date> — now: A, B · then: C after A — approve
(go-ahead), or adjust: drop <ids> | only <ids> | add <ids> | first <ids> |
lanes=<n|all>`; an adjustment comes back as a new proposal, `go-ahead` starts it
(`approve=true` skips the question; from the office, the answer is typed on the
inbox card) — and **schedules them into your days**: a day is `hours × focus` focused hours (the person's day of § Models
and budget, Estimates — 5.2 h by default), every extra ticket in a day costs the
switch hours, a ticket larger than what is left of a day starts anyway and carries
over, and a ticket already running takes its attention share out of today. Each
ticket's hours are the tracker's estimate or the pipeline's own. Two tickets of 6 h
and 4 h on an 8-hour day therefore read:
`day 1 · A 5.2h` and `day 2 · A 0.8h, B 4h` — that is your attention forecast, not
the pipeline's order: **every ticket that is unblocked and depends on nothing still
open starts now, in parallel**, through one `/tp:run-ticket A B …`; a dependent starts
the moment its prerequisite's code is on the base branch; each time a run returns,
whatever became ready starts. The usage budget is the only cap (`tiers.json.day.lanes`:
none when the window is `ample` or unread, one at a time in `economy`, nothing at
`stop`; `lanes=<n>` overrides). What yesterday's plan left unfinished comes first
today. `hours=4` or
`focus=0.4` describe a short or meeting-heavy day. A ticket parked on a blocker —
skipped by the plan, or parked by triage — is re-checked by every advance and by
`/tp:inbox`, and re-queued or resumed the moment its blockers are resolved. The plan and
its progress are `<.claude>/work/_day/<date>.json` and `.md`; `dry=true` plans
without starting.

### Simulation

`node <plugin>/tests/sim/setup.mjs [<dir>] [--tiers <tiers.json>]` builds a throw-away
project: two small repos (`api`, `web`) on `main` with a conventions file and a bare
remote each, and a `.claude` holding `tiers.json` (the models of the file given with
`--tiers`, else placeholders), `tracker.json` pointing at a copy of the fixture tracker
(`tests/fixtures/tracker.json`: a sprint, an epic with children, a blocked ticket, a
bug, a tracker estimate, a finished ticket), `hosting.json` pointing at a file-backed
hosting platform over the two bare remotes (`lib/hosting.mjs`, § Definitions, Hosting
platform), a silent `notify.json` and the allowlist; the pipeline itself is not copied — a
session opened there loads the plugin by path (`claude --plugin-dir <plugin>`) and runs it
against no tracker account and no hosting account: `/tp:doctor`, `/tp:plan-day` (the sprint
from the fixture), `/tp:status`, `/tp:inbox`, `/tp:eod`, and `/tp:run-ticket <id>` from pickup
to acceptance — a pull request is a real branch on the bed's bare remote, opened, reviewed and
merged through `hosting.mjs`, so the review loop, the merge and the acceptance run for real;
the one thing a bed cannot show is a deploy (its conventions file says none runs after a
merge). The office serves the bed's own work directory. The fixtures are copied, so nothing
a run does reaches `tests/fixtures/`.

### Preflight

`/tp:doctor` asks whether the install can run a ticket right now — Node and git, every
repo's remote reachable with the identity it needs, the hosting platform's CLI logged
in (`tiers.json.doctor.checks`), the tracker answering, `tiers.json` valid with a
ceiling its tiers agree with (§ Models and budget, The ceiling), `notify.json`
and `office.json` valid, the runtime's allowlist complete, the work directory clean
(no stray file at its root, no stale lock, no orphan worktree) — and prints each
failure with its fix. It also reports what the repos' hooks enforce (§ Verification
rules) and whether the active skills match `pipeline.json` (§ Definitions, Active
skills). The context that invokes it passes the model it runs on (`session=`); that model,
or the one the project's settings start a session on, being above the ceiling is a
warning, never a block. `/tp:plan-day` and `/tp:run-ticket` run it by themselves before a run: `node
<lib>/doctor.mjs fresh <.claude>` — exit 0 fresh and clean, nothing to
do; **exit 1** (no preflight, or older than `doctor.maxAgeHours`, a day) → invoke
`/tp:doctor session=<the model this context runs on>` and go on from its table; **exit 2** (the last one failed), or a fresh
`/tp:doctor` reporting a failure → its error form is the invocation's report and nothing
runs. So an expired credential or a missing key is an error stop *before* a run, not
inside one; with `/tp:doctor` off for the project (§ Definitions, Active skills) no
preflight runs at all.

### End of day

`/tp:eod` closes the day: what finished, what stands where and on what it waits, each
ticket's estimate against the pipeline's minutes, tokens and cost, what carries over
to tomorrow, and how far the estimates drift — written to
`<.claude>/work/_day/<date>.eod.md`, one line to the channel. It asks you once, in one
interview, the hours you actually spent on each ticket that finished today (the
estimate is the default, `skip` records nothing): those actuals are what teaches the
estimates (§ Models and budget, Estimates).

### After acceptance

All pass → close the ticket yourself; the worktrees are gone (`/tp:accept`'s `done`
removes them — the run's last stage, § Worktrees). A criterion fails →
`/tp:run-ticket ABC-123 round=2` (the same worktree, re-branched from the base, which now
holds the merged work). `/tp:retro ABC-123` proposes changes to the conventions file, the
ticket template or your instructions. `/tp:status` lists anything still checked out by a
stopped or abandoned ticket, with the commands.
