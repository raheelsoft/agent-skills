# Notify — configuration and setup

Read only for `setup` (or to edit `notify.json` by hand); a send never needs it.

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


## Setup

When `notify.json` does not exist: Run when `reference/observability.md` § Observability says (by the invoking context, in the
session), or by hand with `/tp:notify setup`.
1. **Find the tool.** Use the runtime's tool lookup (`reference/definitions.md` § Definitions,
   Runtime notes) for a tool that posts a message to a channel, chat or team (queries
   such as `send message`, `post message`, `channel`); a tool whose
   description says it sends/posts to a conversation counts, a "draft" or "schedule"
   variant does not when a plain send exists. None → write `{ "tool": null, "project":
   "<repo or folder name>", "levels": [...], "setAt": <now> }`, say "notifications:
   no chat tool connected — `/tp:notify setup` again after connecting one", and stop.
2. **Ask for the channel — once.** In a session: one question, "Pipeline
   notifications will go through `<tool>`; which channel/team/chat? (or `none`)".
   `none` → `tool: null`. Inside an agent (an unattended run): don't ask; write the
   file with `target: null` and let the report say "notifications: channel not set —
   `/tp:notify setup target=<channel>`". `target=<channel>` given → no question.
3. **Write the file** with `project` = the repo's or folder's name (the label in
   front of every message; the person can change it) and `levels` defaulted; then send
   one message `[<project>] pipeline notifications on` straight to the tool — the level
   filter does not apply to this proof — so the channel is proven reachable. A failure
   here is reported and `target` is kept — the person fixes the name.


