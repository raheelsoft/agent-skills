# Review Scope

## Only review the diff

The scope rule is `skills/README.md` § Review scope and rounds (in: the lines the
PR adds or changes; out: everything else, unchanged code in the same files included).

## Example

A file has a pre-existing hardcoded `role === 'admin'` check on line 15; the author
only changed lines 40–50. The check on line 15 is out of scope — don't flag it as a
fix. It is a defect, so it gets a ticket (below) and a line under "Pre-existing".

## Why this matters

Mixing in-scope and out-of-scope feedback is the #1 cause of review fatigue. When 20
findings arrive and only 3 are about the actual change, people stop reading carefully.
Keep the signal-to-noise ratio high.

## Pre-existing defects become tickets, not findings

The rule, its scope ("code the diff touches or directly depends on") and its
off-switch are `skills/README.md` § Review scope and rounds. Here: such a **defect**
is filed and listed under "Pre-existing" with its ticket id — never under "Fix before
merging", never as a request to the author; pre-existing style, naming or pattern
issues are not listed at all. The passes are bounded and incremental by the same
section (`model.mjs rounds` gives the mode and ends the loop).
