# Definitions

The vocabulary every skill shares: entry points, resume, the output contract, the dedicated agent, depth, asking the user, tools and permissions.

**Contents** — [Definitions](#definitions) (conventions file · tracker · active skills · base branch · <.claude> · <plugin>, <lib> · repo name · runtime notes · tools and permissions · dedicated agent · role agents · output contract · office presence · depth · asking the user · common arguments · entry points · resume · review verdicts · the scripts)

## Definitions

- **Conventions file** — per repo, the first that exists of `AGENTS.md`,
  `CONTRIBUTING.md`, `CLAUDE.md`. None → the repo's git history and the tracker's
  existing tickets are the convention.
- **Tracker** — where the tickets live. First look at `<.claude>/tracker.json`: when it
  says `{ "kind": "fixture", "path": "<abs>", "command": "node <lib>/tracker.mjs" }` the tracker is the
  file-backed one, which that `command` runs (`get`, `list`, `save`, `comment`, `create`,
  `iterations`, `labels`, `states`, `me`), whose commands are the same reads and
  writes the skills make against a real one (§ Using it, Simulation), and no connected
  tool is touched; with no such file it is the connected tracker tool, found by name
  with the runtime's tool lookup (Runtime notes). Every skill
  that reads or writes a ticket, a relation, a comment, an iteration or a label
  means this definition by "the tracker"; a fixture ticket's link is
  `fixture://<id>`.
- **Hosting platform** — where the repos' remotes, pull requests and pipeline runs live.
  First look at `<.claude>/hosting.json`: when it says `{ "kind": "fixture", "path": "<abs>", "command":
  "node <lib>/hosting.mjs" }` the platform is the file-backed one, which that `command` runs (`pr create|view|list|comment|edit|diff|merge|close|checks`,
  `run list`, `me`, with `gh`'s flags and JSON field names), over the repos' own remotes — a pull
  request is real git: its head branch must be on the remote, a merge writes a merge commit
  into it — and no connected CLI is touched (§ Using it, Simulation); with no such file it is
  the connected platform's CLI or tool (`gh`, `glab`). Every skill that opens, reads, comments on
  or merges a pull request, or reads a pipeline run, means this definition by "the hosting
  platform"; a fixture pull request's link is `fixture://<repo>/pull/<n>`.
- **Active skills** — `<.claude>/pipeline.json` (`/tp:setup`; absent = everything on)
  says which skills this project uses; a skill that is off is not run — the plugin
  stays whole, because every project that enables it shares it. Three things read that
  one file: the state script skips the stage of an off skill, a generated deny rule
  (`Skill(skill:tp:<name>)`, in `<.claude>/settings.json`) stops the model from invoking
  it, and the plugin's `off-skill` hook stops the person from typing it (a deny rule
  does not). What depends on it adapts, and this is the one place it is said: the state script leaves the stage of an off `tp:merge`,
  `tp:release` or `tp:accept` out of a ticket's expected stages, so `next` skips it and a
  run ends at the last active stage (`/tp:run-ticket`'s close-out then removes the
  worktrees); `/tp:merge` without `/tp:review` stops for a person's review (its hand-off,
  case 3); `/tp:review` without `/tp:create-ticket` lists a pre-existing defect as
  *ticket needed*; `/tp:accept` without `/tp:release` walks the merged revision
  (`where=checkout`); `/tp:run-ticket` and `/tp:plan-day` without `/tp:doctor` run no
  preflight; `retro=true` without `/tp:retro` is noted and ignored; `/tp:notify` off sends
  nothing, exactly as without a chat tool; `/tp:schedule` needs `/tp:plan-day`, `/tp:inbox`
  and `/tp:eod`. The core stage skills are never off inside a run that starts.
- **Base branch** — the branch PRs in the repo target (the integration branch, not
  necessarily the remote default). Detected once per repo, recorded in `ticket.json`:
  conventions file → base of recent merged PRs → the remote's default; ask once if two
  candidates remain.
- **`<.claude>`** — the project's `.claude` directory (`${CLAUDE_PROJECT_DIR}/.claude`):
  its configuration, `work/` (the record, written by the state script) and `worktrees/` (the
  checkouts and command output — the one place below it an agent may write), resolved to an
  absolute path once; every path handed to an agent is absolute.
