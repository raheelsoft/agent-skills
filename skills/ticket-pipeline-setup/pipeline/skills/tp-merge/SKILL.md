---
name: tp-merge
description: Take an open PR through the incremental review loop (an unbiased /tp-review, fix rounds via /tp-create-pr) to a merge into the base branch when the review passes and the person's instruction allows.
user_invocable: true
---

From "a described, gated PR is up" to "merged into the base branch, merge recorded"
— or a stop that says exactly what a person must decide. The worktree stays: the
release and the acceptance still use it (`skills/README.md` § Worktrees). The
review runs in its own agent that knows only the PR; the loop's length comes from the
change's complexity, never from a constant; a merge happens only when the review
passes and merging is allowed. Rules: `skills/README.md` § Review scope and rounds;
mechanics: `instructions/review-loop.md`. Conventions, resume rule, output contract:
§ Definitions (Resume, Output contract, Asking the user).

Invoking this skill is itself the authorization to request reviews, push fix rounds
(through `/tp-create-pr`), ticket the open items when the person answers `merge`, and
merge into the base branch when § Review scope and rounds allows — never into a
release or client-facing branch.

## Input

- `<id>` — the ticket; `pr[.repo].json` exists with a `url` (the state's `next` is
  `merge` / `merge:<name>`). No PR yet (`next` earlier, or no work directory) →
  `/tp-create-pr` and whatever precedes it run first (`skills/README.md` § Definitions,
  Entry points).
- `repo=<name>` — cross-repo tickets: narrows this run to one repo (stage
  `merge:<name>`). **Left out, this one agent covers every repo whose stage is not
  done**, in `ticket.json` order — dependent PRs merge in that order, and each PR gets
  its own review agent, which is where the independence lies, not in the lead
  (`skills/README.md` § Context management, rule 9). A stop or an error in one repo
  ends the run there.
- `merge=auto|ask` — precedence: this argument, else the conventions file or the
  person's standing instruction, else `ask` (§ Review scope and rounds, Merging).
- `answers=<text>` — the answer to this stage's last stop (§ Stops; § Definitions,
  Resume). When the state's stopped stage is `create-pr` (a fix round's stop), the
  answer is handed down — `/tp-create-pr <id> update=true [repo=<name>] answers=<text>`
  — and the loop continues from that round (§ Failures and escalation, 3).
- `continue=true` — start from `checkpoint.merge[.<repo>].md`.
- `force=true` — re-run a done merge stage (§ Definitions, Resume).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: the ticket's current rating (`state.mjs state` → `complexity`) raised by
  `model.mjs rate` on `git diff --stat <base>...HEAD` — judgment about merging.

## Steps

**The steps below are one repo's.** Without `repo=`, run them start to finish for each
repo whose `merge:<repo>` stage is not done, in `ticket.json` order, logging that
repo's `started`/`done` around its own pass and giving its PR its own review agent — the next repo begins only
when the one before it is done. One repo's stop or error ends the run at that repo
(the later ones stay pending, and the state's `next` names the one to resume at).
A single-repo ticket is the same thing with one pass.

Each step is a checkpoint boundary (rule 7): `checkpoint.merge[.<repo>].md` holds the
passes so far (from `pr[.repo].json.reviews`), the verdict, what remains.

### 1. Read the state, log, take stock
`state.mjs state <workdir>` then `state.mjs log <workdir> <stage> started`
(§ Definitions, Resume). Read `pr[.repo].json`; the PR's current state from the
hosting platform (open, mergeable, required checks); the trailers of the review
comments already on it — the `Reviewed: …` lines alone, filtered out of the comment
bodies, never the reviews whole — which rebuild `reviews` when the file is behind
(also how a re-entry after a fix round's stop finds its place). A PR already merged (a stacked sibling
merged it, or `/tp-create-pr` already recorded it) → make sure `merged` holds the sha,
skip to step 5 without a review.

### 2. Hand-off
`instructions/review-loop.md` § Hand-off: `/tp-review <pr-url> <ticket link> <neutral
what> tier=<rating> checkout=<the ticket's worktree> [mode=<mode>]` — the reviewer
gets only that (its dedicated agent under the office id `review:<PR
number>:reviewer:<round>`, this agent as `parent`); the checkout is a path at the
PR's head it verifies itself, so the review's gates are the recorded ones and no
worktree is created for them.
A first invocation with no review yet → `mode=full`; otherwise the mode `model.mjs
rounds` gives.

### 3. The loop
`instructions/review-loop.md` § The loop — the mechanics live there. In short: after
every pass, ask `rounds` (with the same rating the reviewer got as `tier=`) and act —
`review`: a fresh **fixer** agent applies this pass's items, then `/tp-create-pr <id>
update=true` (`repo=<name>` on a cross-repo ticket) and a new hand-off; `merge`: step
4 (the fix round's `/tp-create-pr` runs under `<id>:create-pr:lead`, this agent as
`parent` — the same desk revived each round); `stop`: `stopped "review loop: <why>"`
and return. A stop inside that `/tp-create-pr`
round is `create-pr`'s (its § Stops): return it as the report without logging a
`merge` stop; its answer comes back through this skill's `answers=` (Input).

### 4. Merge
`instructions/review-loop.md` § Merge: the conditions, the strategy the repo uses, the
base branch only. `merge=ask` and no answer yet → `stopped "review <verdict> —
merge (merge), or send fixes (fix <what>)? (no default)"`. After the merge:
`state.mjs log … note "merged" <sha>`, `merged: <sha>` in `pr[.repo].json`.

### 5. After the merge
The worktree stays — `/tp-release` reads and `/tp-accept` walks in it, and the run's end
removes it (§ Worktrees); delete the remote branch if the hosting platform did not
(the local branch in the worktree stays until then); comment the merge on the ticket
(the one merge comment — none when `/tp-create-pr` already posted "merged with
<ticket>"); name in the report what the merge triggers (a CI/CD run, a publish,
nothing) — watching it is `/tp-release`'s job.

### 6. Record and report
Append to `report.md`: the verdict per pass, the open items ticketed if any, the merge
commit and what it triggers. `state.mjs log <workdir> <stage> done "merged <sha>" <PR
url>`. Report the same in a few lines. Next: `/tp-release <id>`.

## Stops
A review requested from a designated reviewer (`answers=reviewed` once the verdict is
on the PR); this agent cannot spawn a review and none is designated
(`answers=merge|fix`, the person having had it reviewed); `review loop: <why>`
(`answers=merge|fix`); `review <verdict> — merge?` (`answers=merge`, or `answers=fix
<what>` for one more `/tp-create-pr update=true` round, then the question again);
`stopped "checks failing on <PR>: <which> — re-run them (retry), send fixes (fix
<what>), or merge anyway (merge)? Default: retry"` on a PR the review passed (a base
that moved is not a stop but a `/tp-create-pr update=true` sync round); `hand-off
budget spent` (`answers=continue`); `error: …` — a platform API or merge failure past
its fallback, a reviewer or fixer that returned nothing twice (`skills/README.md`
§ Failures and escalation): `answers=retry` once the person has done what `needs`
names.
