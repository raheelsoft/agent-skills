---
name: tp-doctor
description: Preflight: can this install run a ticket right now — node, git, remotes, the hosting CLI, the tracker, the active skills, each repo's gate hooks and generated code, the config files, the allowlist, the work directory — each failing check with its fix.
user_invocable: true
---

Catch the environment failure before the run does. Every check here is something a
stage would otherwise hit mid-task and hand up as an `error:` stop (`skills/README.md`
§ Failures and escalation) — a key not loaded, a CLI logged out, an allowlist rule
missing, a stray file at the work root. The script does the checks that need no
tool; this agent adds the one that does (the tracker) and reports the table.

## Input

- No argument → the full preflight, written to `<.claude>/work/_doctor.json`.
- `repos=<path,path>` → the checkouts to check (default: the ones tickets recorded,
  else the git checkouts around `<.claude>`).
- `tests=true` → also run the pipeline's own tests (`node --test`).
- `answers=retry` — after fixing what an error stop named (§ Stops).
- `inline=true` — `skills/README.md` § Definitions (Dedicated agent); this agent's
  rating: `low` (run a script, one lookup, format a table).

## Steps

### 0. Register
`state.mjs agent join <.claude>/work '{ "id": "doctor:<date>:lead", "level": "lead",
"role": "preflight", "stage": "doctor", "rating": "low" }'`.

### 1. The script
`node <.claude>/skills/_lib/doctor.mjs run <.claude> [--repos …] [--tests]` — exit 0
clean, 1 with warnings, 2 with failures; the JSON is the table. Its checks and the
fix per line are the script's header; `tiers.json.doctor.checks` names the
project's own commands (the hosting CLI's auth status — README § Install, step 2).

### 2. The tracker
The one check a script cannot make: one read through the tracker (§ Definitions,
Tracker) in the project's scope — the scope `/tp-plan-day` uses (`tp-plan-day/instructions/
selection.md` § Scope) — by this agent itself (a `low` lookup; no sub-agent for one
call). Reachable and answering → `node <.claude>/skills/_lib/doctor.mjs add <.claude>
'{ "name": "tracker", "status": "ok", "detail": "<tool> answered for <scope>" }'`;
no tracker tool connected, or the read failing → `status: "fail"` with the exact
message and the fix (connect the tool, log in, name the scope).

### 3. Report
The table — `| check | status | detail | fix |` — with the failures first, then the
one line `preflight: ok | <n> warning(s) | <m> failure(s) — <at>`. A failure is an
error stop (§ Failures and escalation): the error form with `needs:` = the fix lines,
resume `/tp-doctor answers=retry`; `/tp-plan-day` and `/tp-run-ticket` relay it as theirs
before any run. Then `state.mjs agent leave <.claude>/work doctor:<date>:lead done`
and the output contract lines.

## When it runs by itself
`/tp-plan-day` and `/tp-run-ticket` ask `node <.claude>/skills/_lib/doctor.mjs fresh
<.claude>` before a run — the rule and the exit codes are `skills/README.md` § Using
it, Preflight, which this skill's `fresh` command implements
(`tiers.json.doctor.maxAgeHours`, 24). A warning never blocks a run; it is listed in
the office's doctor chip and here.

## Stops
`error: …` — one or more checks failed (the table's fix lines are `needs`), or the
script itself refused the directory: `answers=retry` once the person has done what
`needs` names. Never a question: every line here is a fact with a fix.
