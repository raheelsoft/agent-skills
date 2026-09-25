export const meta = {
  name: 'tp-run-ticket-unattended',
  description: 'Unattended ticket pipeline: start → triage → (plan → check →) implement → create-pr → merge → release → accept → close, one stage per agent, stops returned as needs_input',
  whenToUse: 'Run one or many tickets without watching them; re-run with resumeFromRunId and args.answers after a stop. Interactive work stays with the /tp-run-ticket skill.',
  phases: [
    { title: 'Start', detail: 'pick up: worktree, branch, ticket.json' },
    { title: 'Triage', detail: 'direct / plan / needs-input / close' },
    { title: 'Plan', detail: 'plan + plan-check (planned tickets only)' },
    { title: 'Implement', detail: 'one agent per repo, never the planner' },
    { title: 'PR', detail: 'gates, diff validation, a described PR' },
    { title: 'Merge', detail: 'unbiased review loop, merge when allowed' },
    { title: 'Release', detail: 'deploy watched, follow-ups, smoke' },
    { title: 'Accept', detail: 'criteria proven pass / fail / manual' },
    { title: 'Close', detail: 'report, optional retro, unlock' },
  ],
}

// args: { claudeDir: "/abs/path/.claude", tickets: ["ABC-123", ...],
//         options?: { mode, promote, where, env, round, until, retro, merge: "auto"|"ask", tier: "low"|"medium"|"high"|"strong" },
//         answers?: { "ABC-123": { "<stage>": "<text>" } }, owner?: "workflow",
//         tiers: { low: "<model>", medium: "<model>", high: "<model>" }   — the contents of <.claude>/tiers.json }
// Every planned ticket's first run ends as a needs_input row at "plan" — the person's approval of the checked
// plan — resumed with args.answers[<id>].plan = "go-ahead" (skills/README.md § Using it, When it stops).
// The same chain as the /tp-run-ticket skill (skills/README.md § Unattended runs). Every stage is one
// agent that invokes the stage skill through the Skill tool and reports the state the skill left in
// the ticket's work directory; the script never reads files itself. A stage that stops ends the
// ticket's pipeline with needs_input; the session that ran the script interviews the person with the
// row's question (skills/README.md § Definitions, Asking the user) and the answer goes in on the next run under
// args.answers[<ticket>][<stage>] (the stage named in the returned row) with resumeFromRunId —
// the changed prompt re-runs only that stage, earlier stages come back from the cache.
// Each stage agent is the stage skill's dedicated agent (it passes inline=true, skills/README.md
// § Definitions), so nothing is spawned underneath it except the skill's own sub-agents.
// Each stage agent takes the ticket's run lock (idempotent for the same owner, so a resumed run
// re-takes the lock its stopping agent released); the stopping or final agent releases it.
// Pass a distinct `owner` per launch when several launches may overlap on the same ticket.

