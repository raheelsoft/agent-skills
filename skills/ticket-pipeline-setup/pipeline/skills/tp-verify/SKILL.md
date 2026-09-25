---
name: tp-verify
description: Run the project's quality gates (types, lint, build; tests on request) — skipping the ones the repo's own git hooks already enforce — as parallel background processes compared with a cached base, and report pass/fail; results are recorded per commit and reused.
user_invocable: true
---

Run the quality gates and report results — once per commit, and only the gates nobody
else already ran. Two rules of `skills/README.md` § Verification rules decide what that
is: a gate the repo's **hooks** own is reported as `HOOK` and not run here, and a gate
**result** is a fact about the checkout's head and its base, so a recorded one is
reused instead of re-run (the invokers ask for it before spawning this skill at all,
and this skill records what it ran). No agent runs a gate — a command's result needs no
judgment — and the base's output comes from one persistent baseline checkout per repo,
cached per base commit, never from a fresh checkout.

## Input

- **No argument** → detect everything below.
- **`base=<base branch>`** (optional) → the branch that "changes" and any changed-file
  scoping are measured against; the callers (`/tp-implement`, `/tp-create-pr`, `/tp-review`)
  know it. Without it, detect the base as described in step 2.
- **`tests=true`** (optional) → also run the project's test target as a gate — on a
  disposable copy of any shared state the tests touch (`skills/README.md`
  § Verification rules).
