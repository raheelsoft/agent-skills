---
name: create-pr
description: Takes a feature branch to a pushed, described, gated pull request against the base branch: commit, sync, gates and diff validation, push, PR and ticket comments. Use after implement; the review and the merge are /tp:merge's.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`) · `<skill>` = `${CLAUDE_SKILL_DIR}` (this skill's folder, where the `instructions/` and `examples/` files named below are). The JSON files this skill writes (`<artifact>.json` below) go through `node <lib>/state.mjs put <workdir> <artifact> …` — checked against `schemas/` first; `examples/pr-json.md` shows good ones and bad ones with the refusal they get — never through the file tools or a shell redirect: a hook refuses a raw write. Its `.md` documents are written the same way: `node <lib>/state.mjs doc <workdir> <name>`, the text on stdin or `--from <file>` (`--append` adds to the end); a long one is drafted under `<.claude>/worktrees/_out/<id>/`, the one place below `.claude/` an agent may write. Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

Take a feature branch from "ready for review" to a pushed, described, review-ready
pull request (PR below also means merge request) — or, if the PR already exists, sync
it with a fresh round of changes. What happens next — the review loop and the merge —
is `/tp:merge`'s (stage 6); this is stage 5 of `reference/README.md`.

Invoking this skill is itself the authorization to commit, sync, push and post to the
hosting platform and the tracker for this run. Project-specific rules (sync strategy,
commit convention, PR template) come from the repo's conventions file and the person's
standing instructions — never from this skill. Judgment stays in this skill's dedicated
agent; it spawns another only for a reading it should not hold itself (the whole
branch's validation on a creation round; its description only when `/tp:implement` left
no draft) or a fix (`reference/context-management.md` § Context management, rule 9), and reuses a
gate result already recorded for the commit instead of running the gates again
(§ Verification rules). With a work directory everything runs
in the ticket's worktree, `ticket.json` and `plan.md` are the inputs, each fact (PR
URL, number) is a `note` mirrored into `pr[.repo].json`, and `done` means the PR is up
and current; a run that ends otherwise logs `stopped` with the reason (§ Stops).

## Input

- `<id>` (optional) — the ticket; its work directory. Without it, the work directory
  whose `ticket.json` names the current branch; none → the current checkout and branch
  are the only inputs and nothing is logged. A ticket whose state is before this stage
  → the earlier stages run first (`reference/definitions.md` § Definitions, Entry points).
- `repo=<name>` — cross-repo tickets: narrows this run to one repo (stage
  `create-pr:<name>`). **Left out, this one agent covers every repo whose stage is not
  done**, in `ticket.json` order — one PR, one `pr.<repo>.json` and one
  `create-pr:<repo>` stage row each, the steps below run once per repo — because a
  second agent for the second repo would pay an agent's whole floor again to re-read
  the ticket and the plan this one already holds (`reference/context-management.md` § Context
  management, rule 9). A stop or an error in one repo ends the run there; the resumed
  invocation starts at the first repo still not done.
- `update=true` — an update round requested by `/tp:merge` after review fixes: run every
  step on the existing PR (step 1 classifies it as an update round) even though the
  stage is `done`; log `started`/`done` again — the record shows every round. On a
  cross-repo ticket `repo=` defaults to the repo whose `merge:<name>` is in progress
  or stopped.
- `answers=<text>` — the answer to this stage's last stop (§ Stops; § Definitions,
  Resume).
- `continue=true` — start from `checkpoint.create-pr[.<repo>].md`. `force=true` —
  re-run a done stage whose PR is gone (§ Definitions, Resume).
- `inline=true` — `reference/definitions.md` § Definitions (Dedicated agent); this agent's
  rating: the ticket's current rating (`state.mjs state` → `complexity`) raised by
  `model.mjs rate` on `git diff --stat <base>...HEAD` (generated code excluded).

## Steps