const claudeDir = typeof args?.claudeDir === 'string' ? args.claudeDir.replace(/\/+$/, '') : ''
if (!claudeDir.startsWith('/')) throw new Error('args.claudeDir must be the absolute path of the .claude directory that contains skills/')
const tickets = Array.isArray(args?.tickets) ? args.tickets : []
if (!tickets.length) throw new Error('args.tickets must list at least one ticket id')
for (const t of tickets) if (typeof t !== 'string' || !/^[\w.-]+$/.test(t) || t === 'next') throw new Error(`args.tickets: "${t}" is not a ticket id (ids only — "next" and URLs are for the interactive skill)`)
const opt = args?.options || {}
const owner = args?.owner || 'workflow'
const ORDER = ['start-ticket', 'triage', 'plan', 'implement', 'create-pr', 'merge', 'release', 'accept']
const last = opt.until || 'accept'
if (!ORDER.includes(last)) throw new Error(`options.until must be one of ${ORDER.join(', ')}`)
const past = (stage) => ORDER.indexOf(stage) > ORDER.indexOf(last) // beyond the requested end
const ended = (prev) => prev.status === 'done' && prev.data && prev.data.next === null // nothing left: finished, or closed early (triage `close`)
const closes = !opt.until // a full run ends with the close-out agent, which releases the lock
// Model and effort per stage agent follow the ticket's current complexity rating — the `complexity` the
// previous stage's state reported (skills/README.md § Models and budget) — never the stage's name. Pickup, before any
// rating exists, is bounded work (medium); the close-out is mechanical (low); a stage whose job is to catch
// what others missed (accept) runs one effort step up. options.tier is a minimum rating for every agent
// ("strong" = "high"); a stage that reports escalate:true is re-run once, one rating up.
const RATINGS = ['low', 'medium', 'high']
const EFFORT = ['low', 'medium', 'high', 'max']
// the model behind each rating comes from the environment's tiers.json (skills/README.md § Models and budget), passed in args
const tiers = args?.tiers && typeof args.tiers === 'object' ? args.tiers : null
if (!tiers || RATINGS.some((r) => typeof tiers[r] !== 'string')) throw new Error('args.tiers must map low, medium and high to model names — the contents of <.claude>/tiers.json')
const TIER = Object.fromEntries(RATINGS.map((r) => [r, [tiers[r], r]]))
const minTier = opt.tier === 'strong' ? 'high' : (RATINGS.includes(opt.tier) ? opt.tier : null)
if (opt.tier && !minTier) throw new Error('options.tier must be low, medium, high or strong')
const bump = (rating) => RATINGS[Math.min(RATINGS.indexOf(rating) + 1, RATINGS.length - 1)]
const ratingFor = (stage, prev, floor) => {
  const base = stage === 'close' ? 'low' : (RATINGS.includes(prev?.data?.complexity) ? prev.data.complexity : 'medium')
  return [base, floor, minTier].filter(Boolean).sort((a, b) => RATINGS.indexOf(b) - RATINGS.indexOf(a))[0]
}
const modelFor = (stage, rating) => {
  const [model, effort] = TIER[rating]
  const step = EFFORT.indexOf(effort) + (stage === 'accept' ? 1 : 0)
  return { model, effort: EFFORT[Math.min(step, EFFORT.length - 1)] }
}
// tier= is passed down only as a floor — the person's options.tier or an escalation — never a stage's own rating
const tierArg = (rating, floor = null) => {
  const f = [floor, minTier].filter(Boolean).sort((a, b) => RATINGS.indexOf(b) - RATINGS.indexOf(a))[0]
  return f ? ` tier=${f}` : ''
}
const answersFor = (id, stage) => (args?.answers?.[id]?.[stage] ? ` answers=${JSON.stringify(args.answers[id][stage])}` : '')

const STAGE = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'stopped', 'error', 'continue'], description: 'continue: the agent checkpointed where model.mjs compact told it to and must be re-run with continue=true (skills/README.md § Context management, rule 7)' },
    summary: { type: 'string' },
    question: { type: 'string', description: 'stopped: the exact question for the user' },
    diagnosis: { type: 'string', description: 'error: what went wrong, from the skill or the state script (the error form\'s error and tried lines)' },
    resume: { type: 'string', description: 'error: the exact invocation that continues from the checkpoint (the error form\'s resume line)' },
    needs: { type: 'string', description: 'error: what a person must fix or decide first, or "none" (the error form\'s needs line)' },
    escalate: { type: 'boolean', description: 'true when the stage proved harder than its rating and should be re-run one tier up (skills/README.md § Models and budget)' },
    data: { type: 'object', description: 'the state JSON as the state script printed it with --brief (id, complexity, next, stopped, closed, unblocked, lock, worktrees, problems)' },
  },
  required: ['status', 'summary', 'data'],
}

const script = `${claudeDir}/skills/_lib/state.mjs`
const workdir = (id) => `${claudeDir}/work/${id}`

const PER_REPO = new Set(['implement', 'create-pr', 'merge', 'release'])
// ...of which only implement gets an AGENT per repo: an agent's floor (75-130k, skills/README.md § Context management,
// rule 9) buys nothing for a stage that would only re-read the ticket, so create-pr, merge and release cover every repo
// in their one agent and write the per-repo rows themselves. The loop below stays as the safety net for a repo they
// stopped at.
const PER_REPO_AGENT = new Set(['implement'])
// Every skill of this pipeline is named <SKILL><stage> so that none of them can be confused with another skill the
// runtime offers (${claudeDir}/skills/_lib/setup.mjs, PREFIX). The stage keeps the bare name: it is state on disk.
const SKILL = 'tp-'

