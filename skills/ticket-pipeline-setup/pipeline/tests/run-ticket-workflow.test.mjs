// Unit tests for workflows/tp-run-ticket-unattended.js — the Workflow-tool script. The tool's runtime provides
// agent/pipeline/parallel/log/phase and `args`; here they are mocked, so what is tested is the
// script's own logic: argument validation, stage order, until=, per-repo loops, resume answers,
// lock/unlock instructions in the prompts, the close-out, and the rows it returns.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORKFLOW } from './helpers.mjs';

const SOURCE = readFileSync(WORKFLOW, 'utf8');

/** meta must be a pure literal: evaluate just that object. */
function loadMeta() {
  const m = /export const meta = (\{[\s\S]*?\n\})\n/.exec(SOURCE);
  assert.ok(m, 'meta literal found');
  return new Function(`return ${m[1]}`)();
}

/** Run the script body with mocks. `world` maps an agent label to a response or (callCount, prompt, opts) => response. */
async function runWorkflow(args, world = {}) {
  const calls = [];   // labels in order
  const prompts = {}; // label -> [prompt, ...]
  const opts = {};    // label -> [opts, ...]
  const logs = [];
  const agent = async (prompt, o = {}) => {
    const label = o.label || '?';
    calls.push(label);
    (prompts[label] ||= []).push(prompt);
    (opts[label] ||= []).push(o);
    if (!(label in world)) throw new Error(`unscripted agent: ${label}`);
    const seq = world[label];
    return typeof seq === 'function' ? seq(prompts[label].length, prompt, o) : seq;
  };
  // the Workflow tool's pipeline: each item through every stage, (prev, item, index); a throw drops the item to null
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let prev;
    for (const s of stages) { try { prev = await s(prev, item, i); } catch { return null; } }
    return prev;
  }));
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const log = (m) => logs.push(m);
  const phase = () => {};
  const body = SOURCE.replace('export const meta', 'const meta');
  const fn = new Function('args', 'agent', 'pipeline', 'parallel', 'log', 'phase', `return (async () => { ${body} })()`);
  const outcome = await fn(args, agent, pipeline, parallel, log, phase);
  return { outcome, calls, prompts, opts, logs };
}

const TIERS = { low: 'fast-model', medium: 'standard-model', high: 'strongest-model' };
const A = { claudeDir: '/x/.claude', tickets: ['T-1'], options: {}, tiers: TIERS };
const done = (next, extra = {}) => ({ status: 'done', summary: `→ ${next}`, data: { next, stopped: null, ...extra } });
const stopped = (stage, question) => ({ status: 'stopped', summary: 'stopped', question, data: { next: stage, stopped: { stage, question } } });
const direct = (n) => done('implement', { decision: 'direct' });
const CLOSE = { status: 'done', summary: 'closed', data: {} };
const fullDirect = () => ({
  'start-ticket:T-1': done('triage'), 'triage:T-1': direct(), 'implement:T-1': done('create-pr'),
  'create-pr:T-1': done('merge'), 'merge:T-1': done('release'), 'release:T-1': done('accept'), 'accept:T-1': done(null), 'close:T-1': CLOSE,
});

