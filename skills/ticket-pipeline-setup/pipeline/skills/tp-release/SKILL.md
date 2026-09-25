---
name: tp-release
description: After the merge: watch the deployment or publish it triggered, run the documented operator follow-ups, smoke-check where it runs, promote to a release branch only when asked; records release.json.
user_invocable: true
---

Stage 7 of the workflow (`skills/README.md`): from "merged into the base branch" to
"running where the project runs it, with the follow-ups done". Nothing here changes
code. Conventions and the state script: the README (§ Definitions: Resume, Output
contract, Asking the user, The scripts).

Invoking this skill authorises watching runs, read-only smoke checks, and the operator
follow-ups the project's docs prescribe after a merge (`skills/README.md`
§ Verification rules — the one sanctioned mutation of shared state, and only with the
user's standing authorisation). It does **not** authorise promotion to another branch
(needs `promote=`) or anything the docs don't prescribe.

## Input

- `<id>` — the ticket; `pr[.repo].json` shows `merged` for every repo (the state
  script's `next` is `release` / `release:<name>`). Not merged yet → the earlier
  stages run first, the merge included (`skills/README.md` § Definitions, Entry
  points).
- `repo=<name>` (optional) — cross-repo tickets: narrows this run to one repo.
  **Left out, this one agent covers every repo whose `release:<name>` stage is not
  done**, in `ticket.json` order, which is deploy order: watching a second pipeline is
  a command, not a reason for a second agent's floor (`skills/README.md` § Context
  management, rule 9). A stop or an error in one repo ends the run there.
- `promote=<branch>` (optional) — also fast-forward the base into that branch once the
  base deploy is healthy. Never inferred; the user says it.
- `answers=<text>` (optional) — the answer to this stage's last stop (§ Stops;
  `skills/README.md` § Definitions, Resume).
- `continue=true` — start from `checkpoint.release[.<repo>].md`. `force=true` — re-run
  a done release stage (§ Definitions, Resume).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: the ticket's current rating (`state.mjs state` → `complexity`), `high` when a
  documented follow-up mutates a shared environment.

## Steps

