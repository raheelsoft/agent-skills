# Blocked Check

The one definition of "blocked" in the pipeline: its signal, how a blocker's state is
resolved, the verdict, and the re-check of a parked ticket. `/tp-start-ticket` owns the
verdict for a pickup; `/tp-plan-day` uses this file to filter candidates, `/tp-inbox` and
`/tp-plan-day`'s advance to re-check what is parked. **Nobody checks twice** (§ Freshness).

## Signal

Blocking is a relation on the ticket, not a label. Read the snapshot's blocked-by
relations (SKILL.md step 2) as the primary signal — before this run's own edits.
Trackers without such relations: treat dependencies stated in the description or in
linked issues as the entries below, and say in the report that the check was prose-based.

Empty → nothing formally blocks this ticket. Non-empty → check each entry.

## Resolving each blocker

A blocked-by relation does not clear itself when the blocker ships; trackers keep the
relation whatever the blocker's state. So fetch every blocker's current state — **all
of them in one parallel batch** (several fetches in the same message, or one subagent
per blocker when its description needs reading), never one at a time — and classify:

- Blocker done or cancelled → resolved; not blocking.
- Blocker "in review" → check whether its work is already merged into the base branch
  (`ticket-intake.md` § Status vs reality). Merged → **soft-blocking** only: the
  deliverable exists and just the status is stale. Not merged → still blocking.
- Blocker in any other state (not started, in progress) → still blocking.

## Secondary context (for the report, not the verdict)

Scan the description for a dependency stated in prose but never formalised as a
relation ("depends on ABC-142", "blocked on the export work"). Mention it as a soft
dependency worth confirming with the user; it does not override the verdict on its own.

## Verdict

- **Any unresolved, genuinely blocking entry → BLOCKED.** Stop in SKILL.md step 3 —
  don't assign, don't change status, don't branch. Tell the user which ticket(s)
  block it, their current state, and that nothing was changed in the tracker or git.
- **Every unresolved entry is only soft-blocking → SOFT-BLOCKED.** Change nothing yet;
  return the question as the report and continue only on a re-run with `answers=continue`.
- **All entries resolved (or none) → NOT BLOCKED.** Continue. Still name any
  resolved-but-present blockers and any prose dependency in the final report.

## Freshness — the check is made once, by whoever gets there first

Fetching every blocker's state is the expensive half of this file, and two skills often
want it minutes apart (a day plan filters its candidates, then the pickup it starts
would ask again). So a verdict carries its time, and a fresh one is reused:

- **A caller that has already checked says so**: `checked=<iso>` on `/tp-start-ticket`
  (forwarded by `/tp-run-ticket`). Within `tiers.json.checks.blockedFreshMinutes`
  (60) `/tp-start-ticket` skips the blockers' fetch — it still reads the ticket
  snapshot's own relations, which it fetches anyway (SKILL.md step 2), so a blocker
  added since is still seen — and logs the verdict's source (`blocked check: from the
  day plan at <time>`). Older than that, or not given → the full check.
- **A recorded row is a verdict too**: `ticket.json.blockedBy[].checkedAt` (written by
  `state.mjs blockers`) and a day plan's `skipped[].blockedBy[].checkedAt` (written by
  `day.mjs advance recheck`). A re-check below skips a blocker whose row is fresher
  than the same bound, so `/tp-inbox` and `/tp-plan-day`'s advance in the same minute cost
  one lookup, not two — whichever ran first did it.
- A verdict is never reused **across a stop the person answered** (`answers=continue`
  on a soft block) or after `force=true`: those are decisions, not observations.

## Re-check

A parked ticket (a stop of `kind: blocked` — triage's `blocked` decision, or a
pre-pickup block the day planner skipped) is re-checked, never left to a person's
memory: `/tp-inbox` and `/tp-plan-day`'s advance run this once per invocation, over **every**
parked ticket and skipped-blocked candidate at once.

1. **Gather** the blockers: `state.mjs inbox <.claude>/work` lists the parked tickets
   with their `blockedBy` (as last recorded — the ids named in an older stop's text when
   nothing was recorded yet); the day plan's `skipped` entries carry theirs
   (`day.mjs status`). Drop every blocker whose recorded `checkedAt` is fresh
   (§ Freshness) — its state stands. Nothing left to gather → nothing to run, and the
   report says the last check's time.
2. **One batched lookup** — the caller's own tracker reads, every blocker in one
   message (README § Definitions, Tracker; § Context management, rule 4), plus the
   hosting platform's CLI reads for the "in review but merged" case — fetches each
   blocker's current state and classifies it exactly as § Resolving each blocker
   above: `resolved` (done, cancelled — or merged into the base branch), `soft` (in
   review and merged, status stale), neither (still blocking): one row per blocker,
   `{ id, state, resolved, soft }`. A `low` read-only agent (several blockers per
   agent, awaited in the foreground; office id `<caller>:<slug>:qa:<n>`, the caller
   as `parent`, the join/leave commands, the tracker's read tools by name) only when
   a blocker's description must be read to classify it.
3. **Record** — never by editing JSON by hand: a ticket with a work directory →
   `state.mjs blockers <workdir> '<rows>'` (writes `ticket.json.blockedBy`, derives
   `unblocked`, logs the note `blockers re-checked: …` on the stopped stage); a
   skipped candidate → `day.mjs advance <.claude>/work <date> '{ recheck: { "<id>":
   <rows> } }'` (recorded on the plan; an unblocked candidate is re-queued and
   scheduled by the script, `unblocked` names it).
4. **Resume** what the scripts report: a work-directory ticket whose state now says
   `unblocked` → `/tp-run-ticket <id>` (its step 0 does the rest — fresh worktrees when
   the repo rows say `discarded`); a re-queued candidate starts through the plan's
   `start` when a lane is free. A ticket with any blocker still unresolved stays
   parked; the report says by what, and the recorded states show in `/tp-status` and the
   office until the next re-check.
