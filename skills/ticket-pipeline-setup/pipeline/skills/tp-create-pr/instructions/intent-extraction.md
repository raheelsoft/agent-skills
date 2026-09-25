# Intent Extraction

Understand WHY this change exists, not WHAT it changes. The diff shows what changed; the
intent says why it matters.

## Process

1. Answer **what problem does this PR solve?** from what is already at hand, in order:
   the work directory (`ticket.md`, `plan.md` § Goal), the ticket's description, the
   commit messages, the branch name. Only when those leave it unclear is it the stop
   of SKILL.md § Stops: `"what problem does this PR solve? <the candidates found, if
   any> (no default)"`.
2. If the answer is an action ("adds X", "updates Y"), push back on yourself: **that
   is what the code does — what was broken, missing, or wrong before?**
3. Identify the ticket the same way. Work fixed straight from a report may have none —
   record that fact and where the report came from rather than inventing a ticket.
4. A good problem statement is one sentence a non-engineer could understand.

## Examples

Bad: "Add ownership authorization"
Good: "Any user could edit or reassign a record owned by someone else — nothing tied
those actions to the record's actual owner"

Bad: "Fix dashboard query"
Good: "The dashboard's active-item count was scoped to the whole team instead of the
individual, so everyone on a team saw the same inflated number"

Bad: "Refactor role handling"
Good: "Behaviour was switched on hardcoded role names, so it silently broke for any new
role that should behave the same way but wasn't literally named the same"

## Capture

- The problem, in one sentence.
- Who or what it affects (a user flow, a permission check, a state transition).
- How it shows up (wrong scope, missing guard, an action with no audit entry).
- The ticket, or the fact that there is none and where the report came from.