- **`<plugin>`, `<lib>`** — the plugin's own folder (`${CLAUDE_PLUGIN_ROOT}`, which moves
  when the plugin updates) and its `lib/`, where the scripts are; `<skill>` is a skill's
  own folder (`${CLAUDE_SKILL_DIR}`), where its `instructions/` and `examples/` are. A
  SKILL.md defines `<lib>`, `<.claude>` and, when it has files of its own, `<skill>` once, in
  its first line, because Claude Code substitutes the variables in a skill's body and not in
  the files it reads: those files say `<lib>` and mean that line's. A path the agent would
  otherwise have to find is a turn it pays for.
- **Repo name** — `basename(<repo path>)`, the key everywhere a repo is named:
  `worktrees/<id>/<name>`, `<file>.<name>.json`, `checkpoint.<stage>.<name>.md`, `repo=<name>`, and
  the stage names `implement:<name>` / `create-pr:<name>` / `merge:<name>` /
  `release:<name>` of a
  cross-repo ticket (single-repo tickets use the plain names; the script rejects the
  other form). The stages are `start-ticket`, `triage`, `plan`, `plan-check` (logged
  by `/tp:plan` around its checker), `implement`, `create-pr`, `merge`, `release`, `accept`, plus
  `run-ticket` and `retro` outside the sequence.
- **Runtime notes** — where runtime specifics are named. Skills are invoked with the
  runtime's skill tool (`skill: "<name>", args: "<id> key=value …"`); agents are
  spawned with its agent tool, each with an explicit `model`, as one of the runtime's
  two types: a *writing agent* (edit and shell, restricted to the files its job owns —
  a planner or checker that only reads the repo still writes its own output file, so
  it is one) or a *read-only agent* (read and search; a shell only to run the one
  command it reports on). The pipeline's jobs (§ Context management, rule 9) map onto
  them: assess, look up, run a command and report → read-only; write code, write
  prose, operate an environment → writing. Background mode is for work its spawner
  outlives — a run the session watches; a batch whose results the
  spawner needs before its next step (candidate fetches, a checker, a validator, an
  operator) is spawned in one message and awaited in the foreground,
  because an agent that ends its turn waiting on background children is not reliably
  woken when they finish. The session is the exception: the runtime wakes it for every
  background agent it started, so `/tp:run-ticket`'s orchestrators and `/tp:plan-day`'s runs
  are spawned from the session in the background. A person is reached only through
  the runtime's interactive question tool, and only from the session (Asking the
  user); a tool is found with the runtime's tool lookup; the account's usage windows
  come from its usage reading (percent used and reset time per window); a batch of
  tickets runs through its workflow-script tool. An agent's context is its prompt plus
  the files it is pointed at, nothing else; a skill flagged to fork the conversation is
  not isolation and is never used.
- **Tools and permissions** — every spawn names the tools its agent needs, and the
  agent loads them before its first step: the scripts (`node <lib>/…`),
  `git`, the hosting platform's CLI, the tracker's or chat tool's tools by name (found
  with the runtime's tool lookup), the usage reading. A read-only agent gets read and
  search tools (and the one command it runs); a writing agent edit and shell too; an
  agent that operates an environment the deploy and environment tools its follow-up
  names, nothing else. An agent never finds out mid-task that it lacks a tool: a tool
  missing from the environment is an *environment* failure (§ Failures and escalation)
  reported before any work — and `/tp:doctor` (§ Using it, Preflight) is where the
  install-wide ones are caught before a run. The runtime's permission allowlist covers the pipeline's
  own commands so no agent waits on a prompt for them (§ Install, step 2); anything
  outside it is asked for through the runtime's prompt and is a stop when denied —
  never worked around.
