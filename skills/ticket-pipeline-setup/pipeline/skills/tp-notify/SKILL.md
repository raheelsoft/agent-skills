---
name: tp-notify
description: Send one pipeline line (a stop, a finished run, an error) to the project's chat channel — silent without a chat tool; `setup` picks the tool and channel once. Runs in the invoking context.
user_invocable: true
---

The pipeline's outbound voice. Every stop and every finished run goes through here so
a person who isn't watching still hears about it; nothing else does. The message is one
line, the channel was chosen once for this project, and when the environment has no
chat tool the skill is a silent no-op — never an error, never a question. It is one
tool call, so it runs **in the invoking context** — the agent that stops sends its own
line; no agent is spawned to send it, or to do nothing (`skills/README.md`
§ Definitions, Dedicated agent — the one exception to the rule). Conventions:
§ Observability.

## Input

- `<text>` — the message: everything before the first `key=value` token, or a quoted
  string. Written by the caller as `<ticket> · <stage> · <what>` with the link that
  lets the reader act (the PR, the ticket, the work directory's question); no personal
  data (`skills/README.md` § Personal data).
- `level=stop|done|error|info` (optional, default `info`) — `stop`: a person must
  answer; `done`: a run finished; `error`: a run failed; `info`: anything else. Which
  levels are sent is the project's choice (setup below); `stop`, `done` and `error` by
  default.
- `setup` (instead of a text) — the one-time configuration; `setup target=<channel>`
  sets or changes the channel without asking.
- `inline=true` — accepted and meaningless here: both forms always run where they are
  invoked (`skills/README.md` § Definitions, Dedicated agent) — a send because it is
  one tool call, `setup` because it may need to ask the person.

## The configuration — `<.claude>/notify.json`

```
{ "tool": "<the connected tool that posts a message>" | null,
  "target": "<channel, team or chat as that tool names it>" | null,
  "project": "<short label put in front of every message>",
  "levels": ["stop", "done", "error"],
  "setAt": "<timestamp>" }
```

One file per project (the `.claude` directory is per project). `tool: null` means
"no chat tool here — stay silent, don't ask again". `target: null` with a tool means
"a tool exists, nobody has named the channel yet" — messages are not sent, and every
report that would have notified says so once. The file is edited by hand or by
`setup target=<channel>` at any time.

## Steps

### Setup — when `notify.json` does not exist
Run when `skills/README.md` § Observability says (by the invoking context, in the
session), or by hand with `/tp-notify setup`.
1. **Find the tool.** Use the runtime's tool lookup (`skills/README.md` § Definitions,
   Runtime notes) for a tool that posts a message to a channel, chat or team (queries
   such as `send message`, `post message`, `channel`); a tool whose
   description says it sends/posts to a conversation counts, a "draft" or "schedule"
   variant does not when a plain send exists. None → write `{ "tool": null, "project":
   "<repo or folder name>", "levels": [...], "setAt": <now> }`, say "notifications:
   no chat tool connected — `/tp-notify setup` again after connecting one", and stop.
2. **Ask for the channel — once.** In a session: one question, "Pipeline
   notifications will go through `<tool>`; which channel/team/chat? (or `none`)".
   `none` → `tool: null`. Inside an agent (an unattended run): don't ask; write the
   file with `target: null` and let the report say "notifications: channel not set —
   `/tp-notify setup target=<channel>`". `target=<channel>` given → no question.
3. **Write the file** with `project` = the repo's or folder's name (the label in
   front of every message; the person can change it) and `levels` defaulted; then send
   one message `[<project>] pipeline notifications on` straight to the tool — the level
   filter does not apply to this proof — so the channel is proven reachable. A failure
   here is reported and `target` is kept — the person fixes the name.

### Send
1. Read `notify.json`. Missing or `tool: null` → return `notifications off` and stop
   (no setup from here: setup runs only where a person can answer). `target: null` →
   return `notifications: channel not set — /tp-notify setup target=<channel>`.
2. `level` not in `levels` → return `notifications: <level> muted`.
3. Load the tool by name with the runtime's tool lookup; gone → return `notifications: <tool>
   is no longer connected — /tp-notify setup` and change nothing.
4. Send `[<project>] <text>` to `target`, as one message. Never more than one message
   per invocation; never a thread of follow-ups; never attachments.
5. Return one line: `notified <target>` | `notifications off` | `notifications: <why
   not>`. A failed send is reported this way and **never fails the caller** — the
   report and `/tp-status` carry every stop regardless.

## What is never sent
Code, diffs, gate output, review findings in full, anything from `answers.md`, real
customer data. The message says *that* something happened and where to look, not
*what the code is*.
