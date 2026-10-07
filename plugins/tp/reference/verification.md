# Verification rules

Gates, hooks, generated code and the checks every stage and agent holds to.

**Contents** — [Verification rules](#verification-rules--every-stage-every-agent) (gates the repo's own hooks run, the pipeline does not · a gate result is a fact about two commits, computed once · a claim about the codebase is a check, not a recollection · the plugin's hooks)

## Verification rules — every stage, every agent

- Gates are the project's own commands run through `/tp:verify base=<base branch>` in the
  worktree; a failing gate is fixed in the change, never by weakening the check; a stop
  only when the fix would change the approach. After implementation they run on the
  change (§ Context management, rule 8).
- **Gates the repo's own hooks run, the pipeline does not.** A pre-commit or pre-push
  hook is the cheapest gate there is: it runs in the person's own tooling, it fails the
  commit or the push, and the agent learns it from an exit code it was already reading —
  no agent, no baseline, no second pass. `node <lib>/hooks.mjs cover '{
  repo, claudeDir }'` says which gates a repo's hooks own and at what scope — for hooks
  written by anything: Husky, a plain `.git/hooks` script, `lefthook`, Python's
  `pre-commit` framework, whatever `core.hooksPath` points at. A command the hook runs
  over the **whole project** (`make typecheck`, `cargo check`) covers that gate; one
  driven by the commit's files (`lint-staged`, `pre-commit`) covers **lint and format
  only**, because
  those are file-scoped anyway (rule 8) while a type check or a build is not. `/tp:verify`
  asks first and reports each covered gate as `HOOK` — the hook, its command, when it
  ran — and runs only the rest; the recorded result carries those rows, so a later stage
  reusing it sees the same table. **A hook failure is a gate failure**: the commit or
  the push did not happen, the output goes to a file and is read by excerpt (rule 11),
  and it is fixed in the change like any gate — never with `--no-verify`, never by
  editing the hook (§ Commits). The hooks are the project's: `/tp:setup` offers to write
  them from the project's own commands (`hooks.mjs plan`/`install` → `.husky/<hook>`,
  `tiers.json.hooks.plan` says which gate goes in which hook), never invents a command
  for a gate the project does not define, and never replaces a hook the project already
  wrote. By default lint and format go to **pre-commit**, types and tests to
  **pre-push** — a build stays with the pipeline unless the project's is quick.
  **Every ecosystem, every OS**: the gate commands come from `hooks.mjs gates`, the one
  resolver `/tp:verify` also uses (`tiers.json.hooks.commands` → the project's own target,
  in whatever runner it uses → the ecosystem's own command for the toolchain it
  configures), and the hooks are POSIX `sh` with LF endings, which is what git runs on
  Linux, macOS and Windows alike. A command that *rewrites* files (`--fix`, `--write`,
  `black`, `gofmt -w`) must not go into a commit hook as it stands — the commit would
  not contain what it rewrote — so `plan` uses its **check-only** form (`prettier
  --check`, `cargo fmt --check`, `gofmt -l`), or the project's staged-files runner when
  it has one (`lint-staged`, `pre-commit`, `lefthook`), and warns instead of writing
  when neither exists. `tiers.json.hooks.trust: false` makes the pipeline gate everything itself
  again (an audit), and `/tp:verify full=true` does it for one run. A repo without hooks
  loses nothing: every gate runs as before.
- **A gate result is a fact about two commits, computed once.** `/tp:verify` records every
  complete run of a clean checkout per (head, base) commit pair — `node
  <lib>/gates.mjs result put` — and every invoker asks before
  spawning it: `node <lib>/gates.mjs result get '{ repo, head, base,
  checkout, claudeDir }'` (exit 0: the record, and the checkout is clean at that
  head) is the gate table — the same run's evidence, keyed by the commits and checked
  against the checkout, not anyone's claim — and `/tp:verify` is not invoked. So the
  gates run once per pushed commit, in `/tp:create-pr`; `/tp:review` reads that record
  instead of running them again in a checkout of its own; a `/tp:create-pr` whose sync
  moved nothing reuses `/tp:implement`'s. The base's whole-program outputs (type check,
  build) are cached per base commit (`gates.mjs cache`) from one persistent
  **baseline** checkout per repo (`gates.mjs base` → `_scratch/wt/base-<repo-name>`,
  created once, moved to the base's head, dependencies re-installed only when a
  lockfile changed) — never a fresh checkout per call — and the gates themselves run
  as background processes, never as agents (§ Context management, rule 4).
