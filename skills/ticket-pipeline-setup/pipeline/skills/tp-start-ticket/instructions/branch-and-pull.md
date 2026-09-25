# Worktree and Branch

Run once per target repo identified in SKILL.md step 6. Nothing here touches the user's
own checkout: the ticket gets its own worktree (`skills/README.md` § Worktrees).

## 1. Identifying the base branch

Per `skills/README.md` § Definitions (conventions file → recent merged PRs → remote
default; ask once if ambiguous); record it in `ticket.json`. If the project promotes the
base to a release or client-facing branch, that branch is never branched from and never
targeted by a feature PR; a bug reported on it may already be fixed on the base
(`git log <remote>/<release>..<remote>/<base>` for the area).

## 2. Fetch and create the worktree

```bash
git -C <repo> fetch <remote> <base>
```

**Fresh — a new branch from the base** (SKILL.md step 7, case 3):
```bash
git -C <repo> worktree add -b <branch-name> <.claude>/work/<id>/wt/<repo-name> <remote>/<base>
```
Name per `ticket-intake.md` § Branch slug; check it doesn't already exist locally or on
the remote (`git branch --list`, `git ls-remote --heads <remote> <name>`) — two people on
related tickets can collide on a near-identical slug.

**Dependent, own PR** (case 2): a new branch from the open dependency's branch —
```bash
git -C <repo> fetch <remote> <open-branch>
git -C <repo> worktree add -b <branch-name> <.claude>/work/<id>/wt/<repo-name> <remote>/<open-branch>
```
— and `dependsOn: { ticket, branch }` in `ticket.json`.

**Stacked on an open sibling PR's branch** (case 1): if the earlier ticket's worktree
still holds that branch (`git -C <repo> worktree list`), record that path as this
ticket's worktree — no new worktree. Otherwise:
```bash
git -C <repo> fetch <remote> <open-branch>
git -C <repo> worktree add <.claude>/work/<id>/wt/<repo-name> <open-branch>   # tracks <remote>/<open-branch>
```
If git refuses because the branch is checked out in the person's own checkout, log
`stopped "<branch> is checked out in <path> — move that copy off it, then
answers=retry"` and return — never work in the user's checkout; the re-run retries the
worktree add. Record `stackedOn` in `ticket.json`; `/tp-create-pr` treats the next push
as an update round of that PR.

**New round** (SKILL.md step 1, `round=<n>`): **the same worktree**, re-branched
from the base, which now holds the merged work (`skills/README.md` § Worktrees — the
install, the generated code and the caches are already there) —
```bash
git -C <.claude>/work/<id>/wt/<repo-name> fetch <remote> <base>
git -C <.claude>/work/<id>/wt/<repo-name> checkout -q -b <branch>-r<n> <remote>/<base>
```
— from wherever the last stage left it (detached at the merge commit after
`/tp-accept`); dependencies are re-installed only when a lockfile changed between the
old head and the new branch point (`git diff --name-only <old head> <remote>/<base>
-- <lockfiles>`), generated code regenerated (§ 3). No worktree at that path (a run
before this rule, a cleanup by hand) → the fresh form above with the new branch name.
`ticket.json` gets the new `branch` and `round`; `worktree` stays.

A refused fetch is an access problem (`skills/README.md` § Remote access failures);
it, a worktree add or an install that fails past its documented fallback is the error
stop of § Failures and escalation — `stopped "error: …"`, the error form, `needs:`
what the person must fix, `answers=retry` afterwards.

## 3. Make the worktree usable

- Install dependencies in the worktree with the project's lockfile tool, or reuse the
  main checkout's install where the project's docs allow it (`skills/README.md`
  § Toolchain); log which as a `note`. The install's output goes to a file, never into
  this context (`<tool> install > <.claude>/work/<id>/install.<repo-name>.log 2>&1`;
  read its exit code and `tail -5`, the first error lines on failure — § Context
  management, rule 11); the same for the code generation below.
- Regenerate generated code — `node <.claude>/skills/_lib/codegen.mjs status '{ repo:
  "<this worktree>", claudeDir }'`, and when it reports `stale`, run its `command` here
  (output to a file, rule 11) and `codegen.mjs mark` (`skills/README.md` § Toolchain).
  A fresh worktree always needs this: the generated output lives outside git.
- Copy nothing from the user's checkout: untracked config the app needs (env files) is
  provided the way the project's docs say, on a disposable copy of any data store.

Local from here — no push, no PR. `/tp-create-pr` does both once there is real work to
show. A ticket spanning repos does this once per repo, each its own worktree and branch.

## 4. Removing a worktree and a never-pushed branch

Used once per ticket, when its run ends (`skills/README.md` § Worktrees): by
`/tp-accept`'s `done` — the last stage — and by `/tp-run-ticket`'s close-out of a ticket
that ends before it (closed by triage, parked as blocked); never by a stage in
between, and never by a new round, which re-branches the worktree instead (§ 2):
```bash
git -C <repo> worktree remove <.claude>/work/<id>/wt/<repo-name>   # --force when it holds untracked files
git -C <repo> branch -D <branch>                                   # only a branch that was never pushed, or is merged
```
A worktree another ticket's `ticket.json` still names (a stacked sibling) stays.
