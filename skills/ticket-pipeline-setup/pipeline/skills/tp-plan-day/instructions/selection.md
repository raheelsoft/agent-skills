# Selection — what a day can draw from

## Scope

The tracker project(s), team or board the conventions file or the person's standing
instructions name — the same scope `/tp-start-ticket next` uses
(`skills/tp-start-ticket/instructions/ticket-intake.md` § Picking the next ticket). A
standing scope narrows it before anything else: one repo (a title prefix or area
label), a ticket kind (defects before change requests: the highest non-empty kind is
the pool), a client or a milestone. Nothing names a scope → stop and ask; never guess a
project from the person's memberships.

## Candidates

- **State** — the tracker's not-started category (backlog, todo, unstarted, selected
  for development). Not in progress (someone is on it), not in review, not done,
  cancelled or duplicate.
- **Containers** — an epic or parent ticket that is a container contributes its
  children in scope; it is never selected itself
  (`skills/tp-start-ticket/instructions/ticket-intake.md` § Repo target).
- **In flight** — any id with a work directory under `<.claude>/work/`: listed with its
  state and its stop question, never re-selected; a valid dependency target (a ticket
  can be planned to follow one that is still running).
- **Assignee** — unassigned, or assigned to the person. Someone else's not-started
  ticket is theirs to pick up — not a candidate unless the standing instructions say
  tickets are shared.
- **The row**, per ticket, in two halves (SKILL.md step 2 takes them in that order).
  **Metadata**, from the planner's own tracker list, one call for the whole scope and
  no agent: id, title, state, assignee, labels, parent, priority, the tracker's
  estimate, blocked-by ids with their current states. Every filter above, the feature
  match below and the draw run on this half alone.
  **From the description**, and only for the tickets still standing after them — what
  a list cannot answer: prose dependencies, repo hints, and the estimate signals
  (repos named, risk wording or labels, criteria present / derived / missing, whether
  the brief names a pattern to follow). This half is what the fetch agents are for,
  several tickets each; a scope whose list answers it needs no agent.
  The planner reads rows, never whole tickets.

## Matching a feature

A feature name matches a ticket when its significant words (case-insensitive; articles
and punctuation ignored) all appear in the title, a label, the parent or epic's title,
the project or milestone name — or the ticket is a child of an epic that matches. A
mention only in the description matches when the title is generic ("follow-up",
"part 2"). Names the tracker itself uses count as synonyms ("permissions" for an epic
named "Roles & Permissions"); the report says which words matched. Several names →
the union.

## The pool draw

Random within what remains after the scope, feature and blocked filters, seeded by the
date (`day.mjs`): the person steers with names and `count=`, not by re-rolling. A
standing ranking of ticket kinds applies before the draw (the highest non-empty kind is
the pool); nothing reorders within it.
