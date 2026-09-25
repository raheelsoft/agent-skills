# Sync

## Sync with the base branch

The base branch is `ticket.json`'s, or detected per `skills/README.md` § Definitions, Base branch.

```bash
git fetch <remote> <base>
git merge <remote>/<base>          # or: git rebase <remote>/<base>
```

Use the repo's sync strategy (conventions file, or `git log` showing merge commits vs
linear history). Default to merge: it is safe to push without force. Rebase only where
the repo requires linear history or the user asks — it rewrites commits already on the
remote and the push then needs `--force-with-lease`. If `<remote>/<base>` is already an
ancestor of `HEAD` (`git merge-base --is-ancestor`), there is nothing to sync — say so
and move on. After a sync that pulled in new commits, regenerate generated code
(`skills/README.md` § Toolchain).

## Resolving conflicts

A conflict usually means two branches touched the same file for different reasons, not
that one side is wrong. Read both sides:

1. For each conflicted file, understand what *this* branch intended and what the base
   added (`git log --oneline <remote>/<base> -- <file>`).
2. Both sides added independent, non-overlapping pieces to the same file (two filters,
   two schema fields, two seed rows) → **compose** them; keep both.
3. Both sides changed the same logic → decide what is correct going forward, not which
   side is "ours"; a stale comment or superseded shape on this branch may need to be
   brought up to the base's newer state.
4. Never `checkout --ours` / `--theirs` as a blanket resolution — it silently drops one
   side's work.
5. Afterwards run the fastest gate (the type check, where the language has one) before
   continuing; conflict resolutions break builds silently (a removed export still
   referenced, a renamed field).

Genuinely ambiguous (both sides intentional and incompatible) → the stop of SKILL.md
§ Stops: `"<file>: keep this branch's <x> (ours), or the base's <y> (theirs)? (no
default)"`.
