# Flowcharts — every path the pipeline can take

Diagrams for people. Each one is followed by **where each branch lives**, so a box or an
arrow can be traced to the file that decides it: nothing here is a second statement of a
rule, only a map of the rules in `README.md` and the skills.

Agents do not read this file — they read the rules by reference (`README.md`
§ Context management, rule 10). Read it when you want to see the shape of the thing, or
to find which skill owns a decision you are looking at.

Diagram conventions: a **diamond** is a decision the pipeline makes from evidence; a
**rounded box with a bell** (🔔) is a *stop* — it ends the agent and waits for a person
(§ Stops and notifications); a dashed arrow is a path taken only on a person's answer.

## 1. One ticket, end to end

```mermaid
flowchart TD
    START(["/tp-run-ticket ABC-123"]) --> PRE{"preflight fresh?<br/>doctor.mjs fresh"}
    PRE -->|"exit 2 or a failure"| PRESTOP(["🔔 error: the install cannot run<br/>needs: the fix the doctor named"])
    PRE -->|"exit 1"| DOC["/tp-doctor"] --> RESUME0
    PRE -->|"exit 0"| RESUME0{"work directory?"}

    RESUME0 -->|"none"| S1
    RESUME0 -->|"exists"| STATE["state.mjs state --brief"] --> RESUME{"what does the state say?"}
    RESUME -->|"closed or done"| REFUSE(["refuse: round=n+1 or force=true"])
    RESUME -->|"problems"| PROB(["🔔 error: an inconsistency<br/>answers=retry"])
    RESUME -->|"stopped, answer queued"| S1
    RESUME -->|"stopped, usage pause past reset"| S1
    RESUME -->|"stopped, blocked but now unblocked"| S1
    RESUME -->|"stopped, anything else"| STOPOUT(["🔔 the stop, with its resume command"])
    RESUME -->|"in progress or pending"| S1

    S1["1 · /tp-start-ticket<br/>blocked check, assign, rate, estimate,<br/>one worktree + branch per repo"]
    S1 --> S1Q{"pickable?"}
    S1Q -->|"blocked by an open ticket"| S1STOP(["🔔 blocked by ABC-1, ABC-2<br/>nothing to answer"])
    S1Q -->|"soft-blocked, assigned elsewhere,<br/>already done, repo unclear"| S1ASK(["🔔 a question with its answer token"])
    S1ASK -.->|"answers=continue / takeover /<br/>reopen / &lt;repos&gt;"| S1
    S1Q -->|"yes"| S2

    S2["2 · /tp-triage<br/>a fresh agent sizes the change"]
    S2 --> S2Q{"decision"}
    S2Q -->|"close"| CLOSE["close-out: worktrees removed,<br/>ticket commented"] --> DONE
    S2Q -->|"blocked"| PARK["parked: worktrees removed,<br/>blockedBy recorded"] --> PARKSTOP(["🔔 blocked by ... — resumes itself<br/>when /tp-inbox or /tp-plan-day re-checks"])
    S2Q -->|"needs-input"| S2ASK(["🔔 the numbered questions"])
    S2ASK -.->|"answers=1: ... 2: ..."| S2
    S2Q -->|"direct"| S4
    S2Q -->|"plan"| S3

    S3["3 · /tp-plan<br/>this agent plans; a fresh checker verifies"]
    S3 --> S3C{"plan-check verdict"}
    S3C -->|"revise, within the retry bound"| S3
    S3C -->|"revise, bound spent"| S3P
    S3C -->|"ok"| S3P
    S3P{"open questions in the plan?"}
    S3P -->|"yes"| S3Q(["🔔 the open questions"])
    S3Q -.->|"answers"| S3
    S3P -->|"no"| APPROVE(["🔔 approval needed: n steps, risks ...<br/>open risks named"])
    APPROVE -.->|"answers=go-ahead"| S4
    APPROVE -.->|"a change"| S3

    S4["4 · /tp-implement — per repo, in ticket.json order<br/>a commit per step, the hooks gate each commit"]
    S4 --> S4Q{"how did it end?"}
    S4Q -->|"a deviation that changes the approach,<br/>a decision only a person can make"| S4STOP(["🔔 step n — the question"])
    S4STOP -.->|"answers"| S4
    S4Q -->|"a checkpoint failing past its retries"| S4ERR(["🔔 error: step n<br/>answers=retry"])
    S4Q -->|"harder than rated"| S4ESC["re-spawned one tier up<br/>tier=next continue=true"] --> S4
    S4Q -->|"done"| S5

    S5["5 · /tp-create-pr — per repo<br/>commit, sync, gates, push, PR + comments"]
    S5 --> S5Q{"anything a person must decide?"}
    S5Q -->|"a conflict, an unclear intent,<br/>an unexpected diff, a gate that only<br/>passes by changing the approach"| S5STOP(["🔔 the question<br/>ours/theirs, keep/drop/split, change/keep"])
    S5STOP -.->|"answers"| S5
    S5Q -->|"no"| S6

    S6["6 · /tp-merge — per repo"] --> REVIEW["/tp-review in its own agent:<br/>only the PR, the ticket link, a neutral what"]
    REVIEW --> ROUNDS{"model.mjs rounds"}
    ROUNDS -->|"review"| FIX["a fixer applies the items,<br/>/tp-create-pr update=true"] --> REVIEW
    ROUNDS -->|"stop: budget spent or not converging"| LOOPSTOP(["🔔 review loop: why<br/>answers=merge or fix"])
    LOOPSTOP -.->|"fix"| FIX
    LOOPSTOP -.->|"merge"| MERGEOK
    ROUNDS -->|"merge"| MERGEQ{"merge=auto or ask?"}
    MERGEQ -->|"ask"| MERGEASK(["🔔 review PASS — merge, or send fixes?"])
    MERGEASK -.->|"answers=merge"| MERGEOK
    MERGEASK -.->|"answers=fix ..."| FIX
    MERGEQ -->|"auto"| MERGEOK["merge into the base branch<br/>the worktree stays"]
    MERGEOK --> S7

    S7["7 · /tp-release<br/>watch the run, operator follow-ups, smoke"]
    S7 --> S7Q{"how did it go?"}
    S7Q -->|"a failed run, an undocumented<br/>follow-up, a failed smoke check"| S7STOP(["🔔 retry, skip or run"])
    S7STOP -.->|"answers"| S7
    S7Q -->|"promote= given"| PROMOTE["fast-forward the release branch"] --> S8
    S7Q -->|"healthy"| S8

    S8["8 · /tp-accept<br/>every criterion walked, with evidence"]
    S8 --> S8Q{"any criterion failed?"}
    S8Q -->|"yes"| S8STOP(["🔔 n criteria failed — round n+1, or leave?"])
    S8STOP -.->|"answers=round"| ROUND["/tp-run-ticket ABC-123 round=n+1<br/>the same worktree, re-branched from the base"] --> S1
    S8STOP -.->|"answers=leave"| STOPOUT
    S8Q -->|"no"| CLEAN["worktrees removed — the run's last stage"]
    CLEAN --> RETRO{"retro=true?"}
    RETRO -->|"yes"| S8B["8b · /tp-retro — proposals only"] --> DONE
    RETRO -->|"no"| DONE(["done · report.md · /tp-notify level=done"])
```

