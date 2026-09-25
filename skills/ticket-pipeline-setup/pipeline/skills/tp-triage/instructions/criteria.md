# Triage Criteria

Decide from evidence found in the ticket and the code, not from how the ticket sounds.
Check every row; the first column that applies decides.

| Signal | needs-input | plan | direct |
|---|---|---|---|
| Acceptance criteria | missing, or contradict the code's current behaviour | partly clear — the goal is clear, the edge cases aren't | clear, or the fix is fully implied by a reproduction |
| Blast radius | can't be estimated (the feature area can't be found) | more than ~5 files, or more than one area/module, or an unfamiliar subsystem with no pattern to follow | ≤ ~5 files in one area, with an existing pattern to copy |
| Data model | — | any migration, seed, schema or stored-data change | none |
| Access control / security | — | any change to who may do what, auth flows, secrets, PII handling | none |
| Public contract | — | changes an API, CLI, event, file format or schema that something else consumes | none |
| Repos / services | — | more than one repo or a deploy-order dependency | one repo |
| Reversibility | — | hard to undo (data rewrite, external side effect, one-way migration) | a plain code change, revertable by reverting the PR |
| Open questions | a decision only the user/stakeholder can make | questions the planner can answer by reading code | none |

## Complexity

The same rows rate the ticket `low`, `medium` or `high` for `triage.json.complexity`
(`skills/README.md` § Models and budget — every later agent's model follows it): map
each row of the table above onto the README's rubric columns — blast radius → Scope,
criteria → Ambiguity, the shared-state / access / contract rows → Risk, "existing
pattern" → Novelty — and the highest column that applies wins, exactly as the README
says. Uncertain → the higher level; record the deciding row in `triage.md`
§ Evidence.

Additional rules:
- A ticket that is an epic or container (its work is in sub-issues) → **needs-input**:
  which sub-issue.
- The ticket's own implementation brief (files to read, pattern to reuse) lowers blast
  radius uncertainty but does not by itself make a data-model or access-control change
  "direct".
- When `direct` and `plan` are both defensible, choose **plan** — a plan costs a
  planner and a checker; an unplanned change to the wrong area costs a review round.
- `confidence` is `low` when the evidence was mostly inference (the area couldn't be
  located precisely); say what would raise it.
- Record every checked row in `triage.md` § Evidence, including the "none" rows — the
  planner and the reviewer rely on the negatives too.

## Close

The ticket's premise no longer exists on the base branch: what it asks for is already
delivered (a merged change, another ticket's PR), another ticket supersedes it, or the
code it would change was removed. `close` only with that evidence named in `why`, or
when the person's `answers=` says to close it. A premise that merely changed (the
feature moved, the endpoint differs) is **needs-input** with the re-scope question,
never `close` on a hunch.

## Blocked

The ticket cannot be worked until another ticket's change lands: its criteria depend on
a table, an endpoint, a contract or a screen that another ticket delivers and that is
not on the base branch yet (a blocked-by relation the pickup found only soft, a
dependency the code makes plain, or the person's `answers=` parking it). `blocked`
names those tickets in `blockedBy` (ids only — the state script records their states
on every re-check) and, in `why`, what must land first. Nothing to build around: a
stub or a partial implementation is `plan`, not `blocked`. The ticket resumes by
itself once every blocker is resolved — `tp-start-ticket/instructions/blocked-check.md`
§ Re-check, run by `/tp-inbox` and `/tp-plan-day`.
