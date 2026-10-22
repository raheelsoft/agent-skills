# Ticket Template

Title: `<prefix or component per the tracker's convention> <what changes, in the
user's terms>` — e.g. `[web] Orders list shows an error state instead of an empty list
when the request fails`.

```markdown
## Problem
<One sentence: what is broken, missing or wrong, for whom. For a defect, then:>

**Steps to reproduce** (defects)
1. <where, as whom, what to do>
2. …
**Current:** <what happens>   **Expected:** <what should happen>
**Environment:** <branch/environment, build or version, date of the report>

## Acceptance criteria
- [ ] <observable outcome, testable by someone who didn't write the code>
- [ ] <…>
- [ ] Existing behaviour X unchanged

## Implementation brief
- Entry points: `path:line`, …
- Pattern to follow: `path:line` <what it shows>
- Involves: data model <yes/no> · access control <yes/no> · public contract <yes/no> ·
  second repo <yes/no>
- Not found / to confirm: <what discovery could not locate>

## Out of scope
<what this ticket deliberately excludes, and where that belongs>
```

Field rules:
- **Classification** → defect / change request / feature, expressed the way the
  tracker does (issue type, label or field), plus its area labels. Where the tracker
  uses iteration labels, a defect from a previous iteration keeps that label so
  prioritisation can see it.
- **Priority** from impact × breadth (blocks a workflow for all users > degrades one
  flow for some > cosmetic), unless the user set it.
- **Relations**: parent (epic) when given; blocked-by when the brief shows a
  dependency on unmerged work; related for tickets found in step 1 that are close but
  not the same.
- **Repo target** in the title or a component field, whichever the tracker's tickets
  already use.
- Length: a defect fits on one screen; a feature may be longer but the acceptance
  criteria stay a checklist.
