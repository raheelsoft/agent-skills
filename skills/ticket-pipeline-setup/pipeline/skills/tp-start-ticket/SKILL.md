---
name: tp-start-ticket
description: Pick up a tracker ticket: blocked check, assign, move to in progress, rate and estimate, create the one worktree and branch per repo, write the ticket's work directory.
user_invocable: true
---

Take a ticket from "in the backlog" to "worktree and branch created, ready to
implement" — or stop cleanly and say why if it isn't pickable right now. The branch
stays local; `/tp-create-pr` pushes it and opens the pull request (PR below also means
merge request) once there is real work to describe. Stage 1 of `skills/README.md`;
`/tp-triage` decides what happens next.

Invoking this skill with a ticket is itself the authorization to assign it, change its
status and branch for it. Project-specific rules (branch naming, title conventions,
whether dependent tickets are stacked on one PR) come from the repo's conventions file
and the person's standing instructions (`skills/README.md` § Definitions, Conventions
file). The blockers'
states are this agent's own tracker reads — every blocker in one message
(§ Definitions, Tracker; § Context management, rule 4), plus the hosting CLI's `pr`
read for the in-review-but-merged case — one row per blocker (id, state,
merged-or-not); a `low` read-only lookup agent (`<id>:start-ticket:qa:<n>`, this
agent as `parent`, the join/leave commands, the tracker's read tools by name) only
when a blocker's description must be read to classify it, several blockers per
agent, awaited in the foreground (§ Definitions, Runtime notes). No tickets are
created here (§ Tickets).

## Input

- `<id>` — a tracker URL, an identifier or a bare number, normalised to the tracker's
  identifier form; or `next` (step 1) — with `count=<n>`, up to n tickets that are
  unblocked and independent of each other; `pick=true` returns the ids and takes
  nothing (`/tp-run-ticket next count=<n>` runs one pickup per id, in parallel).
- `round=<n>` — a new round after a failed acceptance (step 1).
- `checked=<iso>` — the caller already checked this ticket's blockers at that time
  (`/tp-plan-day` through `/tp-run-ticket`): step 3 reuses it while it is fresh
  (`instructions/blocked-check.md` § Freshness).
- `answers=<text>` — the answer to this skill's last stop (§ Stops).
- `force=true` — re-run a done pickup (§ Definitions, Resume).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `medium` (bounded pickup steps).

## Steps

### 1. Identify the ticket
Normalise the id. `next` → `instructions/ticket-intake.md` § Picking the next ticket:
one candidate → take it; a shortlist → return it as the report (no work directory yet;
`answers=<id>` on the re-run takes that one). `count=<n>` → the first n picks in tier
order that are unblocked and independent of each other (§ Picking); `pick=true` →
return the ids as the report — `picks: <ids>` — and stop before step 2. `round=<n>` → the same ticket again:
the tracker steps (3–5) are already done, the branch is `<branch>-r<n>`, and every
later stage re-runs; the work directory and the `started` line are still written.

### 2. Snapshot the ticket
Fetch the ticket with its relations (blocked-by / blocks, sub-issues, linked PRs) with
the tracker (`skills/README.md` § Definitions, Tracker) and keep the result verbatim — every later step reads it
(`instructions/ticket-intake.md` § Reading the snapshot). Cancelled, or closed as a
duplicate → `stopped "cancelled|duplicate of <id> — nothing to answer; pick another
ticket"` (reported only; touch nothing).

### 3. Blocked check
`instructions/blocked-check.md` on the snapshot, before writing anything, so a blocked
ticket is never assigned, moved or branched — with `checked=` inside the file's
freshness bound, the blockers' states come from that verdict instead of a second round
of fetches (§ Freshness), and the report says so. **Blocked** → `stopped "blocked by <ids>
(<their states>) — nothing to answer; re-run when they are done"` (reported only).
**Soft-blocked** → `stopped "soft-blocked: <ids> merged but not closed — continue, or
wait? Default: wait"` (no work directory yet); continue only with `answers=continue`.
**Not blocked** → continue.

### 4. Take it
Create `<.claude>/work/<id>/` (keep an existing one) and read the state, then log
`state.mjs log <workdir> start-ticket started` (§ Definitions, Resume). Assign the
ticket to yourself — most trackers have a single assignee, so this overwrites. Already
you → no-op. Assigned to someone else → `stopped "assigned to <who> — take it over
(takeover), or leave it? Default: leave"`; take it over only with `answers=takeover`.

### 5. Move it to the tracker's in-progress state
Already there → no-op. Was done → `stopped "already done — reopen it (reopen), or
leave it? Default: leave"`; reopen only with `answers=reopen`.

### 6. Determine the target repo(s)
`instructions/ticket-intake.md` § Repo target; the candidates are the git checkouts at
or under the working directory. The ticket doesn't say → `stopped "which repo(s):
<a>, <b>, or both? (no default)"`; `answers=` names them.

### 7. Choose the branch source
Per target repo, one of three cases (`instructions/branch-and-pull.md` has the
commands for each):
1. **Stacked** — the ticket depends on, or closely follows, one whose branch/PR is
   still open and the project stacks dependent work on one branch and one PR: the
   worktree checks out that branch and `ticket.json.stackedOn` records it (confirm the
   PR is still open; merged → case 3).
2. **Dependent, own PR** — same dependency, but the project wants one PR per ticket:
   a new branch from the open branch, `dependsOn` recorded so `/tp-create-pr` sets the
   PR's base from it.
3. **Fresh** — a new branch from the base branch (`instructions/branch-and-pull.md`
   § 1 — also for a ticket reported against a release or client-facing branch).
The person's own checkout is never involved.

### 8. Worktree and branch
`instructions/branch-and-pull.md`, once per target repo: fetch, create the worktree at
`<.claude>/work/<id>/wt/<repo-name>` on the new branch (or on the open stacked
branch), install dependencies, regenerate generated code — the one checkout the
ticket keeps for its whole run (`skills/README.md` § Worktrees); a new round
re-branches it. Local only: no push, no PR.

### 9. Write the work directory
`skills/README.md` § Work directory: `ticket.md` (title, link, description and
acceptance criteria verbatim, brief pointers, the repo table) and `ticket.json` —
`acceptanceCriteria` verbatim as an array or, when the ticket has none, derived from
its current-vs-expected description with `derived: true` (say so; `/tp-accept` proves
exactly these); `complexity`, the ticket's rating from the ticket alone
(§ Models and budget: description and brief, repos named, epic/spike labels, criteria
present or derived; uncertain → the higher level; `/tp-triage` refines it); `estimate`
— the person's hours (§ Models and budget, Estimates — the signals and the tracker
conversion are defined there): the tracker's own estimate when the ticket carries one
(`source: "tracker"`), else `node <.claude>/skills/_lib/model.mjs estimate '{ rating,
repos, flags, unclear, novelty, claudeDir }'` from the ticket alone (`source:
"pipeline"`; `focusedHours`, `days`, `points`, `basis`), written to the tracker's
estimate field and named in the pickup comment; `round` (1,
or the `round=` given); `stackedOn` or `dependsOn`; one repo row each — its `path` (the
repo's checkout) and `worktree` written as **absolute** paths, the expansion of
`<.claude>`, never the `<repo-name>` / `.claude/work/<id>/wt/<repo-name>` forms that
read from the working directory this agent happens to sit in (`skills/README.md` § Definitions,
`<.claude>`; § Work directory): every later stage reads the row from a different
directory, and a relative one names a worktree that isn't there. Then
`state.mjs log <workdir> start-ticket done
"picked up; <branch> in <repo-name>" <ticket link>` and comment on the ticket that it
is picked up (branch). The next stage is `/tp-triage <id>` — no coding here.

### 10. Report
The blocked verdict; the ticket's assignee and status; per repo, the worktree path and
branch — or the open PR the ticket continues; the work directory path; the rating; the
next stage.

## Stops
Before the work directory exists (only reported): a `next` shortlist (`answers=<id>`),
a cancelled or duplicate ticket and a blocked ticket (nothing to answer), a
soft-blocked ticket (`answers=continue`). Logged on `start-ticket`: assigned to
someone else (`answers=takeover`), already done (`answers=reopen`), the ticket names
no repo (`answers=<repos>`), a branch checked out in the person's own copy
(`answers=retry` once moved — `branch-and-pull.md`). `error: …` — a fetch, worktree
or install that failed past its fallback (`skills/README.md` § Failures and
escalation): `answers=retry` once the person has done what `needs` names.
