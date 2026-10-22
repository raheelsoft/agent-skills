---
name: notify
description: Sends one pipeline line (a stop, a finished run, an error) to the project's chat channel, silent without a chat tool; `setup` picks the tool and channel once. Use from a stage that stops, finishes or fails; it runs in the invoking context.
user-invocable: true
---

**Paths.** `<lib>` = `${CLAUDE_PLUGIN_ROOT}/lib` (this plugin's scripts) · `<.claude>` = `${CLAUDE_PROJECT_DIR}/.claude` (this project's configuration and `work/`). Start every command with `node <lib>/…` or `git`, the path written out in full — a `VAR=… ;` or `cd … &&` in front of it falls outside the permission allowlist and is denied in an unattended run.

The pipeline's outbound voice. Every stop and every finished run goes through here so
a person who isn't watching still hears about it; nothing else does. The message is one
line, the channel was chosen once for this project, and when the environment has no
chat tool the skill is a silent no-op — never an error, never a question. It is one
tool call, so it runs **in the invoking context** — the agent that stops sends its own
line; no agent is spawned to send it, or to do nothing (`reference/definitions.md`
§ Definitions, Dedicated agent — the one exception to the rule). Conventions:
§ Observability.

## Input

- `<text>` — the message: everything before the first `key=value` token, or a quoted
  string. Written by the caller as `<ticket> · <stage> · <what>` with the link that
  lets the reader act (the PR, the ticket, the work directory's question); no personal
  data (`reference/procedures.md` § Personal data).
- `level=stop|done|error|info` (optional, default `info`) — `stop`: a person must
  answer; `done`: a run finished; `error`: a run failed; `info`: anything else. Which
  levels are sent is the project's choice (`instructions/setup.md`); `stop`, `done` and `error` by
  default.
- `setup` (instead of a text) — the one-time configuration; `setup target=<channel>`
  sets or changes the channel without asking.
- `inline=true` — accepted and meaningless here: both forms always run where they are
  invoked (`reference/definitions.md` § Definitions, Dedicated agent) — a send because it is
  one tool call, `setup` because it may need to ask the person.

## The configuration
`<.claude>/notify.json`: `{ tool, target, project, levels, setAt }` — `tool: null` means no chat tool here, stay silent;
`target: null` with a tool means nobody has named the channel yet. `levels` defaults to `stop`, `done`, `error`. Its
shape, the one-time **setup** (find the tool, ask for the channel once, write the file, prove it with one message) and
how to change the channel are in `instructions/setup.md`; run `/tp:notify setup` (or `setup target=<channel>`) to do it.

## Steps

### Send
1. `node <lib>/notify.mjs prepare <.claude> <level> "<text>"` reads `notify.json`, applies the level filter and builds
   the line. `send: false` → return its `result` (`notifications off`, `notifications: channel not set — …`,
   `notifications: <level> muted`) and stop — no setup from here: setup runs only where a person can answer.
2. `send: true` → load the `tool` by name with the runtime's tool lookup; gone → return `notifications: <tool> is no
   longer connected — /tp:notify setup` and change nothing.
3. Post the `message` to `target`, as one message. Never more than one message per invocation; never a thread of
   follow-ups; never attachments.
4. Return one line: `notified <target>` | `notifications: <why not>`. A failed send is reported this way and **never
   fails the caller** — the report and `/tp:status` carry every stop regardless.

## What is never sent
Code, diffs, gate output, review findings in full, anything from `answers.md`, real
customer data. The message says *that* something happened and where to look, not
*what the code is*.