describe('static shape', () => {
  it('has a pure-literal meta whose phases match the phases the stages use', async () => {
    const meta = loadMeta();
    assert.equal(meta.name, 'tp-run-ticket-unattended');
    assert.ok(meta.description && meta.whenToUse);
    const titles = meta.phases.map((p) => p.title);
    assert.deepEqual(titles, ['Start', 'Triage', 'Plan', 'Implement', 'PR', 'Merge', 'Release', 'Accept', 'Close']);
    const { opts } = await runWorkflow({ ...A, options: { retro: true } }, {
      ...fullDirect(), 'triage:T-1': done('plan', { decision: 'plan' }), 'plan:T-1': done('implement'),
    });
    const used = new Set(Object.values(opts).flat().map((o) => o.phase));
    for (const u of used) assert.ok(titles.includes(u), `phase "${u}" is declared in meta`);
  });

  it('uses nothing the sandbox forbids', () => {
    for (const bad of [/Date\.now\(/, /Math\.random\(/, /new Date\(\)/, /\brequire\(/, /^import /m, /process\./, /fs\./]) {
      assert.ok(!bad.test(SOURCE), `no ${bad}`);
    }
  });

  it('gives every stage agent the structured-output schema, the general-purpose type and a stage:ticket label', async () => {
    const { opts } = await runWorkflow(A, fullDirect());
    for (const [label, list] of Object.entries(opts)) for (const o of list) {
      assert.equal(o.agentType, 'general-purpose', label);
      assert.deepEqual(o.schema.required, ['status', 'summary', 'data'], label);
      assert.deepEqual(o.schema.properties.status.enum, ['done', 'stopped', 'error', 'continue']);
      assert.match(label, /^[a-z-]+:T-1$/);
    }
  });
});

describe('argument validation', () => {
  const rejects = async (args, re) => { await assert.rejects(() => runWorkflow(args, {}), re); };
  it('requires an absolute claudeDir', async () => {
    await rejects({ tickets: ['T-1'], tiers: TIERS }, /claudeDir must be the absolute path/);
    await rejects({ claudeDir: 'relative/.claude', tickets: ['T-1'], tiers: TIERS }, /claudeDir/);
  });
  it('requires at least one ticket id, ids only', async () => {
    await rejects({ claudeDir: '/x/.claude', tickets: [], tiers: TIERS }, /at least one ticket id/);
    await rejects({ claudeDir: '/x/.claude', tiers: TIERS }, /at least one ticket id/);
    await rejects({ ...A, tickets: ['next'] }, /"next" is not a ticket id/);
    await rejects({ ...A, tickets: ['https://tracker/T-1'] }, /is not a ticket id/);
    await rejects({ ...A, tickets: ['T 1'] }, /is not a ticket id/);
    await rejects({ ...A, tickets: [42] }, /is not a ticket id/);
  });
  it('requires the tiers mapping — models are never written into the script', async () => {
    await rejects({ claudeDir: '/x/.claude', tickets: ['T-1'] }, /args\.tiers must map low, medium and high/);
    await rejects({ claudeDir: '/x/.claude', tickets: ['T-1'], tiers: { low: 'a', medium: 'b' } }, /args\.tiers/);
    assert.ok(!/haiku|sonnet|opus|claude-/.test(SOURCE), 'no model name in the script');
  });
  it('rejects an unknown until', async () => {
    await rejects({ ...A, options: { until: 'bogus' } }, /options\.until must be one of start-ticket, triage/);
  });
  it('strips a trailing slash from claudeDir', async () => {
    const { prompts } = await runWorkflow({ ...A, claudeDir: '/x/.claude/' }, { 'start-ticket:T-1': stopped('start-ticket', 'q') });
    assert.ok(prompts['start-ticket:T-1'][0].includes('/x/.claude/work/T-1'));
    assert.ok(!prompts['start-ticket:T-1'][0].includes('/x/.claude//'));
  });
});

describe('stage order and control flow', () => {
  it('runs a direct ticket through every stage and the close-out, and returns one done row', async () => {
    const { outcome, calls, logs, prompts } = await runWorkflow(A, fullDirect());
    assert.deepEqual(calls, ['start-ticket:T-1', 'triage:T-1', 'implement:T-1', 'create-pr:T-1', 'merge:T-1', 'release:T-1', 'accept:T-1', 'close:T-1']);
    assert.deepEqual(outcome, [{ ticket: 'T-1', stage: 'close', status: 'done', summary: 'closed' }]);
    assert.deepEqual(logs, ['T-1 · close · done']);
    assert.match(prompts['close:T-1'][0], /run-ticket note "tokens partial — stage leads unrecorded"/, 'an unattended run marks its token totals partial');
  });

  it('a triage that closed the ticket skips every later stage and closes out as closed', async () => {
    const closed = { ...fullDirect(), 'triage:T-1': done(null, { decision: 'close', closed: { at: 'x', why: 'superseded by T-9' } }) };
    const { calls, prompts, outcome } = await runWorkflow(A, closed);
    assert.deepEqual(calls, ['start-ticket:T-1', 'triage:T-1', 'close:T-1']);
    assert.match(prompts['close:T-1'][0], /CLOSED early[\s\S]*superseded by T-9[\s\S]*run-ticket done "closed: <why>"/);
    assert.equal(outcome[0].status, 'done');
    const { calls: withRetro, prompts: p2 } = await runWorkflow({ ...A, options: { retro: true } }, closed);
    assert.deepEqual(withRetro, ['start-ticket:T-1', 'triage:T-1', 'close:T-1']);
    assert.ok(!/invoke the "tp-retro" skill/.test(p2['close:T-1'][0]), 'no retro for a closed ticket');
  });

  it('runs plan only when the state says the next stage is plan', async () => {
    const planned = { ...fullDirect(), 'triage:T-1': done('plan', { decision: 'plan' }), 'plan:T-1': done('implement') };
    let r = await runWorkflow(A, planned);
    assert.ok(r.calls.includes('plan:T-1'));
    r = await runWorkflow(A, fullDirect());
    assert.ok(!r.calls.includes('plan:T-1'));
  });

  it('repeats a per-repo stage while next still names that stage, in order, and caps the loop', async () => {
    const world = {
      ...fullDirect(),
      'implement:T-1': (n) => (n === 1 ? done('implement:web') : done('create-pr:api')),
      'create-pr:T-1': (n) => (n === 1 ? done('create-pr:web') : done('merge:api')),
      'merge:T-1': (n) => (n === 1 ? done('merge:web') : done('release:api')),
      'release:T-1': (n) => (n === 1 ? done('release:web') : done('accept')),
    };
    const { calls } = await runWorkflow(A, world);
    const count = (l) => calls.filter((c) => c === l).length;
    assert.deepEqual([count('implement:T-1'), count('create-pr:T-1'), count('merge:T-1'), count('release:T-1')], [2, 2, 2, 2]);
    const runaway = await runWorkflow(A, { ...fullDirect(), 'implement:T-1': done('implement:again') });
    assert.equal(runaway.calls.filter((c) => c === 'implement:T-1').length, 8, 'a stage that never advances stops after 8 attempts');
    assert.equal(runaway.outcome[0].status, 'done');
  });

  it('a stop ends the ticket with needs_input, the stage and the exact question; later stages never run', async () => {
    const { outcome, calls, logs } = await runWorkflow(A, { ...fullDirect(), 'triage:T-1': stopped('triage', 'Which repo?') });
    assert.deepEqual(calls, ['start-ticket:T-1', 'triage:T-1']);
    assert.deepEqual(outcome[0], { ticket: 'T-1', stage: 'triage', status: 'needs_input', summary: 'stopped', question: 'Which repo?' });
    assert.equal(logs[0], 'T-1 · triage · needs_input — Which repo?');
  });

  it('an error ends the ticket with its diagnosis and the resume steps, never retried by the runner', async () => {
    const err = { status: 'error', summary: 'gates', diagnosis: 'tsc not found; tried: nvm path, npx — both missing', resume: '/tp-run-ticket T-1 answers=retry', needs: 'install the toolchain (README § Toolchain)', data: {} };
    const { outcome, calls, prompts } = await runWorkflow(A, { ...fullDirect(), 'implement:T-1': err });
    assert.deepEqual(calls.slice(-1), ['implement:T-1']);
    assert.equal(prompts['implement:T-1'].length, 1);
    assert.deepEqual(outcome[0], { ticket: 'T-1', stage: 'implement', status: 'error', summary: 'gates', diagnosis: err.diagnosis, resume: err.resume, needs: err.needs });
    assert.match(prompts['implement:T-1'][0], /Failures and escalation[\s\S]*resume = its resume line[\s\S]*never guess an answer or work around a permission/);
  });

  it('a dead agent (null) is re-spawned once from its checkpoint, then becomes an error row with the resume command', async () => {
    const { outcome, prompts } = await runWorkflow(A, { ...fullDirect(), 'release:T-1': null });
    assert.equal(prompts['release:T-1'].length, 2);
    assert.match(prompts['release:T-1'][1], /T-1 continue=true inline=true/);
    assert.equal(outcome[0].stage, 'release');
    assert.equal(outcome[0].status, 'error');
    assert.match(outcome[0].diagnosis, /skipped or died, twice/);
    assert.deepEqual([outcome[0].resume, outcome[0].needs], ['re-run with resumeFromRunId and args.answers["T-1"]["release"] = "retry"', 'none']);
    const { prompts: p2, outcome: o2 } = await runWorkflow(A, { ...fullDirect(), 'release:T-1': (n) => (n === 1 ? null : done('accept')) });
    assert.equal(p2['release:T-1'].length, 2);
    assert.equal(o2[0].status, 'done');
  });

  it('a stage that throws drops the ticket to an error row', async () => {
    const { outcome } = await runWorkflow(A, { ...fullDirect(), 'accept:T-1': () => { throw new Error('boom'); } });
    assert.equal(outcome[0].status, 'error');
    assert.equal(outcome[0].stage, null);
    assert.match(outcome[0].diagnosis, /a stage threw/);
  });

  it('runs several tickets independently — one stopping does not hold the others', async () => {
    const world = {};
    for (const id of ['T-1', 'T-2']) for (const [l, v] of Object.entries(fullDirect())) world[l.replace('T-1', id)] = v;
    world['triage:T-2'] = stopped('triage', 'scope?');
    const { outcome } = await runWorkflow({ ...A, tickets: ['T-1', 'T-2'] }, world);
    assert.deepEqual(outcome.map((o) => [o.ticket, o.status, o.stage]), [['T-1', 'done', 'close'], ['T-2', 'needs_input', 'triage']]);
  });
});

describe('until=', () => {
  const order = ['start-ticket', 'triage', 'plan', 'implement', 'create-pr', 'merge', 'release', 'accept'];
  const planned = () => ({ ...fullDirect(), 'triage:T-1': done('plan', { decision: 'plan' }), 'plan:T-1': done('implement') });

  it('stops after the named stage for every stage, never runs the close-out, and marks that stage final', async () => {
    for (const until of order) {
      const { calls, prompts, outcome } = await runWorkflow({ ...A, options: { until } }, planned());
      const last = calls[calls.length - 1];
      assert.equal(last, `${until}:T-1`, `until=${until} ends at that stage`);
      assert.ok(!calls.includes('close:T-1'), `until=${until} has no close-out`);
      assert.ok(order.slice(order.indexOf(until) + 1).every((s) => !calls.includes(`${s}:T-1`)), `nothing after ${until}`);
      assert.match(prompts[last][0], /This is the run's last stage: release the lock/, `${until} is told it is last`);
      assert.equal(outcome[0].stage, until);
      assert.equal(outcome[0].status, 'done');
    }
  });

  it('stages before the last one are told to unlock only on stopped or error', async () => {
    const { prompts } = await runWorkflow({ ...A, options: { until: 'implement' } }, planned());
    for (const l of ['start-ticket:T-1', 'triage:T-1', 'plan:T-1']) {
      assert.match(prompts[l][0], /On "stopped" or "error": node \/x\/\.claude\/skills\/_lib\/state\.mjs unlock \/x\/\.claude\/work\/T-1 workflow/);
      assert.doesNotMatch(prompts[l][0], /last stage/);
    }
  });

  it('a full run makes no stage final: the close-out releases the lock', async () => {
    const { prompts } = await runWorkflow(A, fullDirect());
    assert.doesNotMatch(prompts['accept:T-1'][0], /last stage/);
    assert.match(prompts['close:T-1'][0], /whatever happened above, node \/x\/\.claude\/skills\/_lib\/state\.mjs unlock \/x\/\.claude\/work\/T-1 workflow/);
    assert.match(prompts['close:T-1'][0], /run-ticket done/);
  });
});

describe('what the stage agents are told', () => {
  it('invokes the skill with the ticket, the options and inline=true on a verbatim args line', async () => {
    const { prompts } = await runWorkflow({ ...A, options: { mode: 'plan', round: 2, promote: 'release', where: 'live', env: 'staging' } }, {
      ...fullDirect(), 'triage:T-1': done('plan', { decision: 'plan' }), 'plan:T-1': done('implement'),
    });
    const argsLine = (l) => prompts[l][0].split('\n')[1];
    assert.equal(argsLine('start-ticket:T-1'), 'T-1 round=2 inline=true');
    assert.equal(argsLine('triage:T-1'), 'T-1 mode=plan inline=true');
    assert.equal(argsLine('plan:T-1'), 'T-1 inline=true');
    assert.equal(argsLine('implement:T-1'), 'T-1 inline=true');
    assert.equal(argsLine('create-pr:T-1'), 'T-1 inline=true');
    assert.equal(argsLine('merge:T-1'), 'T-1 inline=true');
    assert.equal(argsLine('release:T-1'), 'T-1 promote=release inline=true');
    const m = await runWorkflow({ ...A, options: { merge: 'auto' } }, fullDirect());
    assert.equal(m.prompts['merge:T-1'][0].split('\n')[1], 'T-1 merge=auto inline=true', 'merge= reaches /tp-merge, not /tp-create-pr');
    assert.equal(m.prompts['create-pr:T-1'][0].split('\n')[1], 'T-1 inline=true');
    assert.equal(argsLine('accept:T-1'), 'T-1 where=live env=staging inline=true');
    assert.match(prompts['start-ticket:T-1'][0], /Invoke the "tp-start-ticket" skill with the Skill tool/);
  });

  it('passes the resume answer to exactly the stage it belongs to, JSON-quoted', async () => {
    const answers = { 'T-1': { triage: 'the api repo', implement: 'use "index"\nplease', merge: 'merge' } };
    const { prompts } = await runWorkflow({ ...A, answers }, fullDirect());
    assert.equal(prompts['triage:T-1'][0].split('\n')[1], 'T-1 answers="the api repo" inline=true');
    assert.equal(prompts['implement:T-1'][0].split('\n')[1], 'T-1 answers="use \\"index\\"\\nplease" inline=true');
    assert.equal(prompts['merge:T-1'][0].split('\n')[1], 'T-1 answers="merge" inline=true', 'the review-loop answer reaches /tp-merge');
    for (const l of ['start-ticket:T-1', 'create-pr:T-1', 'release:T-1', 'accept:T-1']) assert.doesNotMatch(prompts[l][0], /answers=/);
  });

  it('uses absolute paths only, with the lock owner, and no placeholders', async () => {
    const { prompts } = await runWorkflow({ ...A, owner: 'sess-7' }, fullDirect());
    for (const list of Object.values(prompts)) for (const p of list) {
      assert.doesNotMatch(p, /<\.claude>|<workdir>|<state script>/);
      assert.ok(p.includes('/x/.claude/skills/_lib/state.mjs'));
      assert.ok(p.includes('/x/.claude/work/T-1'));
    }
    assert.match(prompts['triage:T-1'][0], /lock \/x\/\.claude\/work\/T-1 sess-7/);
    assert.match(prompts['close:T-1'][0], /unlock \/x\/\.claude\/work\/T-1 sess-7/);
    const dflt = await runWorkflow(A, fullDirect());
    assert.match(dflt.prompts['triage:T-1'][0], /lock \/x\/\.claude\/work\/T-1 workflow/);
  });

  it('tells every stage the lock, re-entry, stop and error rules', async () => {
    const { prompts } = await runWorkflow(A, fullDirect());
    const p = prompts['create-pr:T-1'][0];
    assert.match(p, /exit code 3 means another run holds this ticket: return status "stopped"/);
    assert.match(p, /already, and not stale, return status "done"/);
    assert.doesNotMatch(p, /stopped is null/, 'a done stage is never re-invoked, stopped ticket or not');
    const planned = await runWorkflow(A, { ...fullDirect(), 'triage:T-1': done('plan', { decision: 'plan' }), 'plan:T-1': done('implement') });
    assert.match(planned.prompts['plan:T-1'][0], /"plan" and "plan-check" stages are both done/, 'plan counts as done only with its check');
    assert.doesNotMatch(planned.prompts['triage:T-1'][0], /triage:<repo>/, 'no per-repo wording for a single-name stage');
    assert.match(p, /its stopped is not null → "stopped", question = stopped\.question/);
    assert.match(p, /else → "error": the skill already auto-resolved[\s\S]*diagnosis = its error and tried lines/);
    assert.match(p, /every "create-pr:<repo>" stage this invocation covered/, 'create-pr covers every repo in its one agent');
    assert.match(prompts['implement:T-1'][0], /the "implement:<repo>" stage this invocation ran/, 'implement is the one stage with an agent per repo');
    assert.match(prompts['start-ticket:T-1'][0], /work directory still does not exist.*return status "stopped"/);
    assert.match(prompts['start-ticket:T-1'][0], /log \/x\/\.claude\/work\/T-1 run-ticket started/);
  });

  it('a new round skips the already-done check for start-ticket only', async () => {
    const { prompts } = await runWorkflow({ ...A, options: { round: 2 } }, fullDirect());
    assert.match(prompts['start-ticket:T-1'][0], /skip this check \(a new round re-runs the stage\)/);
    assert.doesNotMatch(prompts['triage:T-1'][0], /skip this check/);
  });

  it('chooses each stage agent\'s model from the rating the previous stage reported, not from the stage name', async () => {
    const rated = (next, complexity, extra = {}) => done(next, { complexity, ...extra });
    const pick = (res, l, i = 0) => [res.opts[l][i].model, res.opts[l][i].effort];
    const argsLine = (res, l, i = 0) => res.prompts[l][i].split('\n')[1];
    // a low-rated ticket: pickup rates it low, triage confirms, everything after runs on the fast tier
    const low = {
      'start-ticket:T-1': rated('triage', 'low'), 'triage:T-1': rated('implement', 'low', { decision: 'direct' }),
      'implement:T-1': rated('create-pr', 'low'), 'create-pr:T-1': rated('merge', 'low'), 'merge:T-1': rated('release', 'low'), 'release:T-1': rated('accept', 'low'),
      'accept:T-1': rated(null, 'low'), 'close:T-1': CLOSE,
    };
    let r = await runWorkflow(A, low);
    assert.deepEqual(pick(r, 'start-ticket:T-1'), ['standard-model', 'medium'], 'pickup has no rating yet: bounded work');
    assert.equal(argsLine(r, 'start-ticket:T-1'), 'T-1 inline=true', 'the default rating passes no tier=');
    for (const l of ['triage:T-1', 'implement:T-1', 'create-pr:T-1', 'merge:T-1', 'release:T-1']) {
      assert.deepEqual(pick(r, l), ['fast-model', 'low'], l);
      assert.equal(argsLine(r, l), 'T-1 inline=true', `${l}: a stage's own rating is never passed down as tier= (gate runners and lookups keep their own)`);
    }
    assert.deepEqual(pick(r, 'accept:T-1'), ['fast-model', 'medium'], 'catching work runs one effort step up');
    assert.deepEqual(pick(r, 'close:T-1'), ['fast-model', 'low']);
    assert.match(r.prompts['triage:T-1'][0], /you run at the "low" rating; every agent you spawn gets an explicit model from its own task's rating and passes the budget check/);
    // the rating rises as the run learns: pickup says medium, triage says plan + high, the rest follows
    const rising = {
      'start-ticket:T-1': rated('triage', 'medium'), 'triage:T-1': rated('plan', 'high', { decision: 'plan' }), 'plan:T-1': rated('implement', 'high'),
      'implement:T-1': rated('create-pr', 'high'), 'create-pr:T-1': rated('merge', 'high'), 'merge:T-1': rated('release', 'high'), 'release:T-1': rated('accept', 'high'),
      'accept:T-1': rated(null, 'high'), 'close:T-1': CLOSE,
    };
    r = await runWorkflow(A, rising);
    assert.deepEqual(pick(r, 'triage:T-1'), ['standard-model', 'medium']);
    for (const l of ['plan:T-1', 'implement:T-1', 'create-pr:T-1', 'merge:T-1', 'release:T-1']) {
      assert.deepEqual(pick(r, l), ['strongest-model', 'high'], l);
      assert.equal(argsLine(r, l), 'T-1 inline=true', l);
    }
    assert.deepEqual(pick(r, 'accept:T-1'), ['strongest-model', 'max']);
    assert.match(r.prompts['plan:T-1'][0], /carries the ticket's current rating \(complexity\)/);
    // a per-repo loop re-reads the rating from its own previous invocation
    const loop = { ...rising, 'implement:T-1': (n) => (n === 1 ? rated('implement:web', 'medium') : rated('create-pr:api', 'medium')) };
    r = await runWorkflow(A, loop);
    assert.deepEqual([r.opts['implement:T-1'][0].model, r.opts['implement:T-1'][1].model, r.opts['create-pr:T-1'][0].model], ['strongest-model', 'standard-model', 'standard-model']);
    // no rating in the state → medium; an unknown value → medium
    r = await runWorkflow(A, fullDirect());
    for (const l of ['triage:T-1', 'implement:T-1', 'accept:T-1']) assert.equal(r.opts[l][0].model, 'standard-model', l);
    r = await runWorkflow(A, { ...fullDirect(), 'triage:T-1': rated('implement', 'enormous') });
    assert.equal(r.opts['implement:T-1'][0].model, 'standard-model');
  });

  it('re-runs a stage once, one rating up, when it reports it was harder than rated', async () => {
    const harder = { status: 'done', summary: 'harder than rated: a second area', escalate: true, data: { next: 'create-pr', complexity: 'low' } };
    const world = { ...fullDirect(), 'triage:T-1': done('implement', { decision: 'direct', complexity: 'low' }), 'implement:T-1': (n) => (n === 1 ? harder : done('create-pr', { complexity: 'medium' })) };
    const r = await runWorkflow(A, world);
    assert.equal(r.calls.filter((c) => c === 'implement:T-1').length, 2);
    assert.deepEqual([r.opts['implement:T-1'][0].model, r.opts['implement:T-1'][1].model], ['fast-model', 'standard-model']);
    assert.equal(r.prompts['implement:T-1'][1].split('\n')[1], 'T-1 continue=true tier=medium inline=true', 'the re-run carries the raised rating and resumes from the checkpoint');
    assert.match(r.prompts['implement:T-1'][0], /return escalate: true with the reason/);
    assert.equal(r.outcome[0].status, 'done');
    // an escalation from the strongest tier, or a second escalation, is not re-run again
    const always = { ...fullDirect(), 'triage:T-1': done('implement', { decision: 'direct', complexity: 'high' }), 'implement:T-1': harder };
    const top = await runWorkflow(A, always);
    assert.equal(top.calls.filter((c) => c === 'implement:T-1').length, 1);
    const twice = { ...fullDirect(), 'triage:T-1': done('implement', { decision: 'direct', complexity: 'low' }), 'implement:T-1': harder };
    const t2 = await runWorkflow(A, twice);
    assert.equal(t2.calls.filter((c) => c === 'implement:T-1').length, 2);
    assert.deepEqual([t2.opts['implement:T-1'][0].model, t2.opts['implement:T-1'][1].model], ['fast-model', 'standard-model']);
  });

  it('tier= is a floor for every agent and is forwarded to every skill; strong means high', async () => {
    const planned = { ...fullDirect(), 'triage:T-1': done('plan', { decision: 'plan', complexity: 'low' }), 'plan:T-1': done('implement', { complexity: 'low' }) };
    const strong = await runWorkflow({ ...A, options: { retro: true, tier: 'strong' } }, planned);
    for (const [label, list] of Object.entries(strong.opts)) for (const o of list) assert.equal(o.model, 'strongest-model', label);
    assert.equal(strong.opts['accept:T-1'][0].effort, 'max');
    assert.equal(strong.opts['close:T-1'][0].effort, 'high');
    for (const l of ['start-ticket:T-1', 'triage:T-1', 'plan:T-1', 'implement:T-1', 'create-pr:T-1', 'merge:T-1', 'release:T-1', 'accept:T-1']) {
      assert.match(strong.prompts[l][0].split('\n')[1], / tier=high inline=true$/, l);
    }
    assert.match(strong.prompts['close:T-1'][0], /verbatim: T-1 tier=high inline=true/);
    const floor = await runWorkflow({ ...A, options: { tier: 'medium' } }, planned);
    for (const l of ['triage:T-1', 'plan:T-1', 'implement:T-1']) {
      assert.equal(floor.opts[l][0].model, 'standard-model', `${l}: a low rating is raised to the floor`);
      assert.equal(floor.prompts[l][0].split('\n')[1], 'T-1 tier=medium inline=true');
    }
    const above = await runWorkflow({ ...A, options: { tier: 'low' } }, { ...fullDirect(), 'triage:T-1': done('implement', { decision: 'direct', complexity: 'high' }) });
    assert.equal(above.opts['implement:T-1'][0].model, 'strongest-model', 'a floor never lowers a rating');
    await assert.rejects(() => runWorkflow({ ...A, options: { tier: 'huge' } }, {}), /options\.tier must be low, medium, high or strong/);
  });

  it('re-runs a stage that checkpointed with continue=true, on the same model, and gives up after the rating\'s hand-off cap', async () => {
    const cont = { status: 'continue', summary: '/x/.claude/work/T-1/checkpoint.implement.md', data: { next: 'implement', complexity: 'medium' } };
    // two hand-offs, then done
    let r = await runWorkflow(A, { ...fullDirect(), 'implement:T-1': (n) => (n <= 2 ? cont : done('create-pr', { complexity: 'medium' })) });
    assert.equal(r.calls.filter((c) => c === 'implement:T-1').length, 3);
    assert.doesNotMatch(r.prompts['implement:T-1'][0].split('\n')[1], /continue=true/, 'the first run starts fresh');
    assert.match(r.prompts['implement:T-1'][1].split('\n')[1], /^T-1 continue=true inline=true$/, 'the second resumes from the checkpoint');
    assert.match(r.prompts['implement:T-1'][2].split('\n')[1], /^T-1 continue=true inline=true$/, 'continue=true is added once');
    assert.deepEqual(new Set(r.opts['implement:T-1'].map((o) => o.model)), new Set(['standard-model']), 'a hand-off keeps the rating');
    assert.equal(r.outcome[0].status, 'done');
    assert.match(r.prompts['implement:T-1'][0], /return status "continue" with the checkpoint path in summary/);
    // a stage that never finishes: a medium stage gets four hand-offs, a high one six, a low one two — from tiers.json, not the script
    r = await runWorkflow(A, { ...fullDirect(), 'implement:T-1': cont });
    assert.equal(r.calls.filter((c) => c === 'implement:T-1').length, 5, 'one run plus four continuations for a medium stage');
    assert.equal(r.outcome[0].status, 'needs_input', 'the cap is a stop a person answers, not an error');
    assert.match(r.outcome[0].question, /hand-off budget spent — stage checkpointed 5 times \(the most a medium stage gets is 4 hand-offs\); answer continue/);
    assert.ok(!r.calls.includes('create-pr:T-1'));
    const highCont = { ...cont, data: { next: 'implement', complexity: 'high' } };
    r = await runWorkflow(A, { ...fullDirect(), 'triage:T-1': done('implement', { decision: 'direct', complexity: 'high' }), 'implement:T-1': highCont });
    assert.equal(r.calls.filter((c) => c === 'implement:T-1').length, 7, 'one run plus six continuations for a high stage');
    r = await runWorkflow({ ...A, tiers: { ...TIERS, compact: { handoffs: { medium: 1 } } } }, { ...fullDirect(), 'implement:T-1': cont });
    assert.equal(r.calls.filter((c) => c === 'implement:T-1').length, 2, 'tiers.json overrides the cap');
    assert.match(r.prompts['implement:T-1'][0], /model\.mjs compact '\{ rating: "medium"/, 'the stage is told to ask the compaction rule at every step boundary');
    // a hand-off inside a per-repo loop does not break the loop
    r = await runWorkflow(A, { ...fullDirect(), 'implement:T-1': (n) => (n === 1 ? cont : n === 2 ? done('implement:web', { complexity: 'medium' }) : done('create-pr:api', { complexity: 'medium' })) });
    assert.equal(r.calls.filter((c) => c === 'implement:T-1').length, 3);
    assert.equal(r.outcome[0].status, 'done');
  });

  it('tells every stage to notify through the skill on a stop or error, and the close-out on done', async () => {
    const { prompts } = await runWorkflow(A, fullDirect());
    for (const l of ['start-ticket:T-1', 'triage:T-1', 'implement:T-1', 'create-pr:T-1', 'merge:T-1', 'release:T-1', 'accept:T-1']) {
      assert.match(prompts[l][0], /Notify on "stopped" \(a lock held elsewhere included\) and on "error": invoke the "tp-notify" skill/, l);
      assert.match(prompts[l][0], /level=stop/, l);
      assert.match(prompts[l][0], /silent no-op without a chat tool/, l);
      assert.match(prompts[l][0], /\/x\/\.claude\/notify\.json does not exist, first invoke the tp-notify skill with args: setup inline=true/, l);
      assert.match(prompts[l][0], /level=stop \(or level=error\) inline=true/, `${l}: notify runs inline in the stage agent`);
    }
    assert.match(prompts['close:T-1'][0], /invoke the "tp-notify" skill with the Skill tool, args: T-1 · done · .* level=done/);
    assert.doesNotMatch(prompts['close:T-1'][0], /level=stop/);
  });

  it('tells every stage agent to take a desk in the office and leave it, and the close-out too', async () => {
    const { prompts } = await runWorkflow(A, fullDirect());
    for (const l of ['start-ticket:T-1', 'triage:T-1', 'implement:T-1', 'create-pr:T-1', 'merge:T-1', 'release:T-1', 'accept:T-1']) {
      const stage = l.split(':')[0];
      assert.match(prompts[l][0], /agent join \/x\/\.claude\/work '\{ "id": "T-1:<stage>:lead", "level": "lead", "stage": "<stage>"/, l);
      // only implement takes a desk per repo: the other stages cover every repo in one agent (README rule 9)
      assert.match(prompts[l][0], new RegExp(`<stage> being the stage as the state names it \\(${stage === 'implement' ? `${stage}:<repo> on a cross-repo ticket, else ` : ''}${stage}\\)`), l);
      assert.match(prompts[l][0], /agent leave \/x\/\.claude\/work T-1:<stage>:lead <done\|stopped\|gone>/, l);
      assert.match(prompts[l][0], /pass that id as the parent of every agent you spawn/, l);
    }
    assert.match(prompts['implement:T-1'][0], /implement:<repo> on a cross-repo ticket/, 'the one stage with an agent per repo is told the suffixed stage name');
    assert.doesNotMatch(prompts['triage:T-1'][0], /triage:<repo>/);
    for (const l of ['create-pr:T-1', 'merge:T-1', 'release:T-1']) assert.doesNotMatch(prompts[l][0], /<repo> on a cross-repo ticket/, `${l} takes one desk for the whole ticket`);
    assert.match(prompts['close:T-1'][0], /agent join \/x\/\.claude\/work '\{ "id": "T-1:run-ticket:lead", "level": "lead", "role": "close-out", "stage": "run-ticket", "ticket": "T-1", "rating": "low"/);
    assert.match(prompts['close:T-1'][0], /agent leave \/x\/\.claude\/work T-1:run-ticket:lead done/);
    const { prompts: withRetro } = await runWorkflow({ ...A, options: { retro: true } }, fullDirect());
    assert.match(withRetro['close:T-1'][0], /agent join \/x\/\.claude\/work '\{ "id": "T-1:retro:lead", "level": "lead", "role": "close-out", "stage": "retro"/, "with retro the close-out is retro's lead");
  });

  it('the close-out runs retro inline only when asked', async () => {
    let r = await runWorkflow({ ...A, options: { retro: true } }, fullDirect());
    assert.match(r.prompts['close:T-1'][0], /invoke the "tp-retro" skill with the Skill tool; the args string, verbatim: T-1 inline=true/);
    assert.match(r.prompts['close:T-1'][0], /retro proposal count by target/);
    r = await runWorkflow(A, fullDirect());
    assert.doesNotMatch(r.prompts['close:T-1'][0], /retro/);
    assert.match(r.prompts['close:T-1'][0], /step 9 of the tp-run-ticket skill/);
    assert.match(r.prompts['close:T-1'][0], /durations \/x\/\.claude\/work\/T-1/);
  });
});