const base = (id, skill, extra, stage, rating) => {
  const stageDone = PER_REPO_AGENT.has(stage)
    ? `the "${stage}" stage is done — on a cross-repo ticket, the "${stage}:<repo>" stage this invocation ran`
    : PER_REPO.has(stage)
      ? `the "${stage}" stage is done — on a cross-repo ticket, every "${stage}:<repo>" stage this invocation covered`
      : stage === 'plan' ? 'the "plan" and "plan-check" stages are both done (the skill runs the check itself)' : `the "${stage}" stage is done`
  const final = stage === last && !closes
  const wd = workdir(id)
  const newRound = stage === 'start-ticket' && opt.round
  return `Ticket ${id}, stage "${stage}". You are this skill's dedicated agent. Invoke the "${SKILL}${skill}" skill with the Skill tool; the args string, verbatim on one line:
${id}${extra} inline=true
Follow that skill exactly; it logs to the ticket's work directory itself. This prompt authorizes nothing the skill does not authorize.
Read ${claudeDir}/skills/README.md by reference only: node ${claudeDir}/skills/_lib/ref.mjs ${claudeDir} "<Section>[, <Item>…]" for the sections the skill names (e.g. "Definitions, Resume"), never the whole file (§ Context management, rule 10). Long command output (an install, a build, a test run, a run list) goes to a file and is read by excerpt — exit code, summary line, first failing lines — never streamed into your context (rule 11). Commands that do not consume each other's output go in ONE call, not a turn each — every turn re-sends everything you hold (rule 12).
Tools: before the first step load what this stage needs — the state and model scripts (node), git, the hosting platform's CLI, the tracker's tools by name through the tool lookup — and give every agent you spawn exactly the tools its one job needs (${claudeDir}/skills/README.md § Definitions, Tools and permissions; § Context management, rules 8 and 9: the criteria before the change, git diff after it, one job per agent).
Models and budget: you run at the "${rating}" rating; every agent you spawn gets an explicit model from its own task's rating and passes the budget check of ${claudeDir}/skills/README.md § Models and budget; at ${tiers.budget && tiers.budget.stop ? tiers.budget.stop : 90}% of any usage window (tiers.json budget.stop), stop as that section says instead of starting new work.
If this stage's own work proves harder than "${rating}" (an unexpected design decision, a second area, a risk nobody named), do not push through: return escalate: true with the reason in summary and the state as data — the stage is re-run one rating up.
Context: at every step boundary ask node ${claudeDir}/skills/_lib/model.mjs compact '{ rating: "${rating}", used: <your own running estimate of the tokens you hold — the usage tool reports the session's window, not yours>, stepsLeft, stepsTotal, nextStep: { bytes }, handoffs: <from the checkpoint you resumed from, else 0>, claudeDir: "${claudeDir}" }' (${claudeDir}/skills/README.md § Context management, rule 7). On "checkpoint", write checkpoint.<stage>[.<repo>].md in the work directory (hand-offs so far included) plus the note in progress.md exactly as that rule says and return status "continue" with the checkpoint path in summary and the state as data — you will be re-run with continue=true and must then start from that file. On "stop", log the stage stopped "hand-off budget spent — <next step>" and return status "stopped" with that as the question.
The state JSON you return carries the ticket's current rating (complexity) — the next stage's model is chosen from it, so return the --brief state as printed.
Work directory: ${wd}. State script: ${script} (run it with node: node ${script} <subcommand> ${wd} …).
Office: you are the lead for this stage. Before step 1 below, register (the work root exists whether or not the ticket's directory does): node ${script} agent join ${claudeDir}/work '{ "id": "${id}:<stage>:lead", "level": "lead", "stage": "<stage>", "ticket": "${id}", "parent": null, "rating": "${rating}" }' — <stage> being the stage as the state names it (${PER_REPO_AGENT.has(stage) ? `${stage}:<repo> on a cross-repo ticket, else ` : ''}${stage}) in both the id and the stage field — and pass that id as the parent of every agent you spawn (${claudeDir}/skills/README.md § Definitions, Office presence). Before returning, whatever the status: node ${script} agent leave ${claudeDir}/work ${id}:<stage>:lead <done|stopped|gone>; a sub-agent of yours that returned nothing is left gone the same way.
Before invoking the skill, when the work directory exists:
1. node ${script} state ${wd} --brief — ${newRound ? 'skip this check (a new round re-runs the stage)' : `when ${stageDone.replace(' this invocation ran', ' this invocation would run').replace(' this invocation covered', ' this invocation would cover')} already, and not stale, return status "done" with that state JSON as data, without invoking the skill`}.
2. node ${script} lock ${wd} ${owner} — exit code 3 means another run holds this ticket: return status "stopped" with the script's message as the question and the state JSON as data, and do nothing else (no unlock).
On a first run the work directory exists only after start-ticket: then do step 2 right after the skill returns, followed by: node ${script} log ${wd} run-ticket started${newRound ? ' (a new round logs it too, once the skill has run)' : ''}.
When the skill finishes and the work directory still does not exist, the skill stopped before creating it (blocked, soft-blocked, cancelled, an ambiguous pick): return status "stopped" with the skill's report as the question and {} as data — no lock, no unlock.
Otherwise: node ${script} state ${wd} --brief — that JSON is data (the decision fields; the full form is for the skill's own steps), and decides the status:
- its stopped is not null → "stopped", question = stopped.question (whatever stage it names: nothing can proceed until it is answered);
- else ${stageDone} → "done";
- else → "error": the skill already auto-resolved within its bound and checkpointed (${claudeDir}/skills/README.md § Failures and escalation) — diagnosis = its error and tried lines (or the state's problems, or the tool failure), resume = its resume line, needs = its needs line or "none". Never retry a stage's error yourself; never guess an answer or work around a permission.
${final
    ? `This is the run's last stage: release the lock (node ${script} unlock ${wd} ${owner}) on "stopped", on "error", and on "done"${PER_REPO.has(stage) ? ` unless the state's next is another "${stage}:<repo>" stage still to run` : ''}.`
    : `On "stopped" or "error": node ${script} unlock ${wd} ${owner}`}