- **Dedicated agent** — every skill runs in its own fresh writing agent, whoever
  invokes it. An invocation without `inline=true` spawns that agent — one per ticket
  for `/tp:run-ticket` — with the prompt *Dedicated agent for `/<skill>`. Working
  directory `<absolute path>`. Office id `<id>`, parent `<id|none>`: first `state.mjs
  agent join <.claude>/work '{ "id", "level", "role", "stage", "ticket", "repo",
  "parent", "rating" }'`, last `state.mjs agent leave <.claude>/work <id> <done|stopped|gone>`.
  Invoke the `<skill>` skill with the skill tool, args: `<the same arguments>
  inline=true`. Read the reference by section only — `node
  <lib>/ref.mjs "<Section>[, <Item>…]"` for what the skill
  names, never the file — and long command output by excerpt, from a file (§ Context
  management, rules 10 and 11), and take commands that do not feed each other in one
  call rather than one turn each (rule 12). Return only its report* — on
  the model `model.mjs pick` gives for the
  rating the skill names in its `inline=true` line, after the budget check — and then
  acts on the report alone, by its first line and its last two: an `error:` form or a
  question → relayed upward unchanged, prefixed with the spawner's own stage or agent
  id (§ Failures and escalation; in the session a question becomes the interview,
  Asking the user); nothing returned, or a transient error → re-spawned once with
  `continue=true`; `continue: <checkpoint path>` → re-spawned with the same arguments
  plus `continue=true`; `complexity: higher` → re-spawned with `tier=<next rating>
  continue=true` (§ Models and budget, Escalation); otherwise the report is relayed as
  it is. `inline=true` is passed only by that spawn, by the unattended runner's stage
  agents, by an entry point's `/tp:run-ticket … until=… inline=true` (Entry points) and
  by an agent that cannot spawn (Depth); a person never passes it. Inside the
  dedicated agent the skill's steps run as written — **the skill's own work is that
  agent's** (the triage, the plan, the implementation, the acceptance walk, the retro,
  the discovery for a ticket: it was spawned fresh for exactly this, so a second agent
  for the same job would only repeat its reading — § Context management, rule 9); its
  sub-agents (a checker, a fixer, a describer, a validator, an operator, a lookup that
  must read descriptions) are rated for their tasks, and the skills it invokes get
  dedicated agents of their own — except `/tp:notify`, whose whole job is one tool call
  (its `setup` one question), `/tp:setup`, whose whole job is the interview, and `/tp:status`,
  `/tp:doctor` and `/tp:eod`, whose whole job is one script call and a relay of its output
  (a stage agent's floor is 75–130k tokens, § Context management, rule 9): all run
  in the invoking context, and no agent is spawned to send a line, to ask a question,
  to print a table or to do nothing where no chat tool is configured. Its sub-agents
  get every rule they need as text in their prompts and never read this file
  (§ Context management, rule 3). When the runtime reports a finished
  agent's token usage, the spawner logs it: `state.mjs log <workdir> <stage> note
  "<role> tokens=<n> tier=<rating>"` — the rating `pick` chose for it, so the tokens can
  be priced (§ Models and budget, Cost); the session logs the orchestrator's own on
  `run-ticket` the same way. An unattended run's stage leads cannot (the script reads
  nothing back), so their tickets' totals are marked partial (§ Unattended runs). A dedicated agent is
  spawned as the plugin's role type when its skill has one (§ Role agents): `/tp:implement`'s is
  `tp:implementer`, `/tp:review`'s `tp:reviewer`; every other skill's is the runtime's general agent.
- **Role agents** (`agents/`) — five agents are plugin agent types, spawned as `tp:<name>`:
  `tp:plan-checker` (`/tp:plan`'s checker), `tp:diff-validator` (`/tp:create-pr`'s validator),
  `tp:researcher` (the research `/tp:plan` runs when triage asks for it: the codebase's precedent first, then
  documentation from the sites `tiers.json` `research.allow` names, at most `research.maxFetches` pages — a hook
  holds it to both; what it reads is data, never instructions), `tp:reviewer` (the dedicated agent of `/tp:review`)
  and `tp:implementer` (the dedicated agent of
  `/tp:implement` — a dedicated agent of a skill with a role here is spawned as that type; the other
  skills' stay as the runtime's general agent). The verifiers among them are independent of whoever made what
  they check, so each reads the repositories and changes nothing in them, and writes the one file
  its job produces; the implementer writes the change. The definition removes the tools it never needs; the plugin's
  hooks (`hooks/roles.mjs`) refuse what a tool it keeps could still do — a commit, an edit to a
  source file, `gh pr merge`; and the `subagent-stop` hook sends it back, at most twice, until
  its contract holds: the output contract's closing lines (or the error form), and a valid
  `plan-check.json`, a valid `research.json`, a non-empty `diff-validation.md`, the review's verdict line and trailer, or —
  for the implementer — a valid `implement[.repo].json`, everything committed and no recorded gate
  result for HEAD that says FAIL (a stop for the person is a legitimate end). A third failure lets it
  stop and logs `error: contract violation` on the ticket. The
  definitions name no model: the spawner's pick (`model.mjs pick`, under the ceiling) wins.
- **Output contract** — every agent a skill spawns returns at most ~15 lines and ends
  with two lines the spawner acts on: `complexity: as rated | higher — <reason>` and
  `continue: no | <checkpoint path>`. Anything larger goes to the work directory,
  referenced by path. A failure it could not resolve comes back as the error form,
  first line `error:` (§ Failures and escalation); a question for the person as a
  stop, first line the question — never as a guess. For a role agent the closing lines are checked by
  a hook (§ Role agents), not trusted.
- **Office presence** — every agent has a desk in the office (§ Observability). The
  spawner assigns the child's id and passes its own as `parent`; the child registers
  first and unregisters last (the template above; sub-agents get the two commands in
  their prompts). Ids: `<ticket>:<stage>:<level>[:<n>]` — the stage as `progress.md`
  names it where one agent runs one of them (`implement:api` on a cross-repo ticket);
  a stage whose agent covers every repo takes one desk under the bare stage name
  (`create-pr`, `merge`, `release`) while its per-repo rows stay in the ticket's
  record (§ Context management, rule 9), `n` whenever another agent of the
  run shares the same `<stage>:<level>` (a join with an existing id revives that
  record instead of adding one) — the orchestrator `<ticket>:run-ticket:manager`; a
  skill invoked by a stage gets an id under that stage (`<ticket>:create-pr:qa:verify`
  for the `/tp:verify` a `/tp:create-pr` runs); an agent with no ticket
  `<skill>:<slug>:<level>[:<n>]` (`plan-day:2026-09-19:lead`, `review:PR-12:reviewer`).
  The id is a label the office never parses: the record's own fields carry level,
  role, stage, repo, parent and rating. Levels: the orchestrator `manager`; a skill's dedicated
  agent `lead` (whatever it does itself — plan, implement, walk); a fixer, describer
  or operator `engineer`; a checker, diff validator or lookup (a candidate or blocker
  fetch that reads descriptions) `qa`; `/tp:review`'s agent `reviewer`. `role` is the
  free label (`implementer`, `fixer`, `checker`); `rating` the agent's. A child that
  returns nothing or errors is left `gone` by its spawner. The office derives the rest
  — a stage's stop or done, a departed parent, a ticket gone quiet — so a missed
  `leave` is a ghost for a while, not a lie.
- **Depth** — the session and the agents at the first two levels below it can spawn
  agents; an agent at the third level has no agent tool (measured, not assumed). An
  agent without it invokes the skills it needs with `inline=true` — it is their
  dedicated agent — and runs its own fan-out sequentially or as background processes
  (gates), or does the lookups itself (a discovery). What never collapses: the
  reviewer is never the author and the checker is never the planner — a `/tp:merge`
  agent that cannot spawn `/tp:review` stops with the PR URL, a `/tp:plan` agent that
  cannot spawn its checker stops with the plan, for the person.
- **Asking the user** — an agent cannot talk to the person, so "ask" in any skill
  means: log `stopped "<question>"` on its stage (once a work directory exists) and
  return the question as the report; the answer comes back as `answers=` on the next
  invocation. A question is phrased as a decision — its choices and, when there is
  one, the default (`… A, or B? Default: A`), numbered when there are several, the
  answer token when the stop defines one (Resume); a stop with nothing to decide (a
  blocked or cancelled ticket) says `nothing to answer — <what must happen first>`. A
  question a stage writes to its JSON (triage's `questions`) is a string, or the
  structured form `{ text, choices, default }` — the state script renders it as one
  line (`<text> — a | b? Default: a`, numbered when there are several) for the
  report, `/tp:status` and the office; nothing downstream ever sees an object. The state
  script classifies every stop it reports — `kind`: `question`, `approval`, `error`,
  `usage`, `blocked` or `problem` (an inconsistency the script found) — and names the
  command that continues the ticket (`resume`), the answer's default when the stop
  states one, and whether it can go on by itself (`resumable`: a usage pause past its
  reset, a blocked ticket whose blockers are resolved); the inbox (`state.mjs inbox`,
  `/tp:inbox`, the office) is that list for every ticket. An answer may also be **queued**
  for a stop — typed in the office, or `state.mjs answer <workroot> <id> <stage>
  '<text>'` — into `work/_inbox/`, naming the exact stop it answers; the next
  invocation of the stopped ticket takes it as its `answers=` (Resume), so nothing
  applies a stale answer to a later stop.
  The context that spawned the dedicated agent closes the loop: a session, where a
  person is present, does not print the stop and wait for a typed command — it puts
  the questions to the person with the runtime's interactive question tool (one item
  per question, the choices as its options with the default first and marked as such,
  free text through the tool's own "other" choice, a long list in batches; a
  `nothing to answer` stop is shown, not asked). **It shows what the question is
  about before it asks.** A stop carries `doc` — the file a person must read to
  answer it, relative to the work root (`<id>/plan.md` for a plan's approval or its
  open questions, `_day/<date>.md` for a day's) — and the session prints that file's
  contents in the conversation, as its own message, before putting the question. A
  question tool is a place to choose, not a place to read: its options are a line
  each, they do not scroll, and they are gone once answered — so a plan approved from
  the one-line question is a plan approved unseen, and a change request has no text in
  front of the person to quote back. The question itself stays one line whatever the
  document says (that line is what `/tp:status`, the office and `/tp:notify` carry);
  the document is shown beside it, never folded into it. Then the session re-invokes
  the same skill with the same arguments plus `answers="1: <answer> | 2: <answer> |
  …"` (a blank answer means the default) and relays what comes back. It prints the
  resume command — with the `doc` path beside it — instead only where nobody can be
  interviewed: a run whose starting session is gone (a schedule), a stop the person
  read through `/tp:notify`, a runtime without such a tool. Two waits are not logged but derived by the script from a stage's JSON (the
  list is with the `progress.md` grammar, § Work directory).
