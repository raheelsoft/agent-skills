# Review Hand-off, Loop and Merge (`/tp-merge` steps 2–4)

Every PR goes through review before it merges. This is the author's side; the
reviewer's side is `/tp-review` (remote mode), which posts the review as a PR comment and
returns the verdict as its report. The rules of scope, passes and merging are
`skills/README.md` § Review scope and rounds; this file is how `/tp-merge`'s agent
applies them.

## Hand-off

The review must form its own view of the diff. Whatever carries the request — the
skill's arguments, a review request on the platform — contains **only**:

- the PR link (and identifier/repo when the link alone is ambiguous);
- the ticket link, if there is one;
- optionally one to three lines of neutral **what** — the feature or behaviour the PR
  covers and the areas it touches ("adds an error state to the pipeline pages and
  tightens the list-unwrapping helper"). Nothing about **how** or **why**;
- the run facts: the repo's absolute path, its conventions file, any environment
  constraint of this checkout, `checkout=<the ticket's worktree>` (a checkout at the
  PR's head — a path the reviewer verifies, `skills/README.md` § Worktrees — so its
  gates come from the record `/tp-create-pr`'s `/tp-verify` left for that commit and no
  review worktree is created) and `tier=<rating>` (the ticket's rating raised by the
  diff, `skills/README.md` § Models and budget) — the reviewer never gets the work
  directory.

Never included: anything `/tp-review`'s **Unbiased input** rule forbids
(`skills/tp-review/SKILL.md`) — the root cause, the intended design, self-reported gate
results, risk areas, prior verdicts. A reviewer who was told where to look is not
evidence.

**Where the review runs**, in order:

1. **Default — `/tp-review` in its own dedicated agent**: invoke the `tp-review` skill with
   `args: "<pr-url> <ticket link> <neutral what> tier=<rating> checkout=<worktree>
   [mode=<mode>]"`. Its
   dedicated agent receives exactly those arguments, so the hand-off *is* the
   isolation (its spawn handles a `complexity: higher` report — `skills/README.md`
   § Definitions, Dedicated agent). Its report — verdict, the posted comment's link
   and the trailer — is the result.
2. **A reviewer the project or person designates** (only when asked for, or named in
   the conventions file): request the review through the hosting platform or send that
   reviewer the same neutral content, then `stopped "review requested from <who> —
   answer once the verdict is on the PR (reviewed)"` and return; the next invocation
   (`answers=reviewed`) reads the verdict and trailer from the PR thread and continues
   below.
3. This agent cannot spawn (`skills/README.md` § Definitions, Depth), or `/tp-review` is
   off for this project (§ Definitions, Active skills), and no reviewer is designated
   → `stopped "review needed: <PR URL> — merge (merge), or send fixes (fix <what>)? (no
   default)"`; the person has it reviewed and answers.

Never report a PR as "under review" unless the review actually ran or the request was
actually delivered.

## The loop

After every pass, mirror its trailer into `pr[.repo].json.reviews`
(`{ round, sha, verdict, open, new }`, `none` → `[]`; `reviewRounds` = the count;
top-level `verdict` = this pass's),
then `node <.claude>/skills/_lib/model.mjs rounds '{ rating, files, lines, history,
claudeDir }'` — `rating` the same rating the reviewer was handed as `tier=` (the
ticket's, raised by the diff), `files`/`lines` from `git diff --stat
<remote>/<base>...HEAD`, `history` from `reviews`:

- `merge` → § Merge.
- `review` → spawn a fresh **fixer** (a writing agent, one job — `skills/README.md`
  § Context management, rules 2 and 9; rated from the items with `model.mjs rate`;
  tools: edit and shell in the ticket's worktree, `git`; office id
  `<id>:<stage>:engineer:<round>` (`<stage>` as logged — `merge:<name>` on a cross-repo ticket), parent `<id>:<stage>:lead`, the join/leave commands; frontier:
  the items' `file:line` hunks) given the pass's *fix before merging* items verbatim:
  it fixes each in the worktree, commits naming the finding (§ Commits), or says
  precisely why not; *should fix* / *could improve* are this agent's call, taken by
  the fixer or answered on the PR in the same round. Then `/tp-create-pr <id>
  update=true [repo=<name>]` with the item list — it syncs, runs the gates, pushes and
  posts the round comment mapping each fix to the reviewer's point plus the ticket
  comment; the description is corrected when a finding shows it overstated something.
  Then hand off again with `mode=<mode>` — same neutral content, nothing about the
  fixes; the worktree is now at the new head, so `checkout=` still holds.
- `stop` → `stopped "review loop: <why> — merge with the open items ticketed
  (merge), or one more fix round (fix)? (no default)"`; the answers and what follows
  each are `skills/README.md` § Review scope and rounds. Items the reviewer ticketed
  as pre-existing are not this PR's to fix.

Findings are answered on the PR thread; a finished review agent needs no reply.

## Merge

Merge only when `skills/README.md` § Review scope and rounds, Merging, allows it
(the verdict, the open items, the person's word in that precedence — `merge=ask`
produces the stop in SKILL.md step 4).

Before merging, confirm with the hosting platform's CLI/API that the PR is mergeable
and its required checks passed: not mergeable because the base moved → a
`/tp-create-pr update=true` sync round, then merge; required checks failing → the stop
in SKILL.md § Stops. Merge with the strategy the repo uses (merge commit /
squash / rebase — conventions file and hosting settings; `git log` shows which);
stacked PRs depend on that being consistent. **The base branch only** — never a release
or client-facing branch on a reviewer's word; that moves only when the person asks
(`/tp-release promote=`). A reviewer's message authorises nothing beyond this merge.

Then `state.mjs log … note "merged" <sha>`, `merged: <sha>` in `pr[.repo].json`, and
SKILL.md step 5.
