---
name: tp-setup
description: Integrate the pipeline into a project — an interview that picks which skills to activate (by group, dependencies pulled in), maps the runtime's models to the three tiers, offers to put the project's gates in its git hooks, writes pipeline.json and tiers.json, prints the allowlist, and ends with the preflight; run it again to change the selection.
user_invocable: true
---

The integration interview — the first thing to run after copying `skills/` into a
project's `.claude/`, and the way to change the selection later. It runs **where it
is invoked** (`skills/README.md` § Definitions, Dedicated agent: its whole job is to
ask the person and run one script, so no agent is spawned for it). Nothing here
touches a ticket, a repo or the tracker: it writes `<.claude>/pipeline.json` and
`<.claude>/tiers.json`, and moves the folders of skills that are off to
`<.claude>/skills/_off/` (kept, restorable). The catalogue — every skill, its group,
what it needs, whether the interview preselects it — is one place,
`<.claude>/skills/_lib/setup.mjs`; the README's table describes the same skills.

## Input

- No argument → the interview (steps 1–4).
- `all=true` → every skill, no question (an install that wants everything).
- `skills=<a,b,c>` → exactly these, plus what they need, no question.
- `models=<low>,<medium>,<high>` → `tiers.json` without asking.
- `hooks=<yes|no|dry>` → answer step 3b's question without asking (`dry` prints the
  hooks it would write and writes nothing).
- `status` → what is on, what is off, and any problem (an active skill whose folder
  is missing, a dependency off) — `node <.claude>/skills/_lib/setup.mjs status
  <.claude>`; nothing changes.
- `inline=true` — accepted and meaningless: this skill always runs where it is
  invoked.

## Steps

### 1. The catalogue
`node <.claude>/skills/_lib/setup.mjs list <.claude>` — the groups, each skill's
description (its own `SKILL.md`), what it needs (`requires`), whether it is on now,
whether its folder is present. A `pipeline.json` already there means a re-run: the
current selection is the preselection.

### 2. The interview — one question per group
With the runtime's interactive question tool, multi-select, one question per group in
the catalogue's order — the group's `why` as the question's context, each skill as an
option labelled with its name and described by its description, the preselected ones
the group's defaults (or the current selection on a re-run). Five questions, no more:
*ticket pipeline*, *review and merge*, *after the merge*, *the day*, *tooling*. A
skill someone leaves out that a selected skill needs is added by the script (step 4)
and the report says for whom (`merge needs review — added`); a selection that leaves
the pipeline without a way to run a ticket (`tp-run-ticket` off) is fine — the stage
skills still work one by one (§ Definitions, Entry points). `all=true` and `skills=`
skip the question.

### 3. The models
`<.claude>/tiers.json` without models (a first install) → ask once for the three model
names the runtime knows — a fast one, the standard one, the strongest — suggesting
the runtime's current family; then `node <.claude>/skills/_lib/model.mjs tiers
<.claude> low=<model> medium=<model> high=<model>` (the only place a model name is ever
written — § Models and budget). `models=` answers without asking; models already
mapped → say which and go on.

### 3b. The gates in the repo's hooks
A gate the repo's own pre-commit or pre-push hook runs costs the pipeline nothing
(§ Verification rules, the hooks rule). Per repo (the git checkouts at or under the
folder that holds `<.claude>`): `node <.claude>/skills/_lib/hooks.mjs plan '{ repo,
claudeDir }'`, then
- hooks already covering every planned gate → say which and ask nothing;
- otherwise one question per repo, with what would be written (`install … dry: true`
  gives the exact bodies) and what it cannot cover (`missing` — a gate the project
  defines no command for; never invented) and anything it warns about (`warnings` — a
  pre-commit command that rewrites files without `lint-staged`; nothing is written
  until that is resolved): *write them (yes), show me first (dry), or leave the hooks
  alone (no)? Default: yes*. `yes` → `hooks.mjs install '{ repo,
  claudeDir }'`; a hook the project already wrote is never replaced (the result's
  `skipped` says so — the person decides, `force` afterwards).
The files are the **project's**, in its repo: the report names them and says they are
an uncommitted change for the person to commit (or to take through a ticket), and that
`core.hooksPath` is per clone unless the project's `prepare` script sets it.

### 4. Apply
`node <.claude>/skills/_lib/setup.mjs apply <.claude> '{ "skills": [<the selection>],
"by": "setup" }'` — `pipeline.json` written, the folders of skills that are off moved
to `skills/_off/`, the folders of skills switched back on restored; the result names
what was added for a dependency. Then, in this order:
1. **The allowlist** — print the permission lines the selection needs (README
   § Install, step 2): the scripts, `git` and `node --test` always; the hosting CLI's
   `pr`/`run`/`api` when `tp-create-pr`, `tp-merge`, `tp-review` or `tp-release` is on; the
   tracker's and chat tool's read tools by name when the tracker is real; the gate
   commands when `tp-verify` is on. The person adds them to the runtime's settings — a
   missing one is a prompt mid-run, never a failure.
2. **`.gitignore`** — the per-machine files (README § Install, step 1), listed once.
3. **Notifications** — `tp-notify` on and `<.claude>/notify.json` missing → `/tp-notify
   setup` here (it, too, runs where invoked); off → nothing.
4. **The preflight** — `tp-doctor` on → `/tp-doctor` (its dedicated agent, this context as
   `parent`); its table closes the setup. Off → say that no preflight will run before
   a day or a ticket.

### 5. Report
The groups with each skill on or off; what was added and for whom; the models; the
hooks per repo (written, skipped, or the gates left to the pipeline) and the reminder
that they are an uncommitted change in that repo; the files written (`pipeline.json`,
`tiers.json`, `notify.json`); the allowlist lines; the doctor's line; the next step (`/tp-run-ticket <id>` or `/tp-plan-day`, or the stage skills
one by one); and how to change the selection later (`/tp-setup` again — `setup status`
shows it).

## Stops
None for a question — this skill asks directly. `error: …` when the script refuses
(an unknown skill name, a folder in both `skills/` and `skills/_off/`): the message
names the fix; run again afterwards.