**Where each branch lives**

| Branch in the diagram | Decided by |
|---|---|
| preflight, and what each exit code means | `README.md` § Using it, Preflight |
| the resume decision (queued answer, usage pause, unblocked, problems, closed) | `README.md` § Definitions, Resume · `tp-run-ticket/SKILL.md` step 0 |
| blocked / soft-blocked at pickup | `tp-start-ticket/instructions/blocked-check.md` |
| triage's five decisions | `tp-triage/instructions/criteria.md` |
| the plan → check → revise loop and its bound | `tp-plan/SKILL.md` step 2 · `tp-plan/instructions/check-criteria.md` |
| the approval, and what an answer other than `go-ahead` does | `tp-plan/SKILL.md` step 3 |
| a step's stop, an escalation, a checkpoint | `tp-implement/SKILL.md` step 2 · `README.md` § Context management, rule 7 |
| conflicts, unexpected diffs, a gate that changes the approach | `tp-create-pr/instructions/sync.md` · `tp-create-pr/instructions/diff-validation.md` |
| the review loop's `review` / `merge` / `stop` | `tp-merge/instructions/review-loop.md` · `README.md` § Review scope and rounds |
| `merge=auto` vs `ask`, and who may merge | `README.md` § Review scope and rounds, Merging |
| the deploy watch, follow-ups, smoke, promotion | `tp-release/SKILL.md` steps 2–5 |
| a failed criterion and the next round | `tp-accept/SKILL.md` step 4 · `README.md` § Worktrees |
| when the worktrees go | `README.md` § Worktrees |
| what a stop does before it returns (unlock, notify, report) | `README.md` § Stops and notifications |

## 2. Entry points — any skill, from anywhere

Every skill works on its own. A stage skill invoked on a ticket that has not reached it
brings the ticket there first, through the same orchestrator, and then runs itself.

```mermaid
flowchart LR
    A(["/tp-merge ABC-123"]) --> B{"is the ticket at this stage?"}
    B -->|"yes"| C["run this skill's own steps<br/>(Resume decides run / resume / refuse)"]
    B -->|"no — earlier, or no work directory"| D["/tp-run-ticket ABC-123 until=merge inline=true<br/>with this invocation's arguments"]
    D --> E["the orchestrator runs the missing stages<br/>and this one, each in its own agent"]
    E --> F{"a stop in an earlier stage?"}
    F -->|"yes"| G(["🔔 that stop — answered on the skill you invoked"])
    F -->|"no"| C
```