**The steps below are one repo's.** Without `repo=`, run them start to finish for each
repo whose `create-pr:<repo>` stage is not done, in `ticket.json` order, logging that
repo's `started`/`done` around its own pass and writing its own `pr.<repo>.json` — the next repo begins only
when the one before it is done. One repo's stop or error ends the run at that repo
(the later ones stay pending, and the state's `next` names the one to resume at).
A single-repo ticket is the same thing with one pass.

Each numbered step is a checkpoint boundary (rule 7): on `checkpoint` the agent
writes `checkpoint.create-pr[.<repo>].md` — steps done, the intent from step 2, the PR
URL, the verdict so far, what remains — and returns `continue: <path>`. With a work
directory, read the state before logging `started` (§ Definitions, Resume).

### 1. Verify branch state and pick the repo
- The checkout: the repo's worktree from `ticket.json` (`repo=` picks the row) — every
  command below runs there; without a work directory, the single repo with changes
  when the current directory holds several (`git status --short` in each; several with
  changes → one run each).
- The base branch: `ticket.json`'s row (`dependsOn.branch` when the PR is to be based
  on an open dependency's branch), else detect (§ Definitions, Base branch). Confirm you are on a
  feature branch, not the base or a release branch.
- The branch's facts, in one call on this machine: `node <lib>/branchfacts.mjs '{ "repo": "<worktree>",
  "base": "<base>", "claudeDir": "<.claude>" }' --fetch` → the branch and whether it is the base, uncommitted files (`dirty`), the
  commits ahead of the base and how far it moved on (`ahead`, `behind`), the diff size, the remote and
  whether the branch is pushed and up to date — and `hosting.command` / `tracker.command` when the project names a file-backed
  platform or tracker: that command stands in for `gh` and the tracker tool in every step below. Do not ask git for these one by one.
- Existing PR on this branch? One exists → **update round** (also with `update=true`);
  none → **creation round**. A stacked ticket (`stackedOn`) is an update round of that
  PR, and the PR title must end up listing every ticket it carries. That PR already
  merged → there is nothing to push: write the full `pr[.repo].json` (`url`/`number`
  from `ticket.json.stackedOn.pr`, `merged` = the sibling's merge sha — `/tp:release`
  matches on it), create or append `report.md` ("merged with <ticket>"), comment on
  the ticket once, log `done "merged with <ticket>"` and stop; `/tp:merge` then records
  the same and passes without a review.

### 2. Extract intent
`instructions/intent-extraction.md`: the problem this round solves and the ticket it is
for — or the fact that there is none. `ticket.md` and `plan.md` (Goal, Approach,
Verification, Implementation summary) are the first sources when they exist.

### 3. Validate uncommitted changes, then commit
`instructions/diff-validation.md` § Before commit; then commit any remainder
(§ Commits). `/tp:implement` normally leaves nothing uncommitted.

### 4. Sync with the base branch
`instructions/sync.md` § Sync with the base branch and § Resolving conflicts.

### 5. Gates and diff validation — concurrently
In one message, awaited in the foreground (§ Definitions, Runtime notes), the two
that apply:
- **Diff validation** (`instructions/diff-validation.md` § Before push). The script first, on
  this machine and for no tokens: `node <lib>/diffcheck.mjs '{ "repo": "<worktree>", "base":
  "<remote>/<base>", "workdir": "<workdir>" }'` — a **creation round** over the whole branch; an
  **update round** with `"since": "<the sha diff-validation.md was validated through>"` in place
  of `base`, the round's delta only. It sorts every file as Expected / Supporting / Unexpected
  from the plan and the file's own name (a lockfile with its manifest, a test beside its
  source, generated output) and names the warning signs that need no reading. `verdict: clean`
  → **no agent**: the table is the script's, written with `node <lib>/diffcheck.mjs '<the same
  input>' --render | node <lib>/state.mjs doc <workdir> diff-validation.md` (`--append` on an
  update round, whose rows join the earlier ones). `verdict: review` → what needs a reading is
  the Unexpected files and the warnings, nothing else, and that reading is the one this agent
  keeps out of its own context (rule 9): an agent of type `tp:diff-validator` (git reads, read
  and search, its one file — the type's hooks hold it to that), rated as this agent, catching
  step; office id `<id>:<stage>:qa:1` (`<stage>` as logged — `create-pr:<name>` on a
  cross-repo ticket), this agent as `parent`, the join/leave commands; given the repo path, the
  intent from step 2, the script's JSON and the diff command, it reads the hunks of the flagged
  files alone, writes `<workdir>/diff-validation.md` through `state.mjs doc` — the script's
  table with its verdict and a line of reasoning on each Unexpected item, ending with the sha
  validated through — and returns the Unexpected items, the path and the contract's two lines.
  An update round of `low` rating (`model.mjs rate` on the delta's `--stat`) is read by **this
  agent itself**, no sub-agent.
- **The gates**: **reuse, hooks, then run** (§ Verification rules) — a result recorded
  for this head and base is the table (the sync moved nothing since `/tp:implement`'s run:
  the same commit, the same result); the gates the repo's hooks own are enforced by the
  commit and by the push in step 7 and need nothing here; whatever is left →
  `node <lib>/gatesrun.mjs '{ "repo": "<repo>", "path": "<worktree>", "base": "<base branch>", "claudeDir": "<.claude>" }'`
  (`reused` or `pass`: the table, recorded for the commit — the record the review reads instead of running the
  gates again). Only `needs-agent` spawns `/tp:verify path=<worktree> base=<base branch>` (its dedicated agent under the
  office id `<id>:<stage>:qa:verify`, this agent as `parent`; `inline=true` when this agent cannot spawn —
  § Definitions, Depth); `error` is the error stop. Nothing is left and no record
  exists → the table is the `HOOK` rows, and the push proves them.
Collect both. A failed gate is fixed by a fresh **fixer** (a writing agent, one job — rule 9;
tools: edit and shell in the worktree, `git`; office id `<id>:<stage>:engineer:2`,
this agent as `parent`, the join/leave commands, § Commits; frontier: the failing
lines) and re-run, within the bound `model.mjs retry '{ rating, kind: "logic",
attempts, claudeDir }'` allows (the gates ran in `/tp:implement` too; this run covers
the synced state); past it, the error form (§ Failures and escalation). A gate that
passes only by changing the approach is the stop of § Stops. Files an autofixing
gate rewrote are committed (§ Commits) before the push — or the gate counts as
failed — and the gates run once more on that commit, so the record covers exactly
what is pushed. Unexpected diff items are yours to judge — one stop only when the files
can't tell you whether the change is intentional.

### 6. Design reference (UI work only)
If the project keeps a design reference (named in its conventions file/docs) and this
PR changes a screen it covers, collect the facts for the describer (step 8): which
screen to compare against, and what is intentionally left unwired with the ticket
that covers it. No prose here. Skip for non-visual work.

### 7. Push
```bash
git push -u <remote> <branch>
```
After a merge-based sync a plain push succeeds; after a rebase use `--force-with-lease`.
The push runs the repo's pre-push hook, so its output goes to a file and its exit code
is read (§ Context management, rule 11): a rejection by the hook is a **gate failure** —
fix it in the change (the fixer of step 5) and push again, never `--no-verify`
(§ Verification rules; § Commits) — and the gate table's `HOOK` rows are now proven by
this push. Any other rejection: find out why before forcing — never force-push over
changes you haven't looked at. Authentication failures: § Remote access failures.

### 8. Create or update the PR
The posting is this agent's; the prose is a sub-agent's only where it needs a reading
this agent does not have (rule 9).
- **Creation round:** the description is the draft `/tp:implement` left —
  `<workdir>/pr-body[.repo].md`, written while the change was in its author's context.
  This agent checks it against the intent (step 2) and `git diff --stat <base>...HEAD`
  — every file the stat names is accounted for, nothing is described that the diff
  does not contain, the format is `instructions/description-format.md`'s, the design
  facts from step 6 are in — corrects it in place, and writes the comments itself
  (`pr-comment.md`, `ticket-comment.md`, a manual-validation list when the change is
  user-facing — `instructions/pr-comments.md`; the ticket link; any attribution
  trailer the session specifies, § Commits). **No draft** (a branch without
  `/tp:implement`) → spawn the **describer** — a writing agent whose one job is prose,
  rated `low` (`medium` when the diff spans several areas); tools: git reads and
  read, write only under `<workdir>` (or `_scratch/` without a ticket); office id
  `<id>:<stage>:engineer:1`, this agent as `parent`, the join/leave commands. Its
  prompt names the intent, `git diff --stat <base>...HEAD` and the hunks by path
  (rule 8 — it reads the diff, not the repo), `plan.md` § Verification when there
  is one (the source of the manual steps), the design facts, the format
  (`instructions/description-format.md` + `examples/`, absolute paths), the comment
  rules, the ticket link and the trailer; it writes `pr-body.md` and the comments and
  returns their paths with the contract's two lines; when this agent cannot spawn
  (§ Definitions, Depth) it writes them itself. Then create the PR against the base
  with the hosting platform's CLI/API, body from `pr-body.md` so formatting survives.
- **Update round:** the push already updated the diff. **This agent writes the
  round's comments itself** — it holds everything they need: the review items the
  round addressed (ids), the fix commits (`git log <previous head>..HEAD`), the gate
  results, `instructions/pr-comments.md` — into `pr-comment.md` and
  `ticket-comment.md`; a fresh agent would only be handed the same facts back. The
  describer is spawned only when the description must be replaced
  (`instructions/description-format.md` § When to edit it — the round changed what
  the PR does, or a finding showed the description overstated something), with the
  previous description and the round's changes; post accordingly.

### 9. Comment on the PR and the ticket
Post the comments (`instructions/pr-comments.md` says which round gets which). The first round that puts this ticket's work on a PR (creation, or the first
update round of a stacked PR) also moves the ticket to the tracker's in-review state,
if it has one. Never done (§ Tickets).

### 10. Record and report
`pr[.repo].json`: `{ repo, url, number, round, reviewRounds: 0, reviews: [], verdict:
null, merged: null }` on a creation round (`round` is the ticket's round — `ticket.json.round` — an update round keeps it and the
rest). With a work directory: create or append to `report.md` the gate results, the
PR URL, this round's summary and the manual steps from `plan.md`, then `state.mjs log
… done "PR <url> round <n>" <PR url>`. Report gate results, the PR URL and the ticket
comment URL if posted. Next: `/tp:merge <id>` (the review loop and the merge); without a
ticket, `/tp:review <pr-url>` by hand — a merge outside the pipeline is the person's
own action.

## Stops
An unclear intent — `"what problem does this PR solve? <candidates> (no default)"`
(`answers=<the problem>`); an ambiguous conflict — `"<file>: keep this branch's <x>
(ours), or the base's <y> (theirs)? (no default)"` (`answers=ours|theirs`); a gate
that passes only by changing the approach — `"<gate> passes only by <the change> —
do it (change), or keep the approach and stop here (keep)? (no default)"`
(`answers=change|keep`); an unexpected diff the files can't explain
(`answers=keep|drop|split`); `hand-off budget spent` (`answers=continue`); `error: …`
— a push, sync or platform call that failed past its fallback, a gate past its retry
bound, a sub-agent that returned nothing twice (`reference/failures-and-stops.md` § Failures and
escalation): `answers=retry` once the person has done what `needs` names. Inside a
fix round `/tp:merge` requested, the stop is this stage's and the answer comes through
`/tp:merge <id> answers=…`, which hands it down here (`/tp:merge`'s Input).
