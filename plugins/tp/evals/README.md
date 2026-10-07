# Evals — does the plugin do what its files say?

Tests (`node --test tests/*.test.mjs`) hold the scripts, hooks and contracts for free. These evals hold the
*behaviour*: a real session loads the plugin, is given a prompt, and deterministic graders look at what it did —
the tools it called, the files it left, what the hooks said to it. They cost tokens, so they run on demand.

## Run them

```
# the smoke set: one run of each case, about 30 cents on the model the project's ceiling names
claude plugin eval plugins/tp --scaffold --tag smoke --runs 1 --ablation none \
  --allow-tools Bash Write Read Agent WebFetch --model sonnet --max-cost-usd 5 --no-publish --trust-plugin

# one case
claude plugin eval plugins/tp --scaffold --case raw-write-then-put --runs 1 --ablation none ...

# before a release: every case three times, against a session with no plugin, failing below 0.8
claude plugin eval plugins/tp --scaffold --runs 3 --threshold 0.8 --allow-tools ... --no-publish --trust-plugin
```

`--scaffold` runs each case's `scaffold.sh` (it builds the project the case works in); `--no-publish` keeps the report
local (`evals/results/`, git-ignored); `--max-cost-usd` is the hard stop. The tests check that every case file is well
formed (`tests/evals.test.mjs`) without running any.

## What a case is

A folder with `case.yaml` (JSON, which is YAML — the tests read it without a parser) and `scaffold.sh`, which runs
`lib/bed.mjs <scenario>` in a fresh directory: the simulation bed (two small repos, the fixture tracker, a `tiers.json`
naming one model) plus the work-directory state the scenario needs, made by the pipeline's own scripts:

| scenario | state |
|---|---|
| `empty` | the bed alone |
| `picked-up` | DEMO-4 as `/tp:start-ticket` leaves it: `ticket.json`, `ticket.md`, `progress.md`, a worktree on a fix branch |
| `stopped` | picked up, then triage stopped with a question |
| `in-run` | picked up, with a live run lock — a call made now is part of a run, so the guard hooks apply |

Graders are deterministic: `regex` over the last message, the trace or a file, `tool_used`, `tool_order`, `file_exists`.
An `llm` grader is for a short judgment only and is not used in the smoke set.

| case | what it proves |
|---|---|
| `status-one-ticket` | `/tp:status` reads the work directory through the state script and names the ticket and its next stage |
| `inbox-stopped-ticket` | `/tp:inbox` lists the open stop with its question and the stage that waits |
| `raw-write-then-put` | a raw write of a stage's JSON is refused by a hook that names `state.mjs put`; the agent follows it, and the file is valid and stamped |
| `no-verify-refused` | while a run lock is live, `git commit --no-verify` is refused |
| `plan-checker-read-only` | a `tp:plan-checker` asked to commit does not: its definition says so and, if it tried, the role policy refuses the git |
| `researcher-needs-allowlist` | the researcher reads no site until `tiers.json` `research.allow` names one |

## What an eval cannot reach

The runtime asks a person before a file tool (Write, Edit) writes anywhere below a `.claude` folder, and nothing but a
person at the prompt — or its bypass mode — answers: not a permission rule, not a hook, not accept-edits. A run under
`claude plugin eval` is not interactive, so a case cannot have the agent write a work-directory *document* or edit a
*worktree* (both live under `<.claude>/work/`); the state script's writes (`put`, `log`, `lock`) are the script writing, not
a file tool, and work. The stages that write documents and code (triage, plan, implement…) are exercised end to end
by hand, in the simulation bed (`reference/using.md` § Using it, Simulation) in a session run with the runtime's bypass
mode, inside a scratch directory.

## Adding a case

1. A scenario the bed does not have yet goes in `lib/bed.mjs`, built with the scripts, never typed.
2. `mkdir evals/<name>`, copy a neighbour's `case.yaml` and `scaffold.sh`, change the prompt, the graders and the tools it grants.
3. A grader names what must be true, not how the agent got there; grant the tools a grader needs (a `file_exists` needs one that creates files).
4. `node --test tests/evals.test.mjs`, then one run: `--case <name> --runs 1`.
