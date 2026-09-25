# PR Description Format

## When the repo has a PR template

Use it (wherever the hosting platform looks for one — its docs name the path). Fill each section with intent-driven content;
delete optional sections that don't apply; never leave boilerplate.

## When it doesn't

```markdown
## Problem

[One sentence: what was broken, missing, or wrong — for UI work, how it diverged from
the design reference]

Ticket: ABC-123   ← or `Ticket: none (<where it was reported>, <date>)`

## Solution

[2–3 sentences: the approach and why this approach over the alternatives]

## How to verify

[Numbered steps anyone can follow in their own running instance — screen/command to
open, exact actions, expected result, data state to check. For UI work: which screen
and what to compare it against; name anything intentionally left unwired and the
ticket that covers it. End with the gate results in one line.]

<attribution footer the session specifies, if any>
```

## Rules

- **Problem first.** A reviewer who reads only the first line knows why the PR exists.
- **No file lists** — the diff shows that. **No line-by-line narration** — the code
  shows that. **No speculative risks** you haven't verified.
- **Short.** Bug fix: 3–5 sentences. Feature: 5–8. Larger: 8–12.
- **Link the ticket** as plain text (key or URL) so it can be cross-referenced; a
  stacked PR lists every ticket it carries.
- The title follows the repo's commit convention (usually the first commit's subject).

## When to edit it

On an update round the description is replaced only when the round changed what it
states: the problem, the solution, or a claim the PR makes that is no longer true (a
review finding showed it overstated something). A round that only fixes findings
gets a round comment, not a new description. The title changes only when the PR now
carries more tickets than before.