| Branch | Decided by |
|---|---|
| what counts as "at this stage" | `README.md` § Definitions, Entry points |
| run vs resume vs refuse | `README.md` § Definitions, Resume |
| which arguments are forwarded to which stage | `tp-run-ticket/SKILL.md` Input |

## 3. A stop, and how it is answered

```mermaid
flowchart TD
    STOP["a stage cannot go on"] --> KIND{"kind"}
    KIND -->|"question"| Q["logged: stopped 'the question'"]
    KIND -->|"approval"| Q
    KIND -->|"error"| Q
    KIND -->|"usage"| Q
    KIND -->|"blocked"| Q
    KIND -->|"problem (the script found it)"| Q
    Q --> ORDER["unlock → /tp-notify level=stop → return the question"]
    ORDER --> WHO{"who is there?"}
    WHO -->|"a session with a person"| DOC{"does the stop name a doc?"}
    DOC -->|"yes: a plan, a day's plan"| SHOW["the session prints that document<br/>in the conversation, then asks"] --> INT
    DOC -->|"no: the question carries its own choices"| INT
    INT["the interview:<br/>the runtime's question tool"] --> REINVOKE["re-invoke with answers=..."]
    WHO -->|"the office"| OFFICE["the answer is typed on the inbox card<br/>state.mjs answer ... --by office"] --> QUEUE["work/_inbox/&lt;id&gt;.json"]
    QUEUE --> CONSUME["the next invocation consumes it<br/>(answer --consume)"] --> REINVOKE
    WHO -->|"nobody: a scheduled or unattended run"| ROW["the stop is printed as a row<br/>and waits in /tp-inbox"]
    ROW --> LATER["/tp-inbox re-invokes what resumes by itself;<br/>the rest is one interview"] --> REINVOKE
    REINVOKE --> BACK["the stage resumes at its checkpoint"]
```

| Branch | Decided by |
|---|---|
| the kinds, the default, `resumable`, the resume command | `README.md` § Definitions, Asking the user |
| the document a stop names, and showing it before asking | `README.md` § Definitions, Asking the user · `state.mjs` (`docOf`) |
| the order a stop ends an agent in | `README.md` § Stops and notifications |
| queued answers from the office | `README.md` § Definitions, Asking the user · `tp-status/SKILL.md` |
| what resumes without a person | `tp-inbox/SKILL.md` · `tp-start-ticket/instructions/blocked-check.md` § Re-check |

## 4. A day

```mermaid
flowchart TD
    D1(["/tp-plan-day"]) --> D2{"sprint or pool?"}
    D2 -->|"an active iteration with open tickets"| D3["every qualifying sprint ticket"]
    D2 -->|"none"| D4["a seeded draw from the open pool"]
    D3 --> D5["blocked check on every candidate"]
    D4 --> D5
    D5 --> D6["rate, estimate, order by dependency,<br/>schedule into the person's days"]
    D6 --> D7(["🔔 approval needed: the day plan<br/>now: A, B · then: C after A"])
    D7 -.->|"drop / only / add / first / lanes="| D6
    D7 -.->|"go-ahead"| D8["day.mjs approve"]
    D8 --> D9["/tp-run-ticket A B C ... — one orchestrator each,<br/>spawned together, in parallel"]
    D9 --> D10{"a run returns"}
    D10 -->|"done or stopped"| D11["/tp-plan-day date=... — an advance"]
    D11 --> D12{"what can start now?"}
    D12 -->|"a dependent whose prerequisite landed"| D9
    D12 -->|"a parked ticket whose blockers resolved"| D9
    D12 -->|"nothing: lanes full, or waiting"| D13["report what waits and why"]
    D13 --> D10
    D12 -->|"every ticket settled"| D14(["/tp-eod — the day's close,<br/>actual hours, carry-over, drift"])
```

| Branch | Decided by |
|---|---|
| sprint detection, the pool draw, the feature filter | `tp-plan-day/instructions/selection.md` |
| the proposal and its adjustments | `tp-plan-day/SKILL.md` step 6b |
| how many run at once | `README.md` § Models and budget (`tiers.json.day.lanes`) |
| when a dependent may start | `README.md` § Worktrees (stacked) · `day.mjs` header |
| the blocker re-check and its freshness | `tp-start-ticket/instructions/blocked-check.md` § Re-check, § Freshness |
| the day's close and the estimates' drift | `tp-eod/SKILL.md` · `README.md` § Models and budget, Estimates |

## 5. A gate — who runs it, and who does not

