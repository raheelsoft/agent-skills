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

After the sync. A **creation round** covers the **whole branch** against the base, in
a sub-agent that writes only `diff-validation.md`; an **update round** covers the
**round's delta** — the commits since the sha the file was last validated through —
and appends to the same file: the earlier rows stand (a file already judged is not
judged again unless the delta touched it), so drift across rounds is still caught,
without re-reading a diff that did not change. The delta is read by the skill's own
agent when it is small (`model.mjs rate` on its `--stat` says `low`), by the sub-agent
otherwise.

1. Creation round: `git diff <remote>/<base>...HEAD --stat`, then the hunks **per
   file** (`git diff … -- <path>`) for the files whose content must be read.
   Update round: `git diff <validated sha>..HEAD --stat`, then that diff the same way.
   Never the hunks of a lockfile, a generated file (an ORM client, API types,
   snapshots, build output, `linguist-generated`), a binary or a vendored tree
   (`skills/README.md` § Context management, rule 8): those are classified from the
   stat and their names — Supporting when their source changed with them (manifest
   ↔ lockfile, schema ↔ client), Unexpected otherwise.
2. Same question per file.
3. Report each file as Expected / Supporting / Unexpected with one line of reasoning;
   decisions about Unexpected items are the author's, not the validator's. End the
   file with `Validated through: <HEAD sha>` — the next round's starting point.

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