Notify on "stopped" (a lock held elsewhere included) and on "error": invoke the "tp-notify" skill with the Skill tool, args: ${id} · ${stage} · <the question or the diagnosis> <the PR or ticket link> level=stop (or level=error) inline=true — one message; it is a silent no-op without a chat tool, and its one-line result goes at the end of your summary. If ${claudeDir}/notify.json does not exist, first invoke the tp-notify skill with args: setup inline=true — nobody can answer here, so it records the tool and leaves the channel unset without asking.
summary: the skill's one-line report.`
}

// checkpoint hand-offs per stage invocation before it counts as not progressing: the task's rating decides
// (README § Context management, rule 7); the numbers come from tiers.json's compact.handoffs, defaults below
const HANDOFFS = { low: 2, medium: 4, high: 6, ...(tiers.compact && typeof tiers.compact.handoffs === 'object' ? tiers.compact.handoffs : {}) }
const handoffsFor = (rating) => (Number(HANDOFFS[rating]) > 0 ? Number(HANDOFFS[rating]) : HANDOFFS.medium)
const run = async (id, skill, extra, stage, phase, prev, floor = null) => {
  const rating = ratingFor(stage, prev, floor)
  let r = null
  let args = extra + tierArg(rating, floor)
  const handoffs = handoffsFor(rating)
  for (let n = 0; n <= handoffs; n++) {
    r = await agent(base(id, skill, args, stage, rating), { label: `${stage}:${id}`, phase, schema: STAGE, agentType: 'general-purpose', ...modelFor(stage, rating) })
    if (r?.status !== 'continue') break // a checkpoint: the same stage again, resuming from it
    if (!args.includes(' continue=true')) args += ' continue=true'
  }
  if (r?.status === 'continue') return { status: 'stopped', summary: r.summary, question: `hand-off budget spent — stage checkpointed ${handoffs + 1} times (the most a ${rating} stage gets is ${handoffs} hand-offs); answer continue to grant one more`, stage, data: r.data || {} }
  if (!r) { // the agent died: once more from its checkpoint (README § Failures and escalation, 2), then the error row
    if (!args.includes(' continue=true')) return run(id, skill, extra + ' continue=true', stage, phase, prev, floor)
    return { status: 'error', summary: 'stage agent returned nothing', diagnosis: 'the agent was skipped or died, twice', resume: `re-run with resumeFromRunId and args.answers["${id}"]["${stage}"] = "retry"`, needs: 'none', stage }
  }
  // harder than rated: once, one rating up, with the same arguments (the skill resumes from the state it left)
  if (r.escalate && !floor && rating !== 'high') return run(id, skill, extra + (extra.includes(' continue=true') ? '' : ' continue=true'), stage, phase, prev, bump(rating))
  return { ...r, stage }
}

