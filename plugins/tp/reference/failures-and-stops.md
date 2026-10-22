# Stops and failures

How a stage stops, notifies, auto-resolves a failure within a bound and hands up without losing work.

## Stops and notifications

Every stop — a stage's `stopped`, a derived wait, a usage pause, a lock held
elsewhere — ends the running agent in this order: release the lock (`unlock`; not when
the stop *is* another owner's live lock), `/tp:notify "<ticket> · <stage> · <the
question> <link>" level=stop` (one message, sent by the stopping agent itself — `/tp:notify`
spawns no agent, § Definitions, Dedicated agent; a silent no-op without a chat tool or
with `/tp:notify` off, § Definitions, Active skills; its one-line result goes in the
report), then return the question as the report; the
invoking context interviews the person with it, or prints it where it cannot
(§ Definitions, Asking the user). An error stop — `stopped "error: …"`, a problem from
the state script included — ends the agent in the same order with `level=error` and
the error form as the report (§ Failures and escalation). The outermost runner does
the notifying — `/tp:run-ticket`'s orchestrator, or the unattended runner's stage agent
— so a run sends one message per stop; a stage skill run by hand sends none, except
the stages an entry point runs through `/tp:run-ticket`, which notify as a run. The end
of a run is `level=done` with the outcome and the PR; a run that ends early at
`until=` sends no message. A stop question names what to decide and where to look (`doc` — § Definitions,
Asking the user) — never data, secrets or code.

## Failures and escalation — auto-resolve first, hand up without losing work

Every agent, at every level, treats a failure as its own problem before it becomes
anyone else's, and never lets work be lost when it cannot solve it.

1. **Classify, then auto-resolve within a bound.** `node <lib>/model.mjs
   retry '{ rating, kind, attempts, claudeDir }'` says what the failure gets — the bound
   is `tiers.json.retries` by the task's rating (`low` 1, `medium` 2, `high` 3):
   - *transient* (a network error, 429/5xx, a busy resource, a flaky command) → retry
     with backoff up to the bound;
   - *environment* (a missing tool, expired auth) → the documented alternative once
     (§ Remote access failures, § Toolchain: another tool, the platform's CLI, the nvm
     path) — never a change to credentials, remotes or shell config — then escalate;
   - *logic* (the agent's own mistake, a failing checkpoint, a gate its change broke) →
     fix and re-run up to the bound;
   - *usage* → the usage pause (§ Models and budget), never a retry;
   - *decision* — a question, a choice only the person can make, a permission the
     runtime asks for (the agent waits on the prompt; denied → a stop naming the
     action, never another route) → not a failure but a stop, at once (3 below).
2. **Escalate without losing work.** When the bound is spent: write the checkpoint
   (§ Context management, rule 7 — `checkpoint.<stage>[.<repo>].md`, or
   `_scratch/<skill>-<slug>.md` plus the `.stop.json` beside it for a skill without a
   work directory, § Work directory); log `stopped
   "error: <what failed> — <what a person must do> — resume: <the invocation>"` on the
   stage when there is one (the state shows it as waiting, `/tp:status` and the office
   show it; `answers=retry` resumes it once the person has done what `needs` names);
   then return the **error form** instead of the report:
   ```
   error: <what failed, one line, the exact message>
   tried: <the auto-resolve attempts — retries, the fallback>
   state: <checkpoint path | nothing written>
   resume: <the exact invocation that continues from there — the same arguments plus answers=retry, or continue=true when no answer is needed>
   needs: none | <what a person must fix or decide first>
   complexity: as rated | higher — <reason>
   continue: <checkpoint path>
   ```
   The spawner — the coordinator of that agent — acts on it as § Definitions,
   Dedicated agent says: a dead or transiently failed child once more from its
   checkpoint, anything else upward **unchanged** with one line added — its own stage
   or agent id — after writing its own checkpoint, so every level can resume and the
   top shows one chain (`run-ticket › implement:api › implementer: error …`) with one
   resume command. An orchestrator ends as § Stops and notifications says, with
   `level=error` and the chain: unlock, notify, office `gone` for the child that died,
   `stopped` for itself.
3. **Human input travels up, the answer travels down.** An agent that needs a person
   — a decision, an answer, a permission — stops (§ Definitions, Asking the user): it
   writes its checkpoint and returns the question with its stage or id; every spawner
   relays it upward unchanged, prefixing only its own stage or agent id, until the
   session puts it to the person (the interview). The answer comes back as `answers=`
   on the top-level command, and each level hands it down to the agent that stopped —
   re-spawned with the same arguments and the answer, resuming from its checkpoint
   (Resume) — so nothing is redone. Nobody assumes a yes, guesses an answer or works
   around a permission, at any level.