- **Common arguments** — every skill accepts `inline=true`, `tier=<low|medium|high>`
  (§ Models and budget: the minimum rating for every agent of this invocation, forwarded
  to every skill and sub-agent it spawns; `strong` is an alias of `high`) and
  `continue=true` (start from the checkpoint; ignored when there is none). Stage skills
  that can stop accept `answers=<text>` and `force=true` (Resume). A value arrives
  quoted from an unattended run (`answers="go-ahead"`); skills strip one layer of quotes
  before comparing.
- **Entry points** — every skill works on its own; nothing has to be run before it.
  A stage skill invoked on a ticket that is not yet at its stage — no work directory,
  or the state's `next` an earlier stage (pending, stopped or stale) — first brings
  the ticket there: inside its dedicated agent it invokes `/tp:run-ticket <id>
  until=<this stage> inline=true` with its own arguments (the orchestrator hands each
  to the stage it belongs to — `mode=` to triage, `repo=`, `update=`, `check-only=`,
  `promote=`, `where=`, `env=`, `merge=`, `answers=` — and `owner=` its own id). The
  orchestrator runs the missing stages *and this one*, each in its own dedicated
  agent; the outer agent runs none of its steps itself and returns the stage lines
  followed by the last stage's report. So `/tp:implement ABC-123` on a fresh ticket picks
  it up, triages, plans when triage asked for one (stopping for the plan's approval)
  and implements; `/tp:merge` on a
  branch without a PR opens one first; `/tp:accept` after a merge releases first. The
  stages run this way lock, stop and notify as a run does; a stop in an earlier stage
  is this invocation's stop, answered with `answers=` on the same skill (the channel
  setup of § Observability applies as to any entry point). A ticket already at or
  past the stage → the skill's own steps as
  written (Resume decides between run, resume and refuse). Skills without a stage take
  what they are given — `/tp:plan-day`, `/tp:create-ticket`, `/tp:create-pr` on a branch,
  `/tp:review`, `/tp:verify`, `/tp:status`, `/tp:notify`; `/tp:retro` needs a record and says so when
  there is none.
