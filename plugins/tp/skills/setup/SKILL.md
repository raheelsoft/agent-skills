---
name: setup
description: Integrates the pipeline into a project through an interview: which skills to activate (by group, dependencies pulled in), the largest model the pipeline may use and the three tiers derived from it, the gates in git hooks; writes pipeline.json and tiers.json, prints the allowlist, ends with the preflight. Use on install, and again to change the selection or the ceiling.
user-invocable: true
disable-model-invocation: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`). Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

The integration interview — the first thing to run once the plugin is on in a project,
and the way to change the selection later. It runs **where it is invoked**
(`reference/definitions.md` § Definitions, Dedicated agent: its whole job is to ask the person
and run one script, so no agent is spawned for it). Nothing here touches a ticket, a repo
or the tracker, and nothing in the plugin: it writes `<.claude>/pipeline.json` and
`<.claude>/tiers.json` (and, when the person accepts step 3's offer, the `model` line of
`<.claude>/settings.local.json`). The skills belong to the plugin, which every project that
enables it shares, so a skill that is off is a record in `pipeline.json`, not a folder
moved. The catalogue — every skill, its group, what it needs, whether the interview
preselects it — is one place, `<lib>/setup.mjs`; the table in `reference/README.md` describes the
same skills.

## Input

- No argument → the interview (steps 1–4, with 3b and 3c).
- `all=true` → every skill, no question (an install that wants everything).
- `skills=<a,b,c>` → exactly these, plus what they need, no question.
- `ceiling=<model>` → the largest model the pipeline may use, without asking (step 3).
- `models=<low>,<medium>,<high>` → the three tiers named by hand, without asking (step 3).
- `session=<yes|no>` → answer step 3's second question without asking.
- `hooks=<yes|no|dry>` → answer step 3b's question without asking (`dry` prints the
  hooks it would write and writes nothing).
- `research=<domain,domain|none>` → the documentation sites the planning researcher may read,
  without asking (step 3c).
- `status` → what is on, what is off, and any problem (a dependency off, a name the
  plugin does not have) — `node <lib>/setup.mjs status <.claude>`; nothing changes.
- `migrate` → what is left of a copy of the pipeline kept in this project's own
  `.claude`: `node <lib>/setup.mjs migrate <.claude>` lists the folders to remove, the
  `tp-` keys in `pipeline.json`, the allow rules that name the copy and the `launch.json`
  entries that start the copy's office. Show the list; with the person's yes run it again
  with `--fix` (it rewrites only the keys of `pipeline.json` and those launch entries, to
  the plugin's office and this project's `work/`) and give the `rm` lines for the folders
  — never delete them yourself.
- `inline=true` — accepted and meaningless: this skill always runs where it is
  invoked.

## Steps

### 1. The catalogue
`node <lib>/setup.mjs list <.claude>` — the groups, each skill's
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
the pipeline without a way to run a ticket (`tp:run-ticket` off) is fine — the stage
skills still work one by one (§ Definitions, Entry points). `all=true` and `skills=`
skip the question.

### 3. The ceiling — the largest model the pipeline may use
The one decision that bounds every model the pipeline's agents run on (`reference/models-and-budget.md`
§ Models and budget, The ceiling). Ask it when `<.claude>/tiers.json` records no ceiling
(a first install) or the person asked to change it — and never from memory of which
models exist:

1. **The ladder** — the runtime's current models, smallest first: each family at its latest
   version, taken from the runtime's own list of its models and the names its spawn
   argument takes (aliases where it has them, so the ceiling follows the family).
   `node <lib>/model.mjs ceiling '{ "claudeDir": "<.claude>" }'` shows the
   one already recorded; on a re-run start from it and add what the runtime now offers.
2. **The questions**, in one call of the runtime's interactive question tool — *What is
   the largest model this pipeline may use?* (single choice: one option per model on the
   ladder, the four largest when there are more and the person can name another;
   labelled with the family and its latest version, each described by what the pipeline
   would then use — that model and every smaller one; preselected: the current ceiling,
   else the model this session runs on when it is on the ladder) and *Start this
   project's sessions on it?* (yes or no; yes preselected). The runtime's `model` setting
   is a session's starting model: the pipeline can set it, not enforce it.
3. **Write it** — `node <lib>/model.mjs tiers <.claude> ceiling=<model>
   ladder=<smallest>,…,<largest>` (`ladder=` is optional once one is recorded): the
   script derives the three tiers (`reference/models-and-budget.md` § Models and budget,
   The ceiling), refuses a ceiling that is
   not on the ladder, and keeps every other setting. On *yes*, `node
   <lib>/model.mjs pin <.claude>` writes `model` into
   `<.claude>/settings.local.json` — unless the person's own setting there is already
   within the ceiling, which stays.
4. **Say what it means** — the ceiling, the models the pipeline will use, the three tiers,
   and where this session stands (`model.mjs ceiling` with `session=<the model this
   context runs on>`: within it, or above it with `/model <ceiling>` as the fix).

`ceiling=` answers question one without asking; `models=` runs `model.mjs tiers <.claude>
low=… medium=… high=…` — the three tiers by hand, each on the recorded ladder at or below
the ceiling, which the script enforces (raise the ceiling first); `session=` answers
question two. A ceiling already
recorded and no request to change it → say which and go on.

### 3b. The gates in the repo's hooks
A gate the repo's own pre-commit or pre-push hook runs costs the pipeline nothing
(§ Verification rules, the hooks rule). Per repo (the git checkouts at or under the
folder that holds `<.claude>`): `node <lib>/hooks.mjs plan '{ repo,
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

