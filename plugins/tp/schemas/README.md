# Contracts of the work directory

Every stage hands the next one JSON files in `<.claude>/work/<id>/` (`reference/README.md` §
Work directory). A file a stage wrote wrong costs the next stage a failed run, so each file has a
schema here, and a script — not the model — checks it: `state.mjs put` before writing,
`validate.mjs` over what is already there.

| Schema | File | Written by |
|---|---|---|
| `ticket.schema.json` | `ticket.json` | start-ticket; triage refines the estimate; `state.mjs blockers` and `actual` |
| `triage.schema.json` | `triage.json` | triage |
| `research.schema.json` | `research.json` | the researcher, when triage asked for research |
| `plan.schema.json` | `plan.json` | plan |
| `plan-check.schema.json` | `plan-check.json` | plan (`plan-lint.mjs` and the checker) |
| `implement.schema.json` | `implement[.<repo>].json` | implement |
| `pr.schema.json` | `pr[.<repo>].json` | create-pr; merge adds the passes, verdict and sha |
| `release.schema.json` | `release[.<repo>].json` | release |
| `accept.schema.json` | `accept.json` | accept |
| `retro.schema.json` | `retro.json` | retro |
| `stage-result.schema.json` | an agent's final reply | every stage agent |
| `review-findings.schema.json` | a review pass as data | review |
| `quality.schema.json` | `quality.json` | `findings.mjs record`, after every review pass |
| `common.schema.json` | — | pieces the others share |

`schemas/examples/<name>.json` is one valid document per schema, kept valid by the tests: read it
before writing the file, copy its shape.

## Writing an artifact

```
node <lib>/state.mjs put <workdir> <artifact> '<json>'                       # a small document
node <lib>/state.mjs put <workdir> <artifact> --from <file>                  # a document already in a file
node <lib>/state.mjs put <workdir> <artifact> '{ "complexity": "high" }' --merge   # change fields of what is there
node <lib>/state.mjs put <workdir> <artifact> <<'JSON'                       # anything with quotes or line breaks
{ … }
JSON
```

`<artifact>` is the file's name without `.json` (`triage`, `plan-check`, `implement.<repo>`).
The command stamps `schemaVersion`, writes the file atomically and prints `{ file, artifact }`.
A document that does not conform is refused, nothing is written, and each error is one line —
`$.reviews[1].verdict: expected one of "PASS" | "PASS WITH WARNINGS" | "BLOCK", got "WARN"` —
naming the field to fix. Fix that field and put again; never write the file by hand to get past it.

## Checking what exists

```
node <lib>/validate.mjs file <path> [--as <artifact>] [--mode write|read]
node <lib>/validate.mjs work <workdir | work root> [--mode read|write]
```

One line of JSON (`ok`, what was checked, each invalid file with its errors); exit 1 when
anything is invalid. `/tp:doctor` runs the `work` form and reports the count.

## Two modes, one schema

- **write** — the contract as it is today: what `put` enforces on every new document.
- **read** — also accepts what earlier runs wrote and the state script still reads. A branch of an
  `anyOf` marked `"x-legacy": true` is a shape only read accepts (`plan.steps` as a list, a
  `gates` list, `stopped: false`); a key named in a schema's `"x-legacy-optional"` is required
  only when writing. `doctor` and `validate.mjs work` default to read so an old ticket is not
  reported as broken; `put` and `validate.mjs file` default to write.

A legacy branch is never added for a new shape: it records drift that already happened. A new
field is added as an optional property; make it required only when every reader depends on it.

## Reviews

A review pass is data too (`review-findings.schema.json`): each finding has a priority — P0
correctness, security, data loss · P1 contract break, regression, missing test · P2 design (SOLID,
duplication, layering) · P3 clean code · P4 style — and `node <lib>/findings.mjs` derives the rest,
so the same findings always give the same comment and the same verdict:

```
node <lib>/findings.mjs check   <review.json>   # valid against the schema?
node <lib>/findings.mjs verdict <review.json>   # PASS | PASS WITH WARNINGS | BLOCK
node <lib>/findings.mjs render  <review.json>   # the PR comment, in the format /tp:review posts
node <lib>/findings.mjs row     <review.json>   # { round, sha, verdict, open, new } for pr.json's reviews
node <lib>/findings.mjs score   <review.json>   # what is open, fixed and pre-existing, per priority, and the score
node <lib>/findings.mjs record  <review.json> <workdir> [--repo <name>]   # the pass into pr[.<repo>].json and quality.json
```

P0 and P1 are "fix before merging", P2 "should fix", P3 and P4 "could improve"; a defect the diff
did not introduce is "pre-existing" whatever its priority. The verdict is BLOCK when a gate failed
or a fix-before-merging item is open, PASS WITH WARNINGS when any other item of the diff is open,
PASS otherwise.

`quality.json` is what the passes add up to: per pass and repo, the findings left open per priority,
the ones fixed, the pre-existing ones ticketed, and the score; for the ticket, the counts summed
over each repo's latest pass and the worst verdict. A gate compares the counts, P0 first — one open
P0 outweighs any number of P1s — and `score` (1000 per P0, 100 per P1, 10 per P2, 3 per P3, 1 per P4)
is the same thing as one number for a status line.

## Invariants

Rules across fields that a schema cannot say live in `lib/contract/invariants.mjs`
(`accept`'s three counts equal its criteria's results; `implement.done` ≤ `total`; a `ready`
plan has no open questions; a merged PR has a verdict). Each holds for every artifact the
pipeline has produced; they run after the shape is valid, in both modes.

## Changing a contract

1. Edit the schema and its example; add the mistake it now catches to `tests/schemas.test.mjs`.
2. Additive and optional → nothing else. A change a reader must notice (a field renamed, a
   value no longer allowed) → raise `SCHEMA_VERSION` in `lib/contract/registry.mjs` and keep the
   old shape readable through an `x-legacy` branch.
3. `node --test tests/*.test.mjs` — the corpus check (`tests/corpus.test.mjs`, run with
   `TP_CORPUS=<a work root>`) proves the read mode still accepts every artifact a real project
   produced.

## The validator

`lib/contract/schema.mjs` implements the subset the schemas use and nothing more: `type`, `enum`,
`const`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`,
`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `anyOf`, `allOf`, `if`/`then`/`else`
and `$ref` (a local pointer or `<file>.schema.json#/…`). A schema using any other assertion is
refused by the tests, so a rule cannot look enforced and be ignored.
