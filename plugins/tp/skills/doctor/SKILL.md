---
name: doctor
description: Runs the preflight: whether this install can run a ticket right now — node, git, remotes, the hosting CLI, the tracker, the active skills, each repo's gate hooks and generated code, the config files, the allowlist, the work directory, the plugin's hooks — with a fix for each failing check. Use before a run or when something fails.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`) · `<skill>` = `${CLAUDE_SKILL_DIR}` (this skill's folder, where the `instructions/` and `examples/` files named below are). Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

Catch the environment failure before the run does. Every check here is something a
stage would otherwise hit mid-task and hand up as an `error:` stop (`reference/failures-and-stops.md`
§ Failures and escalation) — a key not loaded, a CLI logged out, an allowlist rule
missing, a stray file at the work root. The script does the checks that need no
tool; this skill adds the one that does (the tracker) and relays the table. It runs **in the invoking context** — no agent is
spawned to run a script and print its table (`reference/definitions.md` § Definitions, Dedicated agent).

## Input

- No argument → the full preflight, written to `<.claude>/work/_doctor.json`.
- `repos=<path,path>` → the checkouts to check (default: the ones tickets recorded,
  else the git checkouts around `<.claude>`).
- `tests=true` → also run the pipeline's own tests (`node --test`).
- `session=<model>` → the model the invoking context runs on, as the runtime names it;
  the script warns when it, or the model the project's settings start a session on, is
  above the ceiling (`reference/models-and-budget.md` § Models and budget, The ceiling). Absent → only
  the starting model is checked.
- `answers=retry` — after fixing what an error stop named (§ Stops).

## Steps

### 1. The script
`node <lib>/doctor.mjs run <.claude> [--repos …] [--tests] [--session <model>]` — exit 0
clean, 1 with warnings, 2 with failures; the JSON is the table. Its checks and the
fix per line are the script's header; `tiers.json.doctor.checks` names the
project's own commands (the hosting CLI's auth status — reference/using.md § Install, step 2).

### 2. The tracker
A fixture tracker (`<.claude>/tracker.json`) is answered by the script — its `tracker` row —
and there is nothing more to do here. Otherwise it is the one check a script cannot make:
one read through the connected tracker (§ Definitions, Tracker) in the project's scope — the scope `/tp:plan-day` uses (`plan-day/instructions/
selection.md` § Scope) — made here (no sub-agent for one call). Reachable and answering → `node <lib>/doctor.mjs add <.claude>
'{ "name": "tracker", "status": "ok", "detail": "<tool> returned <n> ticket(s) for <scope>" }'` — the detail carries the evidence, not a bare ok;
no tracker tool connected, or the read failing → `status: "fail"` with the exact
message and the fix (connect the tool, log in, name the scope).

### 3. Report
`node <lib>/doctor.mjs table <.claude>` prints the table — `| check | status | detail | fix |`, failures first — and the one
line `preflight: ok | <n> warning(s) | <m> failure(s) — <at>`, including the tracker row added in step 2; exit 0 clean,
1 warnings, 2 failures. Relay it. A failure is an error stop (§ Failures and escalation): the error form with `needs:` =
the fix lines, resume `/tp:doctor answers=retry`; `/tp:plan-day` and `/tp:run-ticket` relay it as theirs before any run.

## When it runs by itself
`/tp:plan-day` and `/tp:run-ticket` ask `node <lib>/doctor.mjs fresh
<.claude>` before a run — the rule and the exit codes are `reference/using.md` § Using
it, Preflight, which this skill's `fresh` command implements
(`tiers.json.doctor.maxAgeHours`, 24). A warning never blocks a run; it is listed in
the office's doctor chip and here.

## Stops
`error: …` — one or more checks failed (the table's fix lines are `needs`), or the
script itself refused the directory: `answers=retry` once the person has done what
`needs` names. Never a question: every line here is a fact with a fix.