- **Resume** — one rule for every stage skill. Before logging `started`, read
  `state.mjs state <workdir>`. The ticket is `closed` (§ Work directory) → refuse
  unless `round=` above `ticket.json.round` or `force=true`. The stage is `done` and
  not stale → refuse (`already done; force=true to re-run` — re-running would stale
  everything after it) unless `force=true`, the invocation carries `round=` above
  `ticket.json.round`, or the skill defines a re-run of its own (`/tp:create-pr
  update=true`, a fix round `/tp:merge` asks for). The stage is `stopped` → with
  `answers=`, append the answer to `answers.md` (dated, with the question), then log
  `started` and resume at the stop — from its checkpoint when there is one, so
  `answers=` never needs `continue=true` beside it (`stopped.step` for an implementer,
  the step named in the checkpoint otherwise); without `answers=`, first `state.mjs
  answer <workroot> <id> --consume` — exit 0 hands back an answer queued for this
  exact stop (Asking the user), which is this invocation's `answers=`, recorded in
  `answers.md` with its source (`from the office`); otherwise return the stop
  again — except a usage pause (`stopped "usage at …"`), re-invoked after the reset by
  whoever invoked the paused skill (§ Work directory, the grammar), a blocked ticket
  (`kind: blocked`) whose blockers are all resolved (`unblocked`), which runs as if
  answered — `/tp:run-ticket` re-runs `/tp:start-ticket <id> force=true` first when a repo
  row says `discarded` — and an error stop
  (`stopped "error: …"`, § Failures and escalation), which resumes from its checkpoint
  with `answers=retry` once the person has done what the stop names. A wait the
  script derives (Asking the user) records the answer as a `note`; when the stage then
  re-runs its agent it logs `started` and `done` as usual (a go-ahead alone re-runs
  nothing). The stage is `in-progress` (an agent died) → log `started` and resume
  from the checkpoint or the last `note "step <n> done"`. `pending` or `done` and
  `answers=` given → append it to `answers.md` and do nothing else. Answer tokens: a
  soft-block, a take-over, a reopen, a designated review, a merge, a fix, a retry use
  the token the stop names — `continue`, `takeover`, `reopen`, `reviewed`, `merge`,
  `fix`, `retry`, `resume`, `go-ahead`, `round`, `leave`, `run`, `skip`, `keep`,
  `drop`, `split`, `pool`, `comment`, `create`, `ours`, `theirs`, `change`, each
  defined in its skill's § Stops — never a bare `yes` that would satisfy several.