- Don't start servers, emulators or a browser to verify unless the person asks or
  agrees. Check what already runs directly (a request, the CLI) and hand the person
  numbered manual steps for the rest.
- Anything that mutates shared state (a database, seeds, migrations, shared config)
  is verified on a disposable copy, never the person's working one — `/tp:verify
  tests=true` included; how to make the copy is the project's docs' call. The one
  sanctioned mutation of a shared environment is an operator follow-up the project's
  docs prescribe after a merge, run by `/tp:release` under the person's standing
  authorisation and recorded with the doc line and the instruction that authorised it.
  `/tp:accept` is read-only on a live environment, and its evidence carries no personal
  data.
- **A claim about the codebase is a check, not a recollection.** Code comments, PR
  descriptions and review findings constantly assert things wider than the diff — "the
  only caller", "every card with a header", "N such uses", "this selector is (0,2,0)".
  Each one is settled by a command at the moment it is written, or it is not written:
  state the reason the change is right and leave the census to whoever needs it. Counts
  and per-site tallies are the worst of them — cheap to re-derive, stale at the next
  merge, and a reviewer who takes one on trust inherits the error. A search is evidence
  only when its pattern can see what it claims to count: a fixed-window lookback for an
  enclosing element misses a multi-line opening tag, `\b` treats `-` as a word boundary
  so `foo` matches `foo-bar`, and a `--include` glob needs quoting under zsh. Where a
  number does earn its place, it carries the command that produced it.
- "Delivered" means a check proved it — a gate, a test, a request, a query.
- **The plugin's hooks** (`hooks/hooks.json`) are the rules that must hold every time,
  moved out of the model: each runs `hooks/run.mjs <handler>` in exec form, decides from
  files and the payload alone — never from a model — and is silent in a project the
  pipeline is not configured for. A hook that crashes lets the action through with a note
  on stderr (a hook must never break a session); only a handler's own `block` or `deny`
  stops anything. A skill's text states a rule once and says which hook enforces it; it
  does not ask the agent to remember it. Today:
  - `off-skill` — a typed `/tp:<skill>` that `pipeline.json` turned off is refused before the
    model sees it, at no token cost.
  - `bash` (PreToolUse) — in a run (a sub-agent's call, a call in a ticket's work directory, or
    while a run lock is live) refuses `--no-verify`, a plain force-push (`--force-with-lease`
    after a rebase is fine), a changed remote URL and a write to the shell's, ssh's, git's or
    cloud configuration; anywhere, refuses a raw write to a file the state script owns (the
    stage JSON, `progress.md`, `lock.json`) and says which `state.mjs` command writes it; and
    lets a bare `node <plugin>/lib|office|hooks/<script> …` call through without a permission
    rule, so the allowlist need not name the plugin's versioned folder (a command with
    anything in front of or after it — `export PATH=…;`, a pipe — goes through the rules).
  - `write` (PreToolUse on Write, Edit, MultiEdit) — the same refusal of a raw write to those
    files, for the file tools.
  - `agent-ceiling` (PreToolUse on Agent) — a sub-agent asked for a model above `tiers.json`'s
    ceiling runs on the ceiling instead, every other field of the spawn kept.
  - `model-switch` (PreModelSwitch) — a session switch to a model above the ceiling asks the
    person first, and is refused while a run holds a lock.
  - `session-start` (SessionStart) — writes `work/_heartbeat.json` (`/tp:doctor` warns when
    it is missing or old: a hook that fails open is otherwise silent) and tells the session,
    in at most five lines, the open stops and the live runs.

  The write guards stand down while a copy of the pipeline's skills (`skills/tp-*`) is still
  in the project's own `.claude`: those skills write the files by hand
  (`/tp:setup migrate` removes the copy).
