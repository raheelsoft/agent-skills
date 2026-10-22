# Shared procedures

Remote access failures, the toolchain, commits, tickets, review scope and rounds, personal data.

**Contents** — [Shared procedures](#shared-procedures) ([Remote access failures](#remote-access-failures) · [Toolchain](#toolchain) · [Commits](#commits) · [Tickets](#tickets) · [Review scope and rounds](#review-scope-and-rounds) · [Personal data](#personal-data))

## Shared procedures

### Remote access failures
`Permission denied (publickey)`, `Repository not found` on a repo that exists, `could
not read Username` — an identity/credential configuration problem, not the code.
Report the exact error and the likely fix; let the person resolve it. Never rewrite
remote URLs, switch protocols or edit ssh/credential/shell config to get past it —
those changes outlive the task. The hosting platform's CLI/API authenticates separately
and can carry read-only checks meanwhile.

### Toolchain
Run tools the way the project defines them (task-runner targets, package scripts) with
the toolchain its lockfile/config and CI use — one resolver finds them for every
ecosystem (§ Verification rules). If a tool won't start because of the interactive
shell's setup, invoke its binary directly rather than editing shell configuration.

**Generated code is part of the toolchain.** An ORM client, a GraphQL or protobuf stub,
a typed API client is written by a tool from a schema in the repo and lives outside git,
so a fresh worktree, a pull or a rebase can leave it behind the schema — and a
type-aware gate then reports the mismatch as dozens of errors in code nobody touched
(twenty-two of them, once, from one stale Prisma client). So it is checked, not
remembered: `node <lib>/codegen.mjs status '{ repo, claudeDir }'` names
the project's own generate command (`tiers.json.codegen` → a `generate`/`codegen`
target the project defines → the tool its config implies: Prisma, graphql-codegen,
sqlc, buf, drizzle, `go generate`), the inputs it is generated from, and whether the
output is missing or those inputs have changed since the last run — content, not
mtimes, so a checkout does not look stale and a real schema change never looks current.
A stage that finds it stale runs that command once and records it (`codegen.mjs mark`):
`/tp:start-ticket` when it makes a worktree, `/tp:verify` before it gates, `/tp:doctor` as a
warning with the fix. A project that generates nothing says so and costs nothing.

### Commits
The repo's commit-message convention (read `git log`), any attribution trailer the
session specifies, and `git -c user.useConfigOnly=true commit` so a missing identity
fails instead of being guessed. A commit or push the repo's hooks reject is a gate
failure to fix in the change (§ Verification rules): never `--no-verify`, never
`core.hooksPath` changed to get past one, never the hook itself edited to pass — a hook
the project owns is only changed by the project, through a ticket like any other change.

### Tickets
Only `/tp:create-ticket` creates tickets — on the person's request, and for a
pre-existing defect a review finds in code a PR touches or depends on, unless the
conventions file turns review tickets off (§ Review scope and rounds). Every other
stage comments. No stage marks a ticket done.

### Review scope and rounds
A review judges **the diff and nothing else**, every pass after the first is
**incremental**, and the number of passes is a **budget derived from the change's
complexity** with convergence rules that end the loop earlier.
- **Scope.** In scope: lines the PR adds or changes. Out of scope: everything else,
  including unchanged code in the same files. A pre-existing **defect** (wrong
  behaviour, security, data integrity — never style) in code the diff touches or
  directly depends on is not a finding against the PR: the reviewer files it with
  `/tp:create-ticket` (file, line at the base revision, what is wrong, the PR that touched
  it; the skill de-duplicates) and lists it as *pre-existing, tracked as `<ticket>`*.
  A project can turn this off in its conventions file ("reviews do not create
  tickets"): then the item is *pre-existing — ticket needed*. Pre-existing style or
  pattern issues are not reported at all.
- **Findings carry a priority, and the rest is derived.** P0 correctness, security, data loss ·
  P1 contract break, regression, missing test · P2 design (SOLID, duplication, layering) · P3 clean
  code · P4 style. The reviewer writes its findings as JSON; `findings.mjs` renders the comment and
  computes the verdict — `BLOCK` when a gate failed or a P0/P1 item is open, `PASS WITH WARNINGS` when
  anything else of the diff is open, `PASS` otherwise — and `record` adds the pass to `pr.json` and to
  `quality.json` (`schemas/README.md` § Reviews). The merge waits for no open P0 or P1.
- **The loop** is `model.mjs rounds '{ rating, files, lines, history, claudeDir }'` →
  `{ cap, round, next, mode, open, why }`. The budget is the change's rating — `low` 2,
  `medium` 3, `high` 4 passes, one more for a large diff, never above 5
  (`tiers.json.review`). After every pass `next` is `merge` (nothing open), `review`
  with a `mode` — `full` (the first pass, `<base>...<head>`), `delta` (the commits since
  the reviewed sha plus a resolution check of every open item; no new findings on lines
  unchanged since that sha; no *should fix* / *could improve*), `resolution` (the
  budget's last pass: the resolution check only; anything else is *noted, not gating*)
  — or `stop`: the budget is spent, a pass resolved nothing, or two passes after the
  first both raised new items. A gate failure is a numbered *fix before merging* item
  like any other. On `stop` the author's side — `/tp:merge` — logs `stopped "review loop:
  <why>"`;
  `answers=merge` tickets the open items and merges, `answers=fix` is one more update
  round with no review pass, then the merge conditions apply as for PASS WITH WARNINGS.
- **History**: every review comment ends with `Reviewed: <sha> · round <n> · open:
  <ids or none> · new: <ids or none>` (item ids stable across passes); `/tp:merge`
  mirrors each pass into `pr[.repo].json.reviews` (`none` → `[]`) and feeds it back to
  `rounds`.
- `/tp:merge` fixes all of a pass's *fix before merging* items once per round (a
  `/tp:create-pr update=true` round: commit, sync, gates, push, round comment);
  *should fix* and *could improve* are the author's call and never a reason for another
  pass. **Merging** needs a passing verdict, every fix-before-merging item resolved, and
  the person's word — in this precedence: an explicit `merge=auto|ask` on the
  invocation; else the conventions file or the person's standing instruction ("a
  passing review merges"); else `ask`. `auto` merges; `ask` stops with `"review
  <verdict> — merge (merge), or send fixes (fix <what>)?"` — `answers=merge` merges,
  `answers=fix` runs one `/tp:create-pr update=true` round with the fixes named and asks
  again.

### Personal data
Never real customer/user personal data in tickets, commits, PRs, comments, fixtures,
logs, checkpoints, evidence or notifications — describe it or use synthetic references.