- **`path=<checkout>`** (optional) → the checkout to gate (a ticket's worktree)
  instead of the current directory; every gate command runs there.
- **`readonly=true`** (optional) → the checkout is not this invocation's to change (a
  reviewer gating the author's worktree): a gate that rewrites files is a FAIL naming
  them, and the files are restored (`git checkout -- <files>`) before the report.
- **`full=true`** (optional) → run every gate here, hooks or not (an audit, a release
  check, a checkout whose history did not come through the hooks).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `medium` (detect the toolchain, assemble the table). `/tp-verify` never writes
  to a ticket's `progress.md`; a checkpoint goes under `<.claude>/work/_scratch/`.

## 0. Reuse a recorded result

`node <.claude>/skills/_lib/gates.mjs result get '{ repo, head: <git rev-parse HEAD>,
base: <git rev-parse <remote>/<base>>, checkout: <path>, claudeDir }'` — exit 0 → the
record's `table` is this invocation's report, marked `reused — recorded <at>`, and
nothing runs (the invokers ask the same before spawning this skill at all, so this
is the by-hand run's shortcut); exit 1 (nothing recorded) or 2 (the checkout is not
at that head, or holds uncommitted changes) → the gates run below. Without `base=`,
detect it first (step 2).

## 0b. Ask the hooks what they already enforce

`node <.claude>/skills/_lib/hooks.mjs cover '{ repo, claudeDir }'` per project (skip
with `full=true`): every gate in `covered` becomes a `HOOK` row — `HOOK` in Status,
`<hook> · <command>` in Notes — and does **not** run below. A gate whose hook is
`pre-push` is enforced at the push, so it is a `HOOK` row only when this checkout's head
is pushed (`git rev-parse @{u}` equals `HEAD`; otherwise it still runs here, because
nothing has enforced it yet). Nothing covered, or no hooks → every gate runs as before.

## 0c. Bring the generated code up to date

`node <.claude>/skills/_lib/codegen.mjs status '{ repo, claudeDir }'` per project (skip
with `full=true`? no — this one always runs: a gate against stale generated code
invents findings). Exit 0 → nothing to do. Exit 1 → run its `command` once, output to a
file (rule 11), then `codegen.mjs mark` so later runs know this checkout is current;
the baseline checkout gets the same treatment before a whole-program gate runs there
(§ Verification rules, and `skills/README.md` § Toolchain owns the rule). A failure
here is an environment failure, not a gate result: the error form, with the command and
its first lines — every type-aware gate below would be reporting its consequences
otherwise.

## 1. Find the project(s) that changed

- Inside a git repo → that repo.
- A directory that is not itself a git repo but contains repos → every subdirectory
  repo that has changes (uncommitted work, or commits ahead of its base branch).
- A workspace monorepo (one repo, many packages) → use its own affected-package
  detection if the tooling provides one; otherwise every package with changes.

More than one changed project → run the full gate set in each and report each
separately.

## 2. Resolve the gate commands

`node <.claude>/skills/_lib/hooks.mjs gates '{ repo, claudeDir }'` — one resolver for
every ecosystem, and the same one the hooks are written from, so a gate runs the same
command here and in a hook: `tiers.json.hooks.commands` (what this install stated, any
language) → a target the **project itself** defines (a package script, a
`Makefile`/`justfile`/`Taskfile` target, a composer or poetry script) → the ecosystem's
own command for the toolchain the repo actually configures (`cargo`, `go`, `ruff`/
`black`/`mypy`/`pytest`, `rubocop`/`rspec`, Gradle, Maven, `dotnet`, `mix`, `swift`, …)
→ `missing`, which is a gate that does not run and is said so in the report. Never
hand-build a substitute for a defined command — a project's lint target often chains
more than one tool, and a reimplementation silently drops the rest.

| Gate  | Runs | When the resolver has none |
|-------|------|-----------------------------|
| Types | the resolved `types` command | skip: the language has no separate step, or the project defines none |
| Lint  | the resolved `lint` command, verbatim | skip |
| Build | the resolved `build` command | skip; also skip for doc-only or config-only changes and say so |
| Tests | the resolved `tests` command, only with `tests=true` or when CI defines a fast pre-push subset | — |

- **Tooling:** the resolver reads the project's own runner (a lockfile git does not
  track is a stray file, not the project's package manager); install with that same
  runner. Two tracked lockfiles for one ecosystem are an inconsistency — flag it and
  check the CI config for which is canonical rather than guessing.
- **Any OS:** every gate is a command the project already runs, so it runs wherever the
  project does; nothing here assumes a shell built-in, a POSIX path or a platform tool.
- **Base branch:** the `base=` argument if given; else detect per `skills/README.md`
  § Definitions, Base branch.
- **Gates run on the change** (`skills/README.md` § Context management, rule 8). With
  `base=`, the changed files are `git diff --name-only <base>...HEAD` plus the
  uncommitted ones: a file-scoped tool (lint, format, unit tests by file) gets that
  list — passed to the *same* tool the defined target runs, never a narrower
  substitute for the target — and a whole-program tool (type check, build) runs once
  here and is compared with its output **on the base**, which comes from the repo's
  **baseline**: `node <.claude>/skills/_lib/gates.mjs base '{ repo, base, remote,
  claudeDir }'` → `_scratch/wt/base-<repo-name>`, one detached checkout per repo for
  the whole install — created on first use, moved to the base's head when it advanced
  (`moved`), its dependencies installed once and again only when `lockfilesChanged`
  names a file (§ Toolchain; the install's output to a file under
  `_scratch/gates/<repo-name>/`, read by its exit code and last lines — rule 11),
  never the person's copy. The base's output is **cached
  per base commit**: `gates.mjs cache get '{ repo, sha, gate, command, claudeDir }'`
  first — a hit is the output, and nothing runs on the baseline; a miss runs the same
  command there (in step 3's batch) and `cache put`s the result, so a base that has
  not moved costs nothing again, for this ticket or the next. `gates.mjs release`
  once the baseline is no longer needed; `base` exiting 3 means another verify holds
  it (producing the same commit's output, most likely): wait and ask again, bounded
  by the gate's usual duration, then `model.mjs retry`. The findings are `gates.mjs
  new '{ repo, baseFile, headFile, checkout, claudeDir }'` — the normalised lines
  (positions, durations, stamps and both checkouts' paths stripped) present in the
  head's output and absent from the base's — listed changed files first ("no new
  errors vs base"; a count is never the evidence). Without `base=`, everything runs
  whole. A gate tool missing from the environment past its documented fallback
  (§ Toolchain) is an environment failure: the error form, not a table row
  (`skills/README.md` § Failures and escalation).
- **Autofix:** a lint step that rewrites files changes the checkout. After all gates
  finish, `git diff` to see what it changed before treating the gate as clean; with
  `readonly=true` the gate is a FAIL naming the files, which are restored.

## 3. Run the gates as background processes

The gates are independent reads of the same checkout, so they run concurrently — as
**background processes from one shell call**, each with its output to its own file
under `<.claude>/work/_scratch/gates/<repo-name>/run-<stamp>/` (the base's
whole-program commands, when the cache missed, in the same batch in the baseline
checkout), waited for together, then read: PASS/FAIL per gate and the first ~20 lines
of a failure, the changed files first — never the whole output into this context. No
agent runs a gate (`skills/README.md` § Context management, rule 4): a command's result
needs no judgment, and a process keeps its output out of every context just as well.
Don't stop at the first failure — everything has already run, so report every result.
An autofixing lint step is the only writer: it runs alone, after the read-only gates,
and never two autofixing invocations on one project at once. Delete the run directory
once the table is written.

## 4. Report

```
## Verification Results — <project>

| Gate  | Status | Notes |
|-------|--------|-------|
| Types | PASS   |       |
| Lint  | PASS   |       |
| Build | PASS   |       |

**Verdict:** ALL GATES PASSED
```

One table per project; every gate that ran with its real result, plus a `HOOK` row for
each gate the repo's hooks enforce (§ Verification rules) — `| Lint | HOOK |
pre-commit · npx lint-staged |`; the verdict counts a `HOOK` row as passed and the line
below the table says how many came from hooks. A reused record says so under the table
(`reused — recorded <at>`). Fixing
proceeds one failure at a time; reporting does not.

Then record it: `node <.claude>/skills/_lib/gates.mjs result put '{ repo, head, base,
verdict, table, gates: { <gate>: "PASS"|"FAIL" }, checkout, claudeDir }'` — recorded
only while the checkout is still clean at that head (exit 2 otherwise: an autofix that
changed files leaves nothing to record; the caller commits and the next run records).
The record is what `skills/README.md` § Verification rules lets every later stage reuse
instead of running the same gates on the same commit.

## Stops
None for a question — a failing gate is a result, not a stop. `error: …` only: a gate
tool missing past its documented fallback, a baseline that cannot be created or moved
(`gates.mjs base` failing past `model.mjs retry`'s bound), a process that produced no
output twice (`skills/README.md` § Failures and escalation; the state in
`_scratch/verify-<slug>.md`): `answers=retry` once the person has done what `needs`
names.