### 3c. Documentation sites for research
Only when `tp:plan` is on. The planning researcher reads the codebase's own precedent first and,
for what that cannot answer, pages from the sites the project allows and no others
(`reference/definitions.md` § Definitions, Role agents). Ask once: *which documentation sites may
research read — domains such as `docs.example.com`, comma-separated, or none (the codebase
alone)? Default: none*. The answer goes in with `node <lib>/setup.mjs research <.claude>
allow=<domains|none>` (it merges into `tiers.json`'s `research`, refuses anything that is not a
host, and `maxFetches=<n>` sets the page budget, 8 by default); with no pair it reports what is
recorded, which is said and not asked again. Reading a page needs no permission rule: the plugin's
fetch hook allows exactly these hosts to the researcher, and nothing else.

### 4. Apply
`node <lib>/setup.mjs apply <.claude> '{ "skills": [<the selection>],
"by": "setup" }'` — `pipeline.json` written, and with it the deny rules for the skills that are off in
`<.claude>/settings.json` (it owns only `Skill(skill:tp:<name>)`; every other key and rule
stays); the result names what was added for a dependency and which rules changed. An
unreadable `settings.json` stops it before anything is written. `node <lib>/setup.mjs sync
<.claude>` regenerates the rules from the current `pipeline.json`. Then, in this order:
1. **The allowlist** — print the permission lines the selection needs (reference/using.md
   § Install, step 2): the scripts, `git` and `node --test` always, and the `Edit` line for this
   project's `<.claude>/worktrees/` (the absolute form); the hosting CLI's
   `pr`/`run`/`api` when `tp:create-pr`, `tp:merge`, `tp:review` or `tp:release` is on; the
   tracker's and chat tool's read tools by name when the tracker is real; the gate
   commands when `tp:verify` is on. The person adds them to the runtime's settings — a
   missing one is a prompt mid-run, never a failure.
2. **`.gitignore`** — the per-machine files (reference/using.md § Install, step 1), listed once.
3. **Notifications** — `tp:notify` on and `<.claude>/notify.json` missing → `/tp:notify
   setup` here (it, too, runs where invoked); off → nothing.
4. **The preflight** — `tp:doctor` on → `/tp:doctor` (its dedicated agent, this context as
   `parent`); its table closes the setup. Off → say that no preflight will run before
   a day or a ticket.

### 5. Report
The groups with each skill on or off; what was added and for whom; the ceiling, the
models the pipeline will use and where the session stands; the hooks per repo (written, skipped, or the gates left to the pipeline) and the reminder
that they are an uncommitted change in that repo; the files written (`pipeline.json`,
`tiers.json`, `notify.json`, and `settings.local.json` when the session was pinned); the allowlist lines; the doctor's line; the next step (`/tp:run-ticket <id>` or `/tp:plan-day`, or the stage skills
one by one); and how to change the selection later (`/tp:setup` again — `setup status`
shows it).

## Stops
None for a question — this skill asks directly. `error: …` when the script refuses
(an unknown skill name): the message names the fix; run again afterwards.
