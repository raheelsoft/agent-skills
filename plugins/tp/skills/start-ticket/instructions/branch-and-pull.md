# Worktree and Branch

Run once per target repo identified in SKILL.md step 6. Nothing here touches the user's
own checkout: the ticket gets its own worktree (`reference/work-directory.md` § Worktrees).

`<repo>` and `<.claude>` stand for absolute paths throughout this file — `<.claude>` is
resolved once (`reference/definitions.md` § Definitions, `<.claude>`). Pass them to git that
way, and record their **expansions** in `ticket.json`'s repo row (`path`, `worktree`),
not the placeholders and not a path relative to the working directory: the row is read
by later stages running elsewhere, so a relative one names a worktree that isn't there.

## 1. Identifying the base branch

Per `reference/definitions.md` § Definitions (conventions file → recent merged PRs → remote
default; ask once if ambiguous); record it in `ticket.json`. If the project promotes the
base to a release or client-facing branch, that branch is never branched from and never
targeted by a feature PR; a bug reported on it may already be fixed on the base
(`git log <remote>/<release>..<remote>/<base>` for the area).

## 2. The worktree — `worktree.mjs add`

`node <lib>/worktree.mjs add '{ repo, id, base, branch, claudeDir, remote?, from?, stack? }'` runs it; this section is what it
does, for the person who reads or changes it.

- **Fresh** (SKILL.md step 7, case 3): `git fetch <remote> <base>`, then `git worktree add -b <branch>
  <.claude>/worktrees/<id>/<repo-name> <remote>/<base>`. The name is per `ticket-intake.md` § Branch slug; a name
  already taken locally or on the remote (two people on related tickets) gets a `-2`, `-3` … suffix.
- **Dependent, own PR** (case 2, `from`): the same, off `<remote>/<open-branch>`; record `dependsOn: { ticket, branch }` in
  `ticket.json`.
- **Stacked on an open sibling PR's branch** (case 1, `from` and `stack`): when a worktree of this repo already holds that
  branch, its path is the ticket's worktree (`reused`) — no new one; otherwise `git worktree add <path> <open-branch>`.
  When git refuses because the branch is checked out in the person's own checkout the result is `blocked` — never work
  in the user's checkout. Record `stackedOn` in `ticket.json`; `/tp:create-pr` treats the next push as an update round
  of that PR.
- **New round** (`round=<n>`, `worktree.mjs rebranch`): **the same worktree**, re-branched from the base that now holds the
  merged work (the install, the generated code and the caches are already there): `git checkout -b <branch>-r<n>
  <remote>/<base>`, dependencies installed again only when a lockfile changed between the old head and the new branch
  point, generated code regenerated. No worktree at that path → `add` with the new branch name. `ticket.json` gets the new
  `branch` and `round`; `worktree` stays.

A refused fetch is an access problem (`reference/procedures.md` § Remote access failures); it, a worktree add or an
install that fails past its documented fallback is the error stop of § Failures and escalation — `stopped "error: …"`,
the error form, `needs:` what the person must fix, `answers=retry` afterwards.

## 3. Make the worktree usable

`worktree.mjs add` installs dependencies with the project's lockfile tool (`tiers.json` `worktree.install` overrides it; `null`
turns it off, or reuse of the main checkout's install where the project's docs allow it — `reference/procedures.md`
§ Toolchain) and regenerates generated code (`codegen.mjs status`, then its `command`, then `mark`: a fresh worktree always
needs it, the output lives outside git). Both write their output to files, read by exit code and last lines (§ Context
management, rule 11). A step that stops on "Cannot resolve environment variable: NAME" (a generator that reads a setting it does not use) is run once more by the script with a placeholder in that variable and the row says so (`install.retry`). Nothing is copied from the user's checkout: untracked config the app needs (env files) is provided
the way the project's docs say, on a disposable copy of any data store.

Local from here — no push, no PR. `/tp:create-pr` does both once there is real work to show. A ticket spanning repos does
this once per repo, each its own worktree and branch.

## 4. Removing a worktree and a never-pushed branch

Used once per ticket, when its run ends (`reference/work-directory.md` § Worktrees): by `/tp:accept`'s `done` — the last
stage — and by `/tp:run-ticket`'s close-out of a ticket that ends before it (closed by triage, parked as blocked); never by
a stage in between, and never by a new round, which re-branches instead (§ 2). `node <lib>/worktree.mjs remove '{ "repo",
"id", "branch", "base", "claudeDir" }'` (add `"dry": true` to see the plan) removes the worktree, then the branch only when it
was never pushed or is merged, then the ticket's empty `worktrees/<id>/` folder; a worktree another ticket's `ticket.json`
still names (a stacked sibling) stays, and the result says so. The ticket's `<.claude>/worktrees/_out/<id>/` folder goes with
it. A ticket picked up before the worktrees moved out of the work directory has its worktree at
`<.claude>/work/<id>/wt/<repo-name>` — `ticket.json` records the path, and that is the one to remove by hand.