- **Review verdicts** — `PASS`, `PASS WITH WARNINGS`, `BLOCK` (from `/tp:review`).
- **The scripts** — `<lib>/state.mjs` (`log`, `state`/`check` (`--brief`
  for a spawner's routing: the decision fields alone), `all`, `table` (the status board
  as text, below),
  `durations`, `usage` and `totals` (tokens and cost), `inbox` (every open stop),
  `answer` (queue or `--consume` an answer for a stop), `blockers` (record a re-check
  in `ticket.json.blockedBy`), `actual` (the person's hours), `put` (write a work-directory JSON after checking it against its
  schema), `doc` (write a work-directory document — the text on stdin or `--from` a draft;
  `--append` adds to the end), `lock`/`unlock`, `agent
  join|leave`, `office`: skills log
  through it and resume from it, never by re-reading `progress.md` and reasoning) and
  `<lib>/model.mjs`
  (`rate`, `budget`, `pick`, `rounds`, `compact`, `retry`, `estimate`, `tiers`, `ceiling`, `pin` —
  § Models and budget) and
  `<lib>/day.mjs` (`plan`, `advance`, `status` (the plan with live
  statuses, never written), `eod`, `show`, `lanes` — `/tp:plan-day`'s selection,
  ordering and lanes, the day's end) and `<lib>/gatesrun.mjs` (`'{ "repo", "path", "base", "claudeDir" }'` — reuse, hooks, generated code, every gate concurrently, the table and the record, in one call;
  `needs-agent` only when a gate fails or rewrites files) and `<lib>/gates.mjs` (`base`,
  `release`, `cache get|put`, `normalise`, `new`, `result get|put` — the gate
  baseline and the gate record, § Verification rules) and
  `<lib>/diffscan.mjs` (`'{ "repo", "range" | "base" }'` — the added lines of a diff that match a known bad pattern, and the files that
  should not be committed, as candidates with `file:line` and a priority hint; the review's mechanical scan) and `<lib>/branchfacts.mjs` (`'{ "repo", "base" }' [--fetch]` — a branch's git facts in one call: dirty files, commits ahead and behind,
  diff size, remote, whether it is pushed) and `<lib>/ref.mjs` (`"<Section>[, <Item>…]"`, `list` — the reference read by
  section, § Context management, rule 10), `<lib>/hooks.mjs`
  (`detect`, `cover`, `plan`, `install` — the repo's hooks as gate owners,
  § Verification rules), `<lib>/codegen.mjs` (`detect`, `status`,
  `mark` — generated code and whether it is behind its schema, § Toolchain) and
  `<lib>/validate.mjs` (`file`, `work`, `artifacts` — the work directory's JSON against its schemas,
  `schemas/README.md`), `<lib>/plan-lint.mjs` (`<workdir> [--no-fs] [--record]` — the mechanical half
  of the plan check, § Work directory), `<lib>/findings.mjs` (`check`, `verdict`, `render`, `row` — a review
  pass as JSON: the tier of each finding, the verdict, the PR comment and the `pr.json` row are derived,
  `schemas/README.md` § Reviews) and `<lib>/setup.mjs`
  (`list`, `check`, `apply`, `status`, `stages` — the catalogue of skills and their
  dependencies, the one place they are declared; § Definitions, Active skills). Every `model.mjs`, `day.mjs` and
  `gates.mjs` call carries `claudeDir: "<.claude>"` so `tiers.json` applies.

  `state.mjs table <workroot> [problems]` prints `/tp:status`'s board. Columns: ticket, title, `decision · rating`,
  `Estimate` (`<focusedHours>h · <days>d`, `*` when the pipeline made it, `actual <h>h` once `/tp:eod` recorded the person's hours),
  `Status` (`in-progress`, `stopped (<kind>)`, `closed`, `done`, `done · retro`, `error`), `Next / waiting on` (the stop's question and
  default, each blocker with its last recorded state, `answer queued (<by>, <when>)`, the closing reason, or the next stage), `Run`
  (the lock's owner and start, `stale` when the script says so), `PR · verdict · merged` (ending with `quality <open P0–P4 counts> · score <n>`
  from `quality.json`, `clean` when nothing is open), `Tokens · cost` (`+<m> unpriced` when `tiers.json` names no price, `partial`
  when the run said so — § Models and budget, Cost), the last event and the age. Below it: the totals line, the problems, the worktrees
  that done or closed tickets still hold with the command that removes each, and stale locks with their `unlock`.

  Also: `state.mjs route <id>` (what `/tp:run-ticket` does first with a ticket), `approve <id>` (a plan's go-ahead in its one shape),
  `retro-facts <id>`, `show <id>`, `inbox <root> --render`; `<lib>/coverage.mjs <workdir> --repo <name>` (is the plan implemented
  and every criterion proved: steps by their files in the diff, criteria by the check § Verification names for each);
  `<lib>/worktree.mjs add|rebranch|remove` (a ticket's worktree, install and generated code); `<lib>/ticketlint.mjs <draft>
  --repo <checkout>` (a ticket draft against the template); `<lib>/notify.mjs prepare <.claude> <level> "<text>"` (what a
  notification would send); `model.mjs triage '<evidence>'` (the triage rubric over the rows the agent judged);
  `findings.mjs next <review.json> <workdir>` (record a review pass, ask the loop, decide the merge).
