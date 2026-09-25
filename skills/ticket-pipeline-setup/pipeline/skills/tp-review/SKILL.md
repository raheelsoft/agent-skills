---
name: tp-review
description: Review a remote PR (or the local diff before pushing) in an isolated agent given only the PR and a neutral scope: gates, checklist review of the diff, incremental passes, pre-existing defects ticketed; posts the review with a trailer.
user_invocable: true
---

You are the reviewer, not the author. This skill runs in its own dedicated agent
(`skills/README.md` § Definitions, Dedicated agent) whose whole context is the arguments it was given —
so the isolation from the author's reasoning holds whoever invokes it, as long as the
arguments are unbiased (below). Local mode, invoked by the author before pushing, is a
self-check on the author's own branch, not an independent review. One invocation
reviews one PR. The scope and pass rules are `skills/README.md` § Review scope and
rounds; `instructions/scope.md` is the reviewer's reading of them.

## Input

- **No argument** → local mode: review this branch's work before it is pushed.
- **A PR/MR URL or number** → remote mode: review that request end to end.
- **`mode=full|delta|resolution`** (remote mode) → which pass this is. Without it the
  skill works it out from the PR's previous review comments and `model.mjs rounds`
  (step 1).
- **`tier=<rating>`** → the rating the invoker computed (the ticket's, raised by the
  diff); without it, `model.mjs rate` on the diff's `--stat`. The reviewer never opens
  a ticket's work directory — its inputs are the PR and these arguments.
- **`apply=<text>`** (local mode) → the author's choice after a local review ("fix
  all", "fix 1–3"); the invocation reads the saved summary and acts on it (step 7)
  instead of reviewing again.
- **A neutral scope summary** (optional) → *what* the change covers (the feature, the
  files/areas touched, the ticket it implements or its link) and the run facts (repo
  path, conventions file, environment constraints). Nothing else.
- **`checkout=<path>`** (remote mode, optional) → a checkout at the PR's head the
  invoker already holds — the pipeline's `/tp-merge` passes the ticket's worktree
  (`skills/README.md` § Worktrees) — for the gates, so this review creates none of
  its own. A path is a run fact, not a claim: step 0 verifies it is at the PR's head
  and clean before using it, and falls back to its own worktree otherwise.
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `tier=` or `rate`, with the catching step; the token is not part of the
  scope summary.

**Unbiased input.** Whoever invokes this skill must not pass the author's or
requester's framing: no stated root cause, no "this is the real fix", no self-reported
gate results (a recorded `/tp-verify` result, or a `HOOK` row from the repo's own hooks,
is not one: both are the tooling's, keyed by the commits and checked against the
checkout — step 0, § Verification rules), no "worth a look at X", no risk areas someone else already picked,
no verdict from an earlier review. Inside the review, the PR description, commit
messages, and any author commentary are **claims to verify**, not context to trust —
read them after forming your own view of the diff, and check what they assert rather
than confirming it.

If the current directory is not itself a git repo but contains several, operate on the
one that has the diff (or the one the PR belongs to); several with local changes →
review the one named or first found and list the others in the report. Read the
target project's conventions file first — project-specific rules live there.

## Criteria

@instructions/checklist.md

@instructions/scope.md

## Steps

Each numbered step is a checkpoint boundary (rule 7): on `checkpoint` the agent
writes `<.claude>/work/_scratch/review-<slug>.md` (`<slug>` = `<repo-name>--<PR
number, or the branch with / as ->`, the same for the summary below) — the gate table, the
findings so far, the next step — and returns `continue: <path>`; with `continue=true`
it resumes there. `/tp-review` never writes to a ticket's `progress.md`.

