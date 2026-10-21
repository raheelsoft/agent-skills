# The work directory

The state every stage shares: its files and contracts, the worktrees, and how runs do not collide.

**Contents** — [Work directory](#work-directory--the-state-every-stage-shares) · [Worktrees](#worktrees) · [Concurrency](#concurrency) (one run per ticket · scratch paths are per agent, never per purpose)

## Work directory — the state every stage shares

`<.claude>/work/<id>/`, `<id>` normalised to the tracker's identifier form by every
entry point. Kept after the run as the record; worktrees go when the run ends
(§ Worktrees). The runtime refuses an agent's own tools — a file tool, a shell redirect, a
`mkdir` — anything below `.claude/` when no person is there to approve it, except under
`.claude/worktrees/`. So the state script writes this directory (`put` the JSON, `log`,
`lock`, and `doc` every document, the text on stdin or from a draft), and what an agent writes
itself lives in `worktrees/` (§ Worktrees). Cross-repo tickets have one work directory with one repo row each;
stacked tickets have one each (`stackedOn`). `<.claude>/work/_scratch/` holds the
checkpoints and summaries of `/tp:review`, `/tp:verify` and `/tp:status`, which never log to a
ticket, the per-repo gate baseline and records (`_scratch/wt/base-<repo>`,
`_scratch/gates/<repo>/` — § Verification rules) and a by-hand review's own checkout
(`_scratch/wt/review-<repo>`); `<.claude>/work/_office/` holds the agents'
presence records (§ Observability); `<.claude>/work/_day/` the day plans (`/tp:plan-day`);
`<.claude>/work/_day/<date>.eod.json` and `.md` are the day's close (`/tp:eod`);
`<.claude>/work/_inbox/` answers queued for stops (§ Definitions, Asking the user);
`_budget.json` and `_doctor.json` at the work root are the last usage reading and the
last preflight (§ Models and budget; § Using it, Preflight); a skill without a work
directory that stops writes `_scratch/<skill>-<slug>.stop.json` beside its checkpoint
(`{ id: "<skill>:<slug>", skill, slug, kind, question, at, resume, needs? }`) so the
inbox lists it; `/tp:status` and the state script's `all` ignore every `_`-prefixed entry.

| File | Written by | Purpose |
|---|---|---|
| `ticket.md` / `ticket.json` | start-ticket; triage refines `estimate` and records `blockedBy`; `state.mjs blockers` re-checks it; `/tp:eod` records `actual` | the ticket, its rating, its estimate, its blockers and their last-checked states, the person's actual hours, its repos |
| `triage.md` / `triage.json` | triage | decision with evidence; approach (direct) or scope notes (plan) |
| `plan.md` / `plan.json` | plan, or implement for direct work | the executable plan; implement appends its Implementation summary section |
| `plan-check.json` | plan (`plan-lint.mjs --record` for a mechanical failure, else its checker) | `ok` / `revise` with findings, each marked `source: lint` or `checker` |
| `answers.md` | whichever stage asked | the person's answers, dated; the plan's approval is the line `go-ahead: <timestamp> — round <n> — <flags>` — no plan is implemented without it |
| `implement[.repo].json` | implement | steps done/total, commits, gates, deviations, stop, rating experienced |
| `pr[.repo].json` | create-pr; merge adds the passes, verdict and sha | PR url/number, update round, review passes, verdict, merge sha |
| `pr-body[.repo].md`, `pr-comment.md`, `ticket-comment.md` | implement drafts the body; create-pr checks and posts it and writes the comments (its describer only for a branch without a draft) | the latest round's description and comments as posted (the PR keeps every round) |
| `diff-validation.md` | create-pr (its validator on a creation round; the round's delta afterwards) | every changed file as Expected / Supporting / Unexpected, with a line of reasoning, and the sha validated through |
| `release[.repo].json` | release | the deploy run, follow-ups, smoke checks, promotion |
| `accept.md` / `accept.json` | accept | pass / fail / manual per criterion, with evidence |
| `retro.md` / `retro.json` | retro | plan-vs-reality, questions asked, time per stage; proposals by target |
| `research.json` | the researcher (`/tp:plan`, when `triage.json.research.needed`) | cited findings (`RS1` …) with confidence and sources, and what could not be settled; the plan cites them |
| `quality.json` | `findings.mjs record`, after every review pass | what the passes left open per priority (P0–P4), the score, the worst verdict — shown by `/tp:status` |
| `progress.md` | every stage, via the state script | append-only log |
| `report.md` | create-pr creates or appends; merge, release, accept, run-ticket append | what shipped, PR, verdict, merge, deploy, acceptance, deviations, follow-ups, manual steps |
| `checkpoint.<stage>[.<repo>].md` | any agent that hands off | done / decisions / remaining / open questions — the next agent starts here |
| `lock.json` | run-ticket via the state script | `{ owner, since, updated }` (§ Concurrency) |
| `<.claude>/worktrees/<id>/<repo-name>/` — not in the work directory | start-ticket; accept moves it to the merge commit; a new round re-branches it | the ticket's one worktree per repo, from pickup to the end of the run (§ Worktrees: removed by `/tp:accept`'s `done` once no manual criterion is open, or by `/tp:run-ticket`'s close-out of a closed or parked ticket). A ticket picked up before this layout has it at `wt/<repo-name>/` here; `ticket.json` records either |

The `.md` is for people; the `.json` is the contract the next stage and the state
script read. Every filesystem path a record holds — a repo's `path`, its `worktree` — is
**absolute** (§ Definitions, `<.claude>`), never relative to the directory the writing
agent happened to run in: the next stage reads the record from somewhere else.

```
ticket.json      { id, title, link, round: n, stackedOn: null|{ticket, branch, pr}, dependsOn: null|{ticket, branch},
                   acceptanceCriteria: [ "…" ], derived: bool, complexity: "low"|"medium"|"high",
                   estimate: { source: "tracker"|"pipeline", focusedHours, days, points, basis },
                   actual: null|{ focusedHours, source: "person"|"tracker", at, by },          ← /tp:eod, through state.mjs actual
                   blockedBy: [{ id, state, resolved, soft, checkedAt }],                      ← triage when it parks; state.mjs blockers on every re-check
                   repos: [{ name, path, worktree, branch, base, conventions, discarded?: "<why>" }] }   ← path, worktree: absolute
triage.json      { decision: "direct"|"plan"|"needs-input"|"close"|"blocked", confidence, override, flags: [],
                   questions: [ "<text>" | { text, choices: ["…"], default: "…" } ],   ← the script renders each as one line
                   blockedBy: [ "<id>" ],                                              ← blocked: the tickets that must land first
                   complexity: "low"|"medium"|"high", estimate: { … as ticket.json }, why: "<close: what delivers or supersedes it | blocked: what must land first>" }
plan.json        { status: "ready"|"open-questions", flags: [], steps: n, openQuestions: n, complexity: "low"|"medium"|"high" }
plan-check.json  { verdict: "ok"|"revise", round: n, override: null|"<timestamp> — <text>",
                   findings: [{ severity: "blocking"|"advisory", step, text }] }
implement.json   { repo, done, total, commits: [], gates: { <gate>: "PASS"|"FAIL" }, deviations: n|[ "<what and why>" ], stopped: null|{ step, question },
                   complexity: "low"|"medium"|"high"|"higher" }
pr.json          { repo, url, number, round, reviewRounds: n, reviews: [{ round, sha, verdict, open: [ids], new: [ids] }],
                   verdict: null|"PASS"|"PASS WITH WARNINGS"|"BLOCK", merged: null|sha }
release.json     { repo, sameAs: null|ticket, run: null|{ id, status, revision }, env: null|{ name, url },
                   followUps: [{ name, status, note, authority }], smoke: [{ check, result }], promoted: null|{ branch, sha, run } }
accept.json      { where: "live"|"checkout", targets: [{ repo, env, checkout }],
                   criteria: [{ n, text, result: "pass"|"fail"|"manual", evidence }], passed: n, failed: n, manual: n }
retro.json       { deviations: n, reviewFindingsMissedByCheck: n, questions: n, manualCriteria: n,
                   proposals: [{ target: "conventions"|"ticket-template"|"standing"|"skill", text, evidence }] }
```

Every one of these files has a JSON Schema in `schemas/` (`schemas/README.md`), with one valid
example each in `schemas/examples/`. A stage writes its file through `node <lib>/state.mjs put
<workdir> <artifact> …` — the JSON is checked first, a document that does not conform is refused
with one line per error and nothing is written, and the file carries `schemaVersion`. `node <lib>/validate.mjs
work <path>` checks what is already there (`/tp:doctor` runs it and reports drift as a warning:
a ticket an earlier run left in an older shape still reads).

`progress.md` grammar (the script enforces it):
```
- <YYYY-MM-DDTHH:MMZ> · <stage> · started|done|stopped|note · <summary> · <links>
```
`started` may have no summary and is logged after the state was read (Resume). `done`
closes a stage and is logged only when its outcome is final — for `create-pr` when the
PR is up and current (again on every update round), for `merge` after the merge, for
`accept` with no failed criterion; `plan` and `triage` log `done` and let
the script derive their waits. `stopped` carries the question — an implementer's
starts with `step <n> —`; an error stop starts with `error:` (§ Failures and
escalation); a usage pause is `stopped "usage at <n>% of <window> — resume after
<reset>"` on whatever stage is running (`run-ticket` between stages) and is resumed
by whoever invoked the paused skill — the session, `/tp:plan-day`'s advance or the
unattended runner — re-invoking it after the reset with no answer (`answers=resume`
says the same). Three waits are never logged: the script derives them from the stage's
JSON — a triage that ended `needs-input`, a triage that ended `blocked` (`blocked by
<ids> — nothing to answer — resumes when they are resolved`, `kind: blocked`; resumed
like a usage pause, by re-invoking the ticket once `state.mjs blockers` recorded every
blocker resolved or soft — § Definitions, Resume), and a plan with open questions or
awaiting the person's approval (the go-ahead line; any finding the check still holds
open is named) — and reports them as `stopped` with the question. `note` is anything in between (a step, a commit, a PR URL, a verdict, a
checkpoint, a token count). A stage whose `done` or `stopped` is older than a later
re-run of an earlier stage is **stale** and re-runs. A ticket is **closed** early —
`next: null`, `closed: { at, why }`, `/tp:status` shows `closed` — when triage decided
`close` or the run ended (`run-ticket done`) with stages still pending; a run that
ends at `until=` logs no `run-ticket done`, so it closes nothing; a later stage run (a
new round, `force=true`) reopens it. `problems` are inconsistencies only (a missing
file, a worktree on the wrong branch, a malformed line): the pipeline treats one as an
error stop — `needs:` the fix, `answers=retry` once made — never as a question. Only
stage names are logged: `/tp:review` and `/tp:verify` never write to `progress.md`.

## Worktrees

Each ticket gets **one** `git worktree` per repo, at `<.claude>/worktrees/<id>/<repo-name>/`
on a new branch from the base, and keeps it for the whole run: every stage runs
there — the implementation, the gates (`/tp:verify path=<worktree>`), the commits and the
push, the review's gates (`/tp:merge` hands the reviewer that path as a run fact: a
checkout at the PR's head, verified by the reviewer, never a claim), the release's
reads, and the acceptance (`/tp:accept where=checkout` moves it to the merge commit with
`git checkout --detach`). A checkout is expensive — the clone, the dependency install,
the generated code, the warm caches — so nothing removes and re-creates one between
stages, and a new **round** after a failed acceptance (`round=<n>`) re-branches the
same worktree (`<branch>-r<n>` from the base, which now holds the merged work; the
earlier stages re-run as stale) and re-installs only when a lockfile changed. It is
removed **once**, when the run ends: by `/tp:accept`'s `done` — the last stage, through `worktree.mjs finish`, which holds them
while acceptance left `manual` criteria (the person's `answers=confirmed` ends the hold; a failed step is a new round that re-branches them) — or by
`/tp:run-ticket`'s close-out of a ticket that ends before it (closed by triage, parked as
blocked); a stopped or abandoned ticket keeps it until the person cleans up (`/tp:status`
lists them with the commands). The only other checkouts are the pipeline's own under
`_scratch/`: one **baseline** per repo (`wt/base-<repo-name>`, detached at the base's
head, moved forward, never re-created — the gates' "vs base" comparison,
§ Verification rules) and a by-hand review's `wt/review-<repo-name>` when no checkout
at the PR's head was handed to it. The person's own checkout is never touched:
`/tp:release` runs only `git` reads and fetches against the repo path — its one push is
the promotion, and only with `promote=`. A stacked ticket continues the earlier
ticket's open branch in that ticket's worktree (`stackedOn`); a dependent ticket that
gets its own PR branches from the open branch and records `dependsOn`, and
`/tp:create-pr` sets the PR's base from it. A branch checked out in the person's own copy
is a stop, never worked around. The commands live in `/tp:start-ticket`'s instructions
(`branch-and-pull.md`).

**Why `worktrees/`, and what else goes there.** It is the one folder below `.claude/` the
runtime lets an agent write without a person at the prompt (it keeps it for git worktrees), so
the implementation can be edited, committed and gated by an unattended run. `worktrees/_out/<id>/`
holds the output of the commands an agent runs (§ Context management, rule 11) and the drafts
it hands to `state.mjs doc`: one folder per ticket, so two tickets running side by side
share no file name, and for the run's own use — it goes with the worktrees. A project's own test runner, linter and
compiler should skip `.claude/`, as they had to skip the worktrees that used to sit in `work/`.
The runtime's own sweep of old worktrees (`cleanupPeriodDays`) removes only those it created and
marked; a ticket's, made by the pipeline with plain git, is never swept. Both folders are per machine: `.claude/worktrees/` is in the
`.gitignore` of a project that is a git repository itself (`/tp:doctor` checks).

## Concurrency

- Tickets run side by side: each has its own work directory and worktrees, so nothing
  is shared except the remote and the base branch; merges into the base serialise on
  their own (each `/tp:create-pr` round syncs with the base before its gates). A cross-repo
  ticket's repos are implemented and merged in `ticket.json` order, never in parallel,
  and never two agents write to the same worktree — the reviewer runs its gates in the
  ticket's worktree only between the author's turns (`/tp:merge` runs one thing at a
  time) and writes nothing there (`/tp:verify readonly=true`); one `/tp:verify` at a time
  moves or runs a repo's baseline (`gates.mjs base` holds a lock, § Verification rules).
- **One run per ticket.** `/tp:run-ticket` takes the run lock as soon as the work
  directory exists — after `/tp:start-ticket` on a first run, before the first stage on a
  resume (`state.mjs lock <workdir> <owner>`) — and releases it at every stop and at
  the end. `owner` is stable for the run: the session's name or id, passed as `owner=`
  to every orchestrator it spawns, or an unattended run's `args.owner` (default
  `workflow`; distinct per launch that may overlap). Every `log` refreshes `updated`; a
  lock not refreshed for six hours is stale — `state` says so, `lock` takes it over,
  `unlock` releases it without `--force`. A live lock held by another owner is a stop
  for the second run (report the owner and `since`; `unlock … --force` only when the
  person says that run is dead — a lock owned by a scheduled run (`schedule:<task>:
  <stamp>`) whose task the scheduler reports finished is one; `/tp:inbox` names it, the
  release is still the person's word). Stage skills run by hand do not lock; `/tp:status` shows
  the lock so a hand run into a ticket another session drives is visible first.
- **Scratch paths are per agent, never per purpose.** Agents running at the same time share
  the session's scratch directory, so a fixed name — `gates.sh`, `run.log`, `harness.js` —
  is a collision waiting for two agents to want the same thing at once: the second writes
  over the first's script and the first runs the wrong gates, against the wrong checkout,
  and can report a PASS for work it never checked. Every scratch file or directory an agent
  writes carries something unique to that agent — the PR or ticket id and a timestamp at
  minimum (`gates-pr163-<stamp>.sh`) — and an agent reads back only paths it wrote. The
  gate-output directories `gates.mjs` creates are already per-run; this is about everything
  an agent improvises around them.