```mermaid
flowchart TD
    G1["a stage needs the gate table"] --> G2{"a result recorded<br/>for this head and base?"}
    G2 -->|"yes, and the checkout is clean at that head"| G3(["the recorded table — nothing runs"])
    G2 -->|"no"| G4{"generated code current?<br/>codegen.mjs status"}
    G4 -->|"stale"| G5["run the project's generate command,<br/>then codegen.mjs mark"] --> G6
    G4 -->|"current, or nothing generated"| G6{"which gates do the repo's hooks own?<br/>hooks.mjs cover"}
    G6 -->|"a whole-project command in a hook"| G7["HOOK row — the commit or the push enforced it"]
    G6 -->|"a staged-files runner"| G8["HOOK row for lint and format only"]
    G6 -->|"none"| G9
    G7 --> G9["run what is left as background processes"]
    G8 --> G9
    G9 --> G10{"a whole-program gate?"}
    G10 -->|"yes"| G11["compare with the base's output<br/>from the cached baseline checkout"]
    G10 -->|"no"| G12["run on the changed files only"]
    G11 --> G13["record the result for these commits"]
    G12 --> G13
    G13 --> G14{"anything failed?"}
    G14 -->|"yes"| G15["a fixer fixes it in the change<br/>— never by weakening a gate or a hook"]
    G14 -->|"no"| G16(["ALL GATES PASSED"])
```

| Branch | Decided by |
|---|---|
| the whole rule: reuse, hooks, then run | `README.md` § Verification rules |
| what a hook covers, and at what scope | `hooks.mjs` header · `tp-verify/SKILL.md` step 0b |
| generated code and staleness | `README.md` § Toolchain · `codegen.mjs` header |
| the baseline and the per-commit record | `tp-verify/SKILL.md` step 2 · `gates.mjs` header |
| a failing gate, and what is never done about it | `README.md` § Verification rules · § Commits |

## 6. Installing it in a project

```mermaid
flowchart TD
    I1(["/tp-setup"]) --> I2["the catalogue: five groups"]
    I2 --> I3["one question per group:<br/>which skills does this project use?"]
    I3 --> I4{"a selected skill needs one left out?"}
    I4 -->|"yes"| I5["it is added, and the report says for whom"] --> I6
    I4 -->|"no"| I6["the models for the three tiers → tiers.json"]
    I6 --> I7{"the repo's gates in its own hooks?"}
    I7 -->|"yes"| I8["hooks.mjs install → .husky/pre-commit, pre-push"]
    I7 -->|"a command rewrites files<br/>with no check-only form"| I9(["nothing written: use a staged runner,<br/>or move the gate to pre-push"])
    I7 -->|"no"| I10
    I8 --> I10["setup.mjs apply → pipeline.json;<br/>skills that are off move to skills/_off/"]
    I10 --> I11["the allowlist lines, .gitignore, /tp-notify setup"]
    I11 --> I12(["/tp-doctor — the preflight closes the setup"])
```

| Branch | Decided by |
|---|---|
| the catalogue, the groups, the dependencies | `skills/_lib/setup.mjs` (`GROUPS`) · `tp-setup/SKILL.md` |
| what an off skill changes downstream | `README.md` § Definitions, Active skills |
| the hooks, and when they are refused | `README.md` § Verification rules · `hooks.mjs` header |
| what the allowlist must cover | `README.md` § Using it, Install |

## 7. Who runs in which agent

```mermaid
flowchart TD
    P["the person's session"] -->|"spawns, in the background"| M["the orchestrator — one per ticket"]
    M -->|"invokes each stage skill"| L["a stage's dedicated agent —<br/>one per stage, covering every repo"]
    L -->|"except implement, where each repo's own<br/>context is the reason for the split"| IMPL["one implementer per repo"]
    L -->|"does the skill's own work itself"| W["plan · implement · triage · walk · retro"]
    L -->|"spawns only what must be independent<br/>or must not fill its context"| SUB["a checker · a reviewer · a fixer ·<br/>a describer · a validator · an operator"]
    L -->|"runs commands as processes,<br/>never as agents"| CMD["gates · installs · lookups · notifications"]
    SUB -.->|"one level deeper has no agent tool"| INLINE["it invokes skills with inline=true<br/>and fans out sequentially"]
```

| Branch | Decided by |
|---|---|
| the dedicated-agent rule and what a skill does itself | `README.md` § Definitions, Dedicated agent |
| when a second agent is justified | `README.md` § Context management, rules 2 and 9 |
| one agent per stage, and why implement is the exception | `README.md` § Context management, rule 9 · `tp-create-pr/SKILL.md` · `tp-merge/SKILL.md` · `tp-release/SKILL.md` |
| commands batched into one call rather than a turn each | `README.md` § Context management, rule 12 |
| commands and lookups without an agent | `README.md` § Context management, rules 4 and 11 |
| the depth limit | `README.md` § Definitions, Depth |
| which model each agent runs on | `README.md` § Models and budget |
