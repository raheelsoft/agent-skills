# Context management

The rules that keep an agent inside its context and the run inside its budget of agents.

**Contents** — [Context management](#context-management--rules-every-skill-follows) (rules 1–12)

## Context management — rules every skill follows

1. **The invoking context holds only reports** (Output contract).
2. **Fresh agents where independence matters**: planning, checking, implementing and
   reviewing each run in an agent that did not do the previous one.
3. **Self-contained prompts**: absolute paths (work directory, worktree, conventions
   file), the branch and base, the constraints (§ Verification rules), the commit
   convention and any attribution trailer the session specifies — passed down every
   spawn — the exact commands, and the output contract. The agent remembers nothing
   else — and **a sub-agent never opens this file**: the rules it must follow (the
   output contract's two lines, the commit convention, the verification rules that
   apply, the join/leave commands) are in its prompt as text, never as a "§" reference
   it would have to go and read; only a skill's dedicated agent reads the reference, and
   only by reference (rule 10). A sub-agent sent to look a rule up pays a whole
   agent's overhead to read what its prompt could have carried in two lines.
4. **Parallel where independent — and no agent for a job that needs none**: the
   gates as background processes from one shell call (`/tp:verify`), the blockers' and
   candidates' states as one batch of tracker calls in one message, discovery areas,
   the gates alongside diff validation — one batch, results assembled once. A command's
   result or a tracker row needs no judgment: the agent that needs it runs the command
   or the call itself and keeps the excerpt; an agent is spawned for a lookup only
   when a description must be read to answer it.
5. **Judgment stays in the skill's dedicated agent**, not in its sub-agents: intent,
   unexpected diffs, conflict resolution, the decision to merge. What only the person
   can decide goes back as a stop.
6. **Ask only when the files can't answer** — and record the answer in `answers.md`
   so no stage asks twice.
7. **Checkpoint and continue — compaction at every level, where the task needs it.**
   Every agent that works in steps asks, at each step boundary and never mid-edit,
   `node <lib>/model.mjs compact '{ rating, used, stepsLeft,
   stepsTotal, nextStep: { bytes }, handoffs, claudeDir }'`. `used` is the agent's own
   running estimate of what its context holds — the prompt it was given, every tool
   result it took in (characters ÷ 4), its own output — because the runtime's usage
   reading shows the session's window, not an agent's. The answer is `continue`,
   `checkpoint`, `finish` or `stop`, and the point at which it turns to `checkpoint`
   is derived, not fixed: the reserve the checkpoint and report need, what one step of
   that rating takes in, the size of the next read and a safety margin that grows with
   the rating — so a `low` task runs to ~87 % of its window, `medium` hands off near
   80 %, `high` near 68 %, a step that must read a large file earlier still
   (`tiers.json.compact` tunes every number). On `checkpoint` the agent writes
   `checkpoint.<stage>[.<repo>].md` — what is done with commits and files; decisions
   and why; what remains, next step first; open questions; hand-offs so far (this one
   included); for a `high` task also the alternatives rejected and the checks already
   passed — logs `note "checkpoint — <next step>"`, and returns `continue: <path>`.
   The spawner re-spawns the same work with `continue=true` (§ Definitions, Dedicated
   agent); the new agent reads only the checkpoint and the files it names, counts them
   as its starting `used`, takes the hand-off count from it, and goes on. `stop` — the hand-off cap
   for the rating (`low` 2, `medium` 4, `high` 6, never more than the step count) is
   spent — is logged `stopped "hand-off budget spent — <next step>"`; `answers=continue`
   grants one more. Skills without a work directory checkpoint under
   `<.claude>/work/_scratch/<skill>-<slug>.md` and log nothing.

8. **Scope by stage — the criteria before the change, the diff after it.** Until
   something is implemented (triage, the plan, its check, the implementer's own
   reading) an agent's frontier is the ticket's acceptance criteria and the code they
   name: discovery is search by the ticket's nouns → the hits and their direct callers
   and callees, one level out — never a directory walk, never a module read end to
   end; the plan lists the files it touches and the checker verifies against exactly
   those and the criteria. Once there is a change (gates, diff validation, review,
   the merge, release smoke) the frontier is the change: `git diff <base>...HEAD` —
   names and hunks. A tool that takes a file list (lint, format, unit tests by file)
   runs on the changed files only; a whole-program tool (type check, build) runs once
   and its output, normalised, is diffed against the base's ("no new errors vs base" —
   a count is never the evidence); a reviewer, validator or describer reads the hunks
   and the lines around them, widening to the enclosing function or declaration, never
   to a file — and never the hunks of a **lockfile, a generated file** (an ORM client,
   API types, snapshots, build output, anything `.gitattributes` marks
   `linguist-generated`), **a binary or a vendored tree**: those are judged from
   `--stat` and their names, for consistency with their source (manifest ↔ lockfile,
   schema ↔ client, the generator's input changed with them); their hunks are never
   read, and a generated file's diff can be larger than every hand-written change in
   the branch put together. Acceptance's frontier is the criteria alone. Every prompt names its frontier —
   the criteria, the file list or the diff command — never "the repo". A project's
   conventions file and docs are read the same way: the headings first (`node
   <lib>/ref.mjs <file.md> list` works on any markdown file), then
   the sections the question at hand names (`ref.mjs <file.md> "<Section>"`) — a
   forty-kilobyte architecture document is never read end to end for one fact.
9. **One job per agent — and one agent per job.** Every spawned agent has one job —
   one output (its files, its command's result, its prose, its environment change) and
   the tool set that job needs — named in the first line of its prompt: assess, look
   up, write code, write prose (a description, a comment, a plan), operate an
   environment. The reading a job needs is part of it (a planner reads before it
   writes; an implementer's own plan for direct work is its notes). A skill's
   dedicated agent **does the skill's job itself** — it was spawned fresh for it
   (§ Definitions, Dedicated agent) — plus the coordination (the state, the spawns,
   the judgment of rule 5) and its own mechanical git, tracker and command calls; it
   spawns another agent only for what must be independent of it (a check of its plan,
   a review of its PR — rule 2), what must run under a narrower tool set (an operator
   on a shared environment), or what would otherwise fill its context with a reading
   it does not need afterwards (a whole-branch diff validated by a validator, the
   description of a branch nobody drafted one for, candidate tickets whose
   descriptions must be read) — and it writes what it already holds while it holds
   it (the implementer drafts the PR description with the change in its context,
   so no agent reads the whole diff again to describe it). Never for a command, a lookup or a line of prose it can
   write from what it already holds. Each agent gets exactly the tools its kind needs
   (§ Definitions, Tools and permissions).

   **An agent is not free before it starts.** Its prompt, its skill, the rules handed
   to it as text and the state it reads to orient itself cost the same whatever it
   then does — **75–130k tokens** for a stage agent of this pipeline, whether it plans
   a migration or watches a deploy run. The count of agents, not the work inside them,
   is what a run costs, so a stage runs **one agent for the whole
   ticket**, covering every repo in `ticket.json` order and writing each repo's
   artefacts and stage rows itself — `/tp:create-pr`, `/tp:merge` and `/tp:release` do,
   and `repo=` narrows them to one when a person or a fix round asks. The exception is
   `/tp:implement`, where the split is the whole point: an implementer holds one
   repo's code and nothing of the other's. Splitting a stage per repo to "keep
   contexts small" costs a floor to save a reading the agent would not have kept.
10. **Rules by reference, never the whole reference.** `reference/` — this file and its
    siblings, `README.md` first — is the one place every rule is stated: for people, end
    to end, and it is long. An agent reads only the sections and items the skill it runs
    names, through `node <lib>/ref.mjs "<Section>[, <Item>…]"` (`Definitions,
    Resume`; `Context management, rule 8`; `Models and budget, Estimates`; `Using it,
    Preflight`; `ref.mjs list` shows every name; a name is unique across the files, so
    the call never says which file) — never a file itself; a
    skill's own text arrives once, through the skill tool; an instructions file is
    read when the step that names it is reached, not before. Every spawn says so
    (§ Definitions, Dedicated agent).
11. **Command output by excerpt, never by stream.** A command whose output can exceed
    a screen — a dependency install, a build, a test run, a code generation, a deploy
    tool's run list or log, a platform API's object dump — never runs with its output
    into the agent's context: it writes to a file (`<command> > <file> 2>&1`, under
    `_scratch/` or the work directory) and the agent reads the lines it needs — the
    exit code, the summary line (`tail -3`), the first failing lines (`head -20`,
    `grep -n error`) — the way `/tp:verify` reads a gate. A platform CLI is asked for
    fields (`--json a,b`, `--jq`, `--exit-status`), never for a whole object or a
    whole log. An install or a test run streamed into an agent can cost more than
    the work the agent was spawned to do.

12. **Independent commands in one call.** What an agent costs is not the context it
    ends with but the sum of its turns: every tool call re-sends everything it holds,
    so ten commands taken one turn at a time cost about ten times what the same ten
    cost in one, and that is most of what rule 9's overhead is. Commands that do not
    consume each other's output go in a single call: the state read beside `git
    status`, a worktree per repo, the ticket beside its comments, the gates
    (`/tp:verify` already runs them as concurrent background processes). Only a
    command whose input is the previous one's output waits for it, and a command
    whose result decides whether the next should run at all — a lock, a blocked
    check, a gate before a push — is still taken on its own, because the answer is
    the point. The same holds for spawns: agents that do not feed each other are
    spawned in one message (§ Definitions, Depth).
