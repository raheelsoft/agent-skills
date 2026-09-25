# PR and Ticket Comments

Posted after the push has succeeded and the PR exists. Comments are short and factual —
what changed and why, never a line-by-line narration (same rule as the description).
Post from a file, not an inline string, so formatting and quoting survive.

## Round summary on the PR (update rounds only)

Skip on a brand-new PR — the description already covers it. On an update round (review
feedback, a sync after the base moved, a stacked ticket), post one comment:
- One line per distinct change. When the round answers review feedback, mirror the
  reviewer's own points so each fix maps to a comment.
- The gate results (pass/fail per gate, not full output).
- For user-facing changes, the manual-validation steps that are new this round (the
  creation round's steps live in the description's "How to verify").
- Nothing that belongs in the description (`description-format.md` § When to edit it
  says when a round changes the description instead).

## Ticket comment (every round with a linked ticket)

On the ticket, 2–4 sentences: what the round delivered in feature terms, `PR: <url>`,
and the state (ready for review / addressing feedback / blocked on X). For user-facing
changes, append the manual-validation steps — the ticket is where the user tests from.

## Replies about a review

`/tp-merge`'s `skills/tp-merge/instructions/review-loop.md`, not here.

## All comments

No personal data (`skills/README.md` § Personal data) — manual-validation steps name
the project's documented test accounts or fixtures, never a real person's.
