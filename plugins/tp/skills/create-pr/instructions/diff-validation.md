# Diff Validation

Check that the changed files match the stated intent. Run twice, at two points, for
two purposes.

## Before commit (SKILL.md step 3)

Over **uncommitted** changes, before they are locked in — the cheap moment to drop a
stray file with a one-word decision instead of a revert later.

1. `git status` and `git diff`.
2. For each file: does this change serve the stated problem?
3. Anything that doesn't → "Unexpected changes" below; commit only what serves the
   intent plus whatever the user confirms.

## Before push (SKILL.md step 5)

After the sync. A **creation round** covers the **whole branch** against the base; an
**update round** covers the **round's delta** — the commits since the sha the file was
last validated through — and appends to the same file: the earlier rows stand (a file
already judged is not judged again unless the delta touched it), so drift across rounds
is still caught, without re-reading a diff that did not change.

1. `node <lib>/diffcheck.mjs` (SKILL.md step 5) does the part that needs no reading, on
   this machine: from `git diff` and the plan it classifies each file — Expected when the
   plan's steps name it (or a folder they name), Supporting when it is a lockfile whose
   manifest changed with it, a generated file (snapshots, build output, `linguist-generated`)
   with its source, or a test beside the code it tests; Unexpected otherwise — and lists the
   warning signs below it can see. A lockfile, a generated file, a binary or a vendored tree
   is classified from the stat and its name and its hunks are never read
   (`reference/context-management.md` § Context management, rule 8). Nothing Unexpected and no
   warning → the table is the script's and no one reads the diff.
2. Otherwise the reader — a sub-agent on a creation round, the skill's own agent for a small
   delta (`model.mjs rate` on its `--stat` says `low`) — reads the hunks **per file**
   (`git diff … -- <path>`) of the Unexpected files and the ones a warning names, and nothing
   else: the script's rows for the rest stand. Same question per file: does this change serve
   the stated problem?
3. Report each file as Expected / Supporting / Unexpected with one line of reasoning (the
   script wrote them for the files it classified); decisions about Unexpected items are the
   author's, not the validator's. End the file with `Validated through: <HEAD sha>` — the next
   round's starting point (the script's table ends with it).

## Categories

- **Expected** — directly implements the solution to the stated problem.
- **Supporting** — a necessary side effect (imports, a shared type, a migration, a
  seed row, a generated file). Should be a small minority.
- **Unexpected** — no clear connection to the intent. Needs an explanation or a
  separate PR.

## Unexpected changes

Decide from the files first (the plan's steps, the commit messages, the ticket). What
the files cannot explain is one stop, phrased as a decision: `<n> unexpected files:
<list> — keep, drop, or split into a separate PR? Default: keep`
(`answers=keep|drop|split`); a diff much larger than the intent implies is the same
stop with the size mismatch named.
(Each is a stop: with a work directory the skill logs `stopped` before asking.)

## Warning signs

- More than ~10 files for a focused fix.
- Formatting or import reordering across many files (often an autofixing lint —
  check the lint/format config or re-run the formatter before treating it as
  unrelated).
- Changes in unrelated feature areas.
- A schema change without its migration, or a migration without its schema change.
- Lockfile changes with no dependency change in the manifest, or vice versa.