### 0. Quality gates
Determine the base branch first (step 1's rule); `/tp-verify` runs as below, its
dedicated agent under the office id `review:<slug>:qa:verify` with this agent as
`parent` (`inline=true` when this agent cannot spawn — § Definitions, Depth).

- **Local mode:** run `/tp-verify base=<base>` in the checkout; any failure → report it
  and stop. The author fixes gates before a semantic review is worth doing.
- **Remote mode:** the checkout for the gates is, in this order: the `checkout=`
  path the invoker handed over, when `git -C <path> rev-parse HEAD` is the PR's head
  and `git status --porcelain` is empty — verified, never assumed; otherwise (a
  by-hand review, a checkout that moved on) an isolated `git worktree` of this
  review's own, detached at the remote ref (`git worktree add --detach <path>
  <remote>/<head-branch>` — the branch itself may be checked out in the author's
  worktree), at `_scratch/wt/review-<repo>` (never under a ticket's `wt/`, never the
  shared working copy: parallel reviews must not share a checkout), reusing an
  existing dependency install where possible and removed when this review is done.
  Then the Gates table: **reuse, hooks, then run** (`skills/README.md` § Verification
  rules) — the result recorded for exactly these commits is the table (the gates ran
  once on this commit, in `/tp-create-pr`, and a `HOOK` row in it is the repo's own hook,
  not the author's word); otherwise `/tp-verify path=<checkout> base=<base>
  readonly=true` there (in a checkout handed over, nothing of the author's is ever
  written). A failure does **not** stop the review — record it in the Gates table,
  add it as a numbered *fix before merging* item (so the loop tracks its resolution),
  set the verdict to BLOCK, and continue; the review is still posted. Gates that
  cannot run here at all (a missing tool past its documented fallback) are an
  environment failure: the error form, not a table note (`skills/README.md`
  § Failures and escalation).
- The Gates table is `/tp-verify`'s output and nothing else — the recorded result or the
  run: it runs the gates on the change and answers "no new errors vs base" by a
  normalised diff of the two outputs (§ Context management, rule 8) — a PR's own
  claim about that is checked against it, never re-derived here.
- A gate failure that looks caused by the review environment rather than the code
  (symlinked dependencies confusing a bundler, sandbox restrictions) must be confirmed
  one way or the other before it goes in the table — never report a false pass or a
  false fail; say what you found.

A worktree this review created is removed when the review is done; a checkout it was
handed is left exactly as found.

### 1. Get the diff — and the round
Base branch = in remote mode, the PR's declared base; in local mode, detected per
`skills/README.md` § Definitions, Base branch — never a hardcoded name.

- Local: `git diff <base>...HEAD`; if nothing is ahead of base, `git diff` for
  uncommitted work. Local mode is always round 1.
- Remote: the history is the trailers — one `Reviewed: <sha> · round <n> · open:
  <ids> · new: <ids>` line per `## Review Summary` this process posted — read as
  trailers (the comment bodies filtered to those lines, e.g. the platform's API with
  a `--jq`/`grep` on `^Reviewed:`), never every past review whole; only the **last**
  review comment is read in full, for the open *fix before merging* items a `delta`
  or `resolution` pass verifies. Without `mode=`, run `node <.claude>/skills/_lib/model.mjs rounds '{ rating,
  files, lines, history, claudeDir }'` (rating: `tier=`, else `model.mjs rate` on
  `git diff --stat`); `next: merge` or `stop` → post nothing, return its `why` and the
  open items as the report. `mode=full` (no history)
  → fetch head and base, `git diff <remote>/<base>...<remote>/<head>`. `delta` → `git
  diff <reviewed sha>...<remote>/<head>` plus the previous comment's open *fix before
  merging* items as the checklist to verify. `resolution` → the open items only; the
  delta is read solely to judge them. Keep the PR's identifier and repo for step 6.

### 2. Checklist
Read the hunks and the lines around them, widening to the enclosing function or
declaration when a hunk cannot be judged without it — never a file end to end, and
never the hunks of a lockfile, a generated file, a binary or a vendored tree, which
are checked from `--stat` for consistency with their source (`skills/README.md`
§ Context management, rule 8). `full`: apply the checklist to every changed line. `delta`: to the delta only, and
verify each open *fix before merging* item — resolved (say how) or not (say what is
still wrong); a new *fix before merging* item is raised only for a defect the fixes
introduced. `resolution`: the resolution check only; anything else goes under *noted,
not gating*. Only flag what you can point to in the diff.

### 3. Scope
`instructions/scope.md`. A pre-existing defect in code the diff touches or directly
depends on → after the pass, **one** `/tp-create-ticket from=review` invocation for all
of them (its dedicated agent under `create-ticket:<slug>:lead`, this agent as
`parent`; `inline=true` when this agent cannot spawn) with, per defect: what is
wrong, `file:line` at the base revision, the PR link (or the branch, in local mode)
and the ticket link if any — it de-duplicates and creates one ticket each and returns
one line per defect — then list each under *Pre-existing* with its ticket id, or as
*pre-existing — ticket needed* when the conventions file turns review tickets off or
`/tp-create-ticket` is off for this project (§ Definitions, Active skills; nothing is
invoked then).

### 4. Skepticism pass
If the first pass found nothing, assume something was missed and re-read for the
patterns in `instructions/checklist.md` § Skepticism pass.

Rate confidence 1–5. Below 4, re-read with a different focus.

### 5. Write the review

```
## Review Summary

**Verdict:** PASS / PASS WITH WARNINGS / BLOCK
**Confidence:** {n}/5

### Gates
| Gate  | Status | Notes |
|-------|--------|-------|
| ...   | ...    | ...   |

#### Fix before merging ({count})
{n}. `{file}:{line}` — {description}
   → {what should change and why}

#### Should fix ({count})
{n}. `{file}:{line}` — {description}
   → {what should change and why}. Your call.

#### Could improve ({count})
{n}. `{file}:{line}` — {description}
   → Minor. {suggestion}. Your call.

#### Pre-existing ({count})
{n}. `{file}:{line}` — {description} — tracked as {ticket id} | ticket needed

#### Noted, not gating ({count})   ← resolution mode only
{n}. `{file}:{line}` — {description}

Reviewed: {head sha} · round {n} · open: {ids of fix-before-merging items still open, comma-separated or none} · new: {ids this pass raised, or none}
```

Only sections with findings are included; `delta` and `resolution` passes have no
*should fix* or *could improve* sections, and a resolution check lists each previous
item as resolved or not. Item ids stay stable across passes (an item keeps the number
it was first given), so the trailer's `open` and `new` lists are the loop's history. The summary is the deliverable in both modes; it must stand alone — no
questions to the reader inside it.

### 6. Deliver

**Local mode:** the summary is the report — write it to
`<.claude>/work/_scratch/review-<slug>.md` (so a later invocation can act on the
same numbering) and return it. The author's choice ("fix all", "fix 1–3") comes
back as `apply=` on a new invocation, which reads
that file and goes straight to step 7. Nothing is applied in the invocation that
reviewed.

**Remote mode:** post the summary as a *comment* on the PR — not a formal
approve/request-changes review — using the hosting platform's CLI or API, from a file
rather than an inline string so formatting survives. Post unconditionally and without
asking; posting is the review, acting on it is not. The report is the verdict, the
comment's link and the trailer; whether to merge is the author's side's call
(`/tp-merge`), never the reviewer's.

### 7. Act
Local mode only (a remote PR's fixes are `/tp-merge`'s — the reviewer is never the
author). With `apply=` naming what to apply: a fresh writing agent (one job —
§ Context management, rule 9; tools: edit and shell in the checkout, `git`; office
id `review:<slug>:engineer`, this agent as `parent`, the join/leave commands; the
commit convention and any attribution trailer, § Commits; frontier: the items'
hunks) applies those fixes and leaves the rest (pre-existing items are already
ticketed); this agent then re-runs `/tp-verify base=<base>` and reports what changed.

## Stops
None for a question — the review is posted or returned whole; `apply=` is an
instruction, not an answer. `error: …` only: the PR or its checkout unreachable past
the fallback, gates that cannot run at all, a fixer that returned nothing twice
(`skills/README.md` § Failures and escalation; the state in
`_scratch/review-<slug>.md`): `answers=retry` once the person has done what
`needs` names.