**The steps below are one repo's.** Without `repo=`, run them start to finish for each
repo whose `release:<repo>` stage is not done, in `ticket.json` order, logging that
repo's `started`/`done` around its own pass and writing its own `release.<repo>.json` — the next repo begins only
when the one before it is done. One repo's stop or error ends the run at that repo
(the later ones stay pending, and the state's `next` names the one to resume at).
A single-repo ticket is the same thing with one pass.

### 1. Read the state, log, and find out what the merge triggers
`state.mjs state <workdir>` then `state.mjs log <workdir> <stage> started`. From the
repo's conventions file and docs
(then `answers.md`): what a merge into the base triggers — a CI/CD run and how to list
its runs, a publish step (a tag, a registry), a hand-run deploy, or nothing; where the
result can be reached (an environment name and URL, an installed binary, a package
name); and which post-merge steps the docs mark as operator follow-ups (a data migration
run by hand, a reconcile script, a cache flush, a config reload). Nothing documented →
`stopped` with the question; on the answer, record it in `answers.md` and, when it is
project-wide, suggest adding it to the conventions file so no ticket asks again.

**Stacked tickets share a merge.** If another work directory's `release[.repo].json`
already records this merge sha, record `sameAs: <ticket>` and skip steps 2–4 for it —
one deploy is watched once and a follow-up runs once.

Each step is a checkpoint boundary (rule 7): `checkpoint.release[.<repo>].md` holds
the run id, the follow-ups done, the smoke checks so far. Steps 2 and 4 are reads —
list runs, wait, request an endpoint — that this agent makes itself, keeping one line
per result (`skills/README.md` § Context management, rule 4: a command's result needs
no agent); step 3's follow-ups are the one kind of work spawned, an **operator** per
follow-up, because each mutates a shared environment and must run under exactly the
tools its command needs and nothing else (rule 9; office id
`<id>:<stage>:engineer:<n>` — `<stage>` as logged, `release:<name>` on a cross-repo
ticket — this agent as `parent`, the join/leave commands, the output contract). This
agent judges every fact, classifies a failure (`model.mjs retry`, § Failures and
escalation) and logs every stop.

### 2. Watch the run — this agent, read-only
With the repo path, remote and base, the merge sha (`pr[.repo].json.merged`), how the
docs say runs are listed and the typical duration, and the deploy tool's read commands
and `git` reads: find the run for this merge — the runs of the base branch, most
recent first, whose source revision is the merge sha or a descendant of it (`git -C
<repo path> fetch <remote>` first, then `git -C <repo path> merge-base --is-ancestor
<merge sha> <run revision>` — reads only, never a checkout); a run that built a later
base head containing the merge counts. Wait for it with bounded background waits (the
tool's own wait command where it has one — `--exit-status` style, its output to a
file — else a sleep between listings that ask for fields only, `--json id,status,
headSha`-style, never the whole run list; § Context management, rule 11), keeping
only its id, status and source revision (the deployed revision) — or the failure and a
log excerpt of ~20 lines (`grep`/`tail` of the log written to a file, never the log). Then decide:
a transient failure is retried within its bound; a failed or timed-out run the person
can act on → `stopped "run <id> <status> — retry, or skip? Default: retry"`; an
infrastructure failure nobody here can change → the error form. Nothing to watch
(hand-run deploy, publish by tag) → the documented step is the follow-up and `run:
null`; nothing at all (a library with no publish on merge) → `run: null` and say so.

### 3. Follow-ups — one operator per tool set (`high` when it mutates a shared environment)
For each documented follow-up that applies to this change (the plan's § Risks and
rollback and § Out of scope say what kind of change it was — direct work writes them
from triage's flags): when the docs prescribe it as an operator step and the person's
standing instructions allow, spawn an operator whose prompt is that follow-up —
the doc line, the exact command, the environment, the `authority` — and whose tools
are the environment tools that command needs, nothing else; it runs it and returns
the result. **Follow-ups that need the same environment and the same tools share one
operator**, in the documented order, each carrying its own doc line, `authority` and
result: the tool set that operator gets is exactly what each of them needed alone, so
nothing widens, and three scripts on one box cost one agent's floor instead of three
(`skills/README.md` § Context management, rule 9). A follow-up needing a tool the
others do not gets its own operator — that is what the narrow tool set is for. Otherwise list it and `stopped "follow-up <name> is not prescribed as an
operator step — run it, or skip? Default: skip"`. Record each as done /
skipped-with-reason, with `authority`: the doc line and the instruction that allowed
it.

### 4. Smoke — this agent, read-only
Against the environment (name, URL or CLI) and the deployed revision: the checks the
docs suggest and what the change's frontier — `git diff --stat <base>...<merge sha>`
and the hunks that name something visible (rule 8) — says the change should make
visible. Cheap checks, requests and read-only commands run by this agent, no browser,
no shared-data mutation: a health or version endpoint that reports the deployed
revision, a response header the change introduced, the installed CLI's version
string, a registry query for the published version, a log line — each kept as the
check and the one line that proves its result. A failed check → the evidence goes into
`release.json` and `report.md`, and this agent logs `stopped "smoke: <check> failed
(see release.json) — retry, or skip? Default: retry"`; `skip` records the check as
`failed — skipped by the person` and the stage ends `done`; otherwise the stage is
not done until the environment reflects the merge.

### 5. Promote (only with `promote=`)
For each repo in `ticket.json` order: fast-forward the target to the base
(`git -C <repo path> push <remote> <remote>/<base>:<target>`) only when the target is an
ancestor of the base; otherwise `stopped "promote: <target> is not an ancestor of
<base> — reconcile it yourself and retry (retry), or skip the promotion (skip)?
Default: skip"` — never a merge into a release branch. Watch the run it triggers as in step 2 and
record it.

### 6. Record and report
`release.json` (`release.<name>.json` for a cross-repo ticket):
```
{ repo, sameAs: null|ticket, run: null|{ id, status, revision },
  env: null|{ name, url }, followUps: [{ name, status, note, authority }],
  smoke: [{ check, result }], promoted: null|{ branch, sha, run } }
```
`env` is where the smoke checks ran — `/tp-accept` reads it. Comment on the ticket:
deployed where, revision, follow-ups done or pending, smoke results. Append the same to
`report.md`. `state.mjs log … done "<run status> - <n> follow-ups - smoke pass"` (or
`stopped`). Next: `/tp-accept <id>`.

## Stops
Nothing documented about what the merge triggers (`answers=<what it triggers and
where it runs>`); a failed or timed-out run the person can act on
(`answers=retry|skip`); a follow-up the docs don't prescribe (`answers=run|skip`); a
failed smoke check (`answers=retry|skip`); a promotion target that isn't an ancestor
of the base (`answers=retry|skip` — the person reconciles the target themselves;
never a merge); `hand-off budget spent` (`answers=continue`); `error: …` — a deploy tool or
environment unreachable past its fallback, an operator that returned nothing twice
(`skills/README.md` § Failures and escalation): `answers=retry` once the person has
done what `needs` names.