// a stage the skill runs once per repo: repeat while the state's next is still that stage
const perRepo = async (prev, id, skill, extra, stage, phase) => {
  let r = prev
  for (let i = 0; i < 8; i++) {
    r = await run(id, skill, extra, stage, phase, r)
    if (r.status !== 'done' || !r.data?.next?.startsWith(stage)) break
  }
  return r
}

const results = await pipeline(
  tickets,
  // 1. start
  (_, id) => run(id, 'start-ticket', (opt.round ? ` round=${opt.round}` : '') + answersFor(id, 'start-ticket'), 'start-ticket', 'Start', null),
  // 2. triage
  (prev, id) => (prev.status !== 'done' || past('triage')) ? prev
    : run(id, 'triage', (opt.mode ? ` mode=${opt.mode}` : '') + answersFor(id, 'triage'), 'triage', 'Triage', prev),
  // 3. plan (+ plan-check inside the skill) — only when the state's next is plan, i.e. triage decided plan
  (prev, id) => (prev.status !== 'done' || ended(prev) || past('plan') || !/^plan/.test(prev.data?.next || '')) ? prev
    : run(id, 'plan', answersFor(id, 'plan'), 'plan', 'Plan', prev),
  // 4. implement — one invocation per repo
  (prev, id) => (prev.status !== 'done' || ended(prev) || past('implement')) ? prev
    : perRepo(prev, id, 'implement', answersFor(id, 'implement'), 'implement', 'Implement'),
  // 5. create-pr (gates, diff validation, the PR) — one invocation per repo
  (prev, id) => (prev.status !== 'done' || ended(prev) || past('create-pr')) ? prev
    : perRepo(prev, id, 'create-pr', answersFor(id, 'create-pr'), 'create-pr', 'PR'),
  // 6. merge (review loop, merge) — one invocation per repo; its agent is rated by the skill from the ticket and the diff
  (prev, id) => (prev.status !== 'done' || ended(prev) || past('merge')) ? prev
    : perRepo(prev, id, 'merge', (opt.merge ? ` merge=${opt.merge}` : '') + answersFor(id, 'merge'), 'merge', 'Merge'),
  // 7. release — one invocation per repo
  (prev, id) => (prev.status !== 'done' || ended(prev) || past('release')) ? prev
    : perRepo(prev, id, 'release', (opt.promote ? ` promote=${opt.promote}` : '') + answersFor(id, 'release'), 'release', 'Release'),
  // 8. accept
  (prev, id) => (prev.status !== 'done' || ended(prev) || past('accept')) ? prev
    : run(id, 'accept', (opt.where ? ` where=${opt.where}` : '') + (opt.env ? ` env=${opt.env}` : '') + answersFor(id, 'accept'), 'accept', 'Accept', prev),
  // 9. close-out (full runs only): report, optional retro, run-ticket done, unlock
  async (prev, id) => {
    if (prev.status !== 'done' || !closes) return prev
    const wd = workdir(id)
    const closeRating = opt.retro ? [ratingFor('close', prev), 'medium'].sort((a, b) => RATINGS.indexOf(b) - RATINGS.indexOf(a))[0] : ratingFor('close', prev)
    const r = await agent(`Close out ticket ${id} as step 9 of the ${SKILL}run-ticket skill describes (${claudeDir}/skills/tp-run-ticket/SKILL.md § 9. Close out).
Work directory: ${wd}. State script: ${script}. The README by reference only: node ${claudeDir}/skills/_lib/ref.mjs ${claudeDir} "<Section>[, <Item>…]" for what the step names, never the whole file.
${prev.data?.closed ? `The ticket is CLOSED early (the state's closed: ${JSON.stringify(prev.data.closed.why || '')}): do the closed-ticket close-out the skill's step 9 opens with (worktrees and never-pushed branches removed, the ticket commented with the why and what to close it as, no retro), and log run-ticket done "closed: <why>".\n` : `The run's one cleanup moment (${claudeDir}/skills/README.md § Worktrees): accept's done removed the ticket's worktrees; any still under ${wd}/wt/ go now (${claudeDir}/skills/tp-start-ticket/instructions/branch-and-pull.md § 4; a worktree another ticket's ticket.json still names stays).\n`}${opt.retro && !prev.data?.closed ? `First invoke the "tp-retro" skill with the Skill tool; the args string, verbatim: ${id}${minTier ? ` tier=${minTier}` : ''} inline=true (you are its dedicated agent; it writes retro.md / retro.json and reports proposals by target). If the skill is not installed (${claudeDir}/pipeline.json says tp-retro: false), skip it and say so in the summary.\n` : ''}Append to ${wd}/report.md: the deviations and implementation summary from plan.md, the minutes and tokens per stage (node ${script} durations ${wd}; node ${script} usage ${wd}), and every stop in progress.md with how answers.md resolved it.
Office: first node ${script} agent join ${claudeDir}/work '{ "id": "${id}:${opt.retro && !prev.data?.closed ? 'retro' : 'run-ticket'}:lead", "level": "lead", "role": "close-out", "stage": "${opt.retro && !prev.data?.closed ? 'retro' : 'run-ticket'}", "ticket": "${id}", "rating": "${closeRating}" }'; before returning node ${script} agent leave ${claudeDir}/work ${id}:${opt.retro && !prev.data?.closed ? 'retro' : 'run-ticket'}:lead done.
Then: node ${script} log ${wd} run-ticket note "tokens partial — stage leads unrecorded" (an unattended run's stage leads never report their own tokens to this script: totals for this ticket are partial, README § Unattended runs), node ${script} log ${wd} run-ticket done "<one line>" and, whatever happened above, node ${script} unlock ${wd} ${owner} — the run ends here either way.
Then invoke the "tp-notify" skill with the Skill tool, args: ${id} · done · <the one-line outcome> <the PR link> level=done inline=true (a silent no-op without a chat tool; its result goes at the end of your summary).
Finish with node ${script} state ${wd} --brief as data. Return status "done" with the one-line report in summary${opt.retro ? ' (including the retro proposal count by target)' : ''}; "error" with diagnosis, resume and needs (the error form, ${claudeDir}/skills/README.md § Failures and escalation) if any step failed.`,
      { label: `close:${id}`, phase: 'Close', schema: STAGE, agentType: 'general-purpose', ...modelFor('close', closeRating) })
    return r ? { ...r, stage: 'close' } : { status: 'error', summary: 'close-out agent returned nothing', diagnosis: 'the agent was skipped or died', stage: 'close' }
  },
)

const outcome = tickets.map((id, i) => {
  const r = results[i]
  if (!r) return { ticket: id, stage: null, status: 'error', summary: 'pipeline dropped the ticket', diagnosis: 'a stage threw; see the run journal' }
  const waiting = r.status === 'stopped' && typeof r.data?.stopped?.stage === 'string' ? r.data.stopped.stage.split(':')[0] : null
  const row = { ticket: id, stage: waiting || r.stage, status: r.status === 'stopped' ? 'needs_input' : r.status, summary: r.summary }
  if (r.status === 'stopped') row.question = r.question || null
  if (r.status === 'error') { row.diagnosis = r.diagnosis || null; row.resume = r.resume || null; row.needs = r.needs || null }
  return row
})
for (const o of outcome) log(`${o.ticket} · ${o.stage} · ${o.status}${o.question ? ' — ' + o.question : ''}${o.diagnosis ? ' — ' + o.diagnosis : ''}`)
return outcome
