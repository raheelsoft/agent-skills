// Unit tests for skills/_lib/model.mjs — the deterministic half of README § Models and budget:
// numeric evidence → rating, usage reading → budget band, rating + budget → model and effort, tiers.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { CLAUDE_DIR, tmp, rm, writeJson, readJson } from './helpers.mjs';
import { rate, budget, pick, rounds, compact, higherOf, RATINGS, dayConfig, calibrate } from '../skills/_lib/model.mjs';

const MODEL = join(CLAUDE_DIR, 'skills', '_lib', 'model.mjs');
const TIERS = { low: 'fast-model', medium: 'standard-model', high: 'strongest-model' };
const NOW = '2026-09-18T14:00:00Z';
const win = (label, percentUsed, resetsAt) => ({ label, percentUsed, resetsAt });
const usageOf = (...windows) => ({ windows });
const fiveHour = (pct) => usageOf(win('5-hour limit', pct, '2026-09-18T18:00:00Z'));

function cli(...args) {
  const r = spawnSync(process.execPath, [MODEL, ...args], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

describe('rate — numeric evidence to a rating', () => {
  it('is low with no signals and climbs with steps, flags, diff size, repos, criteria and ambiguity', () => {
    assert.deepEqual(rate({}), { rating: 'low', score: 0, why: 'no signals' });
    assert.equal(rate({ steps: 3 }).rating, 'low');
    assert.equal(rate({ steps: 3, repos: 2 }).rating, 'medium');
    assert.equal(rate({ steps: 6 }).score, 2);
    assert.equal(rate({ flags: ['data-model', 'access-control', 'public-contract', 'irreversible'] }).score, 3, 'flags cap at 3');
    assert.equal(rate({ flags: 2 }).score, 2, 'a count works too');
    assert.equal(rate({ files: 5, lines: 150 }).rating, 'medium');
    assert.equal(rate({ files: 15, lines: 500 }).rating, 'high');
    assert.equal(rate({ repos: 2, criteria: 5, unclear: true }).score, 3);
    assert.match(rate({ steps: 7, flags: 2 }).why, /2 risk flag\(s\), 7 steps/);
  });

  it('raises the rating after a failed attempt and never below medium then', () => {
    assert.equal(rate({ round: 2 }).rating, 'medium');
    assert.equal(rate({ retries: 1, files: 5 }).rating, 'medium');
    assert.equal(rate({ round: 2, flags: 2 }).rating, 'high');
    assert.equal(rate({ mechanical: true, retries: 1 }).rating, 'medium', 'a retried mechanical task is not low again');
  });

  it('keeps mechanical work low whatever its numbers, and honours thresholds', () => {
    const m = rate({ mechanical: true, steps: 9, flags: 3 });
    assert.equal(m.rating, 'low');
    assert.match(m.why, /mechanical/);
    assert.equal(rate({ steps: 7, flags: 3 }, { high: 8 }).rating, 'medium');
    assert.equal(rate({ steps: 3 }, { medium: 1 }).rating, 'medium');
  });

  it('higherOf orders ratings', () => {
    assert.equal(higherOf('low', 'high'), 'high');
    assert.equal(higherOf('medium', 'low'), 'medium');
    assert.deepEqual(RATINGS, ['low', 'medium', 'high']);
  });
});

describe('budget — usage reading to a band', () => {
  it('is unknown without a reading, ample below 70 %, economy from 70 %, stop from 90 %', () => {
    assert.equal(budget({}, TIERS).band, 'unknown');
    assert.match(budget({}, TIERS).why, /rating alone decides/);
    assert.equal(budget(fiveHour(69), TIERS, { now: NOW }).band, 'ample');
    assert.equal(budget(fiveHour(70), TIERS, { now: NOW }).band, 'economy');
    assert.equal(budget(fiveHour(89), TIERS, { now: NOW }).band, 'economy');
    assert.equal(budget(fiveHour(90), TIERS, { now: NOW }).band, 'stop');
  });

  it('goes to economy early when the pace would exhaust the window, once enough of it has elapsed', () => {
    // 60 % used with 40 % of the window elapsed → 150 % by reset → economy although under 70 %
    const pace = budget(usageOf(win('5-hour limit', 60, '2026-09-18T17:00:00Z')), TIERS, { now: NOW });
    assert.equal(pace.windows[0].projected, 150);
    assert.equal(pace.band, 'economy');
    // under 20 % elapsed the pace is not trusted; under 50 % used it is not acted on
    assert.equal(budget(usageOf(win('5-hour limit', 40, '2026-09-18T18:45:00Z')), TIERS, { now: NOW }).windows[0].projected, null);
    assert.equal(budget(usageOf(win('5-hour limit', 45, '2026-09-18T17:00:00Z')), TIERS, { now: NOW }).band, 'ample');
  });

  it('binds on the worst general window and keeps per-model windows apart, matched by the tier\'s model name', () => {
    const b = budget(usageOf(
      win('5-hour limit', 30, '2026-09-18T18:00:00Z'),
      win('Weekly · all models', 85, '2026-09-25T07:00:00Z'),
      win('Weekly · Strongest-Model', 95, '2026-09-25T07:00:00Z'),
    ), TIERS, { now: NOW });
    assert.equal(b.band, 'economy');
    assert.equal(b.binding.label, 'Weekly · all models');
    assert.deepEqual(b.tiers, { high: 'stop' });
    assert.match(b.why, /Weekly · all models at 85%.*resets 2026-09-25T07:00:00Z/);
    assert.equal(b.windows[0].hoursLeft, 4);
  });

  it('reads window lengths from labels, tolerates unknown ones, and takes thresholds from tiers.json', () => {
    const b = budget(usageOf(win('Daily', 50, '2026-09-19T02:00:00Z'), win('Something else', 50), win('Monthly', 50, '2026-10-01T00:00:00Z')), TIERS, { now: NOW });
    assert.equal(b.windows[0].projected, 100);
    assert.equal(b.windows[1].projected, null);
    assert.equal(b.windows[1].hoursLeft, null);
    assert.equal(b.band, 'economy');
    const strict = { ...TIERS, budget: { economy: 40, stop: 55 } };
    assert.equal(budget(fiveHour(45), strict, { now: NOW }).band, 'economy');
    assert.equal(budget(fiveHour(56), strict, { now: NOW }).band, 'stop');
    const app = { plan: { status: 'ok', windows: [win('5-hour limit', 92, '2026-09-18T18:00:00Z')] }, context: {} };
    assert.equal(budget(app, TIERS, { now: NOW }).band, 'stop', 'the app\'s full reading shape is accepted');
    assert.equal(budget({ windows: [{ label: 'x' }] }, TIERS).band, 'unknown', 'a window without a percent is ignored');
  });
});

describe('pick — rating and budget to a model and effort', () => {
  const p = (task) => pick({ tiers: TIERS, now: NOW, ...task });

  it('maps each rating to its tier and effort, one effort step up for catching work', () => {
    assert.deepEqual([p({ rating: 'low' }).model, p({ rating: 'low' }).effort], ['fast-model', 'low']);
    assert.deepEqual([p({ rating: 'medium' }).model, p({ rating: 'medium' }).effort], ['standard-model', 'medium']);
    assert.deepEqual([p({ rating: 'high' }).model, p({ rating: 'high' }).effort], ['strongest-model', 'high']);
    assert.equal(p({ rating: 'low', catching: true }).effort, 'medium');
    assert.equal(p({ rating: 'medium', catching: true }).effort, 'high');
    assert.equal(p({ rating: 'high', catching: true }).effort, 'max');
    assert.equal(p({ rating: 'high' }).action, 'run');
    assert.equal(p({ rating: 'high' }).why, 'the rating alone decides');
  });

  it('a floor raises but never lowers', () => {
    const r = p({ rating: 'low', floor: 'medium' });
    assert.equal(r.rating, 'medium');
    assert.match(r.why, /raised to the floor medium/);
    assert.equal(p({ rating: 'high', floor: 'medium' }).rating, 'high');
    assert.throws(() => p({ rating: 'high', floor: 'strong' }), /floor must be one of/);
    assert.throws(() => p({ rating: 'huge' }), /rating must be one of low, medium, high \(got "huge"\)/);
  });

  it('economy steps a mechanical medium task down to the fast tier and flags everything else; high work is untouched', () => {
    const mech = p({ rating: 'medium', mechanical: true, usage: fiveHour(75) });
    assert.deepEqual([mech.action, mech.rating, mech.model], ['run', 'low', 'fast-model']);
    assert.match(mech.why, /economy: a mechanical contract/);
    const think = p({ rating: 'medium', usage: fiveHour(75) });
    assert.deepEqual([think.action, think.rating], ['economy', 'medium']);
    assert.match(think.why, /fewest agents that keep the contract/);
    const high = p({ rating: 'high', usage: fiveHour(75) });
    assert.deepEqual([high.action, high.rating, high.effort], ['economy', 'high', 'high']);
    assert.equal(p({ rating: 'low', mechanical: true, usage: fiveHour(75) }).rating, 'low');
  });

  it('stops every spawn at 90 % of any window, and a high-rated spawn when the strongest tier\'s own window is out', () => {
    for (const rating of RATINGS) {
      const r = p({ rating, usage: fiveHour(91) });
      assert.equal(r.action, 'stop', rating);
      assert.match(r.why, /usage stop: 5-hour limit at 91%/);
      assert.equal(r.budget.band, 'stop');
    }
    const own = usageOf(win('5-hour limit', 20, '2026-09-18T18:00:00Z'), win('Weekly · strongest-model', 95, '2026-09-25T07:00:00Z'));
    const h = p({ rating: 'high', usage: own });
    assert.equal(h.action, 'stop');
    assert.match(h.why, /never a downgrade/);
    assert.equal(p({ rating: 'medium', usage: own }).action, 'run', 'other tiers are unaffected');
  });

  it('says what to do when no tiers are mapped', () => {
    const r = pick({ rating: 'medium' });
    assert.equal(r.model, null);
    assert.equal(r.effort, 'medium');
    assert.match(r.note, /no tiers\.json/);
  });
});

describe('rounds — the review loop controller', () => {
  const pass = (open, fresh = open) => ({ open, new: fresh });

  it('gives a pass budget from the rating and the diff size, never above the ceiling', () => {
    assert.equal(rounds({ rating: 'low' }).cap, 2);
    assert.equal(rounds({ rating: 'medium' }).cap, 3);
    assert.equal(rounds({ rating: 'high' }).cap, 4);
    assert.equal(rounds({}).cap, 3, 'an unknown rating counts as medium');
    assert.equal(rounds({ rating: 'medium', files: 15 }).cap, 4, 'a large diff earns one more pass');
    assert.equal(rounds({ rating: 'high', lines: 500 }).cap, 5);
    assert.equal(rounds({ rating: 'high', lines: 500, tiers: { review: { high: 5 } } }).cap, 5, 'the ceiling holds');
    assert.equal(rounds({ rating: 'low', tiers: { review: { low: 1 } } }).cap, 1, 'tiers.json overrides');
  });

  it('starts with a full pass, then delta passes, and makes the last budgeted pass resolution-only', () => {
    let r = rounds({ rating: 'medium', history: [] });
    assert.deepEqual([r.round, r.next, r.mode], [0, 'review', 'full']);
    r = rounds({ rating: 'medium', history: [pass(['1', '3'])] });
    assert.deepEqual([r.round, r.next, r.mode, r.open], [1, 'review', 'delta', ['1', '3']]);
    assert.match(r.why, /round 2 of 3 passes for a medium change: the delta since the reviewed sha plus a resolution check of 1, 3/);
    r = rounds({ rating: 'medium', history: [pass(['1', '3']), pass(['3'], [])] });
    assert.deepEqual([r.next, r.mode], ['review', 'resolution']);
    assert.match(r.why, /the last pass raises nothing new/);
    r = rounds({ rating: 'low', history: [pass(['1'])] });
    assert.deepEqual([r.next, r.mode], ['review', 'resolution'], 'a low change gets one full pass and one resolution check');
  });

  it('merges as soon as nothing is open', () => {
    const r = rounds({ rating: 'high', history: [pass([], [])] });
    assert.deepEqual([r.next, r.mode, r.open], ['merge', null, []]);
    assert.equal(rounds({ rating: 'medium', history: [pass(['1']), pass([], [])] }).next, 'merge');
  });

  it('stops when the budget is spent, with the open items named', () => {
    const r = rounds({ rating: 'low', history: [pass(['1', '2']), pass(['2'], [])] });
    assert.equal(r.next, 'stop');
    assert.match(r.why, /round 2 spent the budget of 2 passes for a low change; still open: 2/);
    assert.deepEqual(r.open, ['2']);
  });

  it('stops early when a pass resolves nothing, and when two passes in a row raise new items', () => {
    const stuck = rounds({ rating: 'high', history: [pass(['1', '2']), pass(['1', '2'], [])] });
    assert.equal(stuck.next, 'stop');
    assert.match(stuck.why, /resolved nothing from round 1 \(1, 2\): the fixes are not landing/);
    const churn = rounds({ rating: 'high', history: [pass(['1']), pass(['2'], ['2']), pass(['3'], ['3'])] });
    assert.equal(churn.next, 'stop');
    assert.match(churn.why, /rounds 2 and 3 both raised new items \(3\): the fixes keep introducing defects/);
    const progressing = rounds({ rating: 'high', history: [pass(['1', '2']), pass(['2', '4'], ['4'])] });
    assert.deepEqual([progressing.next, progressing.mode], ['review', 'delta'], 'one resolved and one new item is progress');
  });

  it('normalises ids and ignores malformed history entries', () => {
    const r = rounds({ rating: 'medium', history: [{ open: [1, 1, '3'], new: 'nope' }] });
    assert.deepEqual(r.open, ['1', '3']);
    assert.equal(r.next, 'review');
  });
});

describe('compact — the compaction point follows the task', () => {
  it('hands off later for a low task and earlier for a high one; the threshold is derived, not fixed', () => {
    const low = compact({ rating: 'low', percentUsed: 80, stepsLeft: 2 });
    assert.deepEqual([low.action, low.threshold], ['continue', 87]);
    assert.equal(compact({ rating: 'medium', percentUsed: 80, stepsLeft: 2 }).action, 'continue', 'exactly at the threshold the step still fits');
    const medium = compact({ rating: 'medium', percentUsed: 81, stepsLeft: 2 });
    assert.deepEqual([medium.action, medium.threshold], ['checkpoint', 80]);
    const high = compact({ rating: 'high', percentUsed: 65, stepsLeft: 2 });
    assert.deepEqual([high.action, high.threshold], ['continue', 68]);
    assert.equal(compact({ rating: 'high', percentUsed: 70, stepsLeft: 2 }).action, 'checkpoint');
    assert.equal(compact({}).rating, 'medium', 'an unknown rating counts as medium');
    assert.match(medium.why, /write the checkpoint and hand off \(1 of at most/);
  });

  it('accounts for what the next step must read and for the runtime\'s real window', () => {
    const small = compact({ rating: 'medium', used: 150000, stepsLeft: 1 });
    assert.equal(small.action, 'continue');
    const big = compact({ rating: 'medium', used: 150000, stepsLeft: 1, nextStep: { bytes: 120000 } });
    assert.equal(big.action, 'checkpoint');
    assert.ok(big.need > small.need);
    const wide = compact({ rating: 'medium', used: 150000, stepsLeft: 1, nextStep: { bytes: 120000 }, window: 1000000 });
    assert.equal(wide.action, 'continue');
    assert.equal(compact({ rating: 'low', percentUsed: 50, perStep: 100000, stepsLeft: 1 }).action, 'checkpoint', 'an observed per-step cost overrides the default');
  });

  it('finishes when nothing is left, and stops instead of a hand-off past the task\'s cap', () => {
    assert.equal(compact({ rating: 'high', percentUsed: 95, stepsLeft: 0 }).action, 'finish');
    const r = compact({ rating: 'medium', percentUsed: 85, stepsLeft: 3, stepsTotal: 3, handoffs: 3 });
    assert.equal(r.action, 'stop');
    assert.deepEqual(r.handoffs, { done: 3, max: 3 });
    assert.match(r.why, /the most a medium task with 3 steps gets is 3/);
    assert.deepEqual(compact({ rating: 'high', percentUsed: 10, stepsLeft: 9, stepsTotal: 9 }).handoffs, { done: 0, max: 6 });
    assert.deepEqual(compact({ rating: 'low', percentUsed: 10, stepsLeft: 1, stepsTotal: 1 }).handoffs, { done: 0, max: 1 }, 'never more hand-offs than steps, never fewer than one');
  });

  it('takes every number from tiers.json when given', () => {
    const tiers = { compact: { window: 100000, reserve: 0.1, perStep: { medium: 0.2 }, safety: { medium: 1 }, handoffs: { medium: 9 } } };
    const r = compact({ rating: 'medium', percentUsed: 75, stepsLeft: 2, stepsTotal: 20, tiers });
    assert.deepEqual([r.window, r.need, r.threshold, r.handoffs.max], [100000, 20000, 70, 9]);
    assert.equal(r.action, 'checkpoint');
    assert.equal(compact({ rating: 'high', percentUsed: 60, stepsLeft: 2, tiers }).handoffs.max, 2, 'unset ratings keep their defaults (capped by steps)');
  });
});

describe('CLI', () => {
  let root;
  before(() => { root = tmp(); });
  after(() => rm(root));

  it('rate, budget and pick read a JSON string or a file, and pick finds tiers.json under claudeDir', () => {
    assert.equal(cli('rate', '{"steps":7,"flags":2}').json.rating, 'high');
    writeJson(root, 'signals.json', { files: 5, thresholds: { medium: 5 } });
    assert.equal(cli('rate', join(root, 'signals.json')).json.rating, 'low');
    writeJson(root, 'tiers.json', TIERS);
    writeJson(root, 'usage.json', usageOf(win('5-hour limit', 72, '2026-09-18T18:00:00Z'), win('Weekly · strongest-model', 99, '2026-09-25T07:00:00Z')));
    const b = cli('budget', join(root, 'usage.json'), join(root, 'tiers.json'));
    assert.equal(b.code, 0);
    assert.equal(b.json.band, 'economy');
    assert.deepEqual(b.json.tiers, { high: 'stop' });
    const r = cli('pick', JSON.stringify({ rating: 'high', catching: true, claudeDir: root }));
    assert.deepEqual([r.json.model, r.json.effort], ['strongest-model', 'max']);
    const bad = cli('pick', '{"rating":"nope"}');
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /rating must be one of/);
    assert.equal(cli('rounds', '{"rating":"low","history":[{"open":["1"],"new":["1"]}]}').json.mode, 'resolution');
    assert.equal(cli('compact', '{"rating":"high","percentUsed":70,"stepsLeft":2}').json.action, 'checkpoint');
    assert.equal(cli('bogus').code, 2);
  });

  it('tiers writes and merges the mapping, validating the keys', () => {
    assert.equal(cli('tiers', join(root, 'missing'), 'low=a', 'medium=b', 'high=c').code, 2, 'the directory must exist');
    const dir = join(root, 'env'); mkdirSync(dir);
    const ok = cli('tiers', dir, 'low=a', 'medium=b', 'high=c');
    assert.equal(ok.code, 0);
    assert.deepEqual(readJson(dir, 'tiers.json'), { low: 'a', medium: 'b', high: 'c' });
    writeJson(dir, 'tiers.json', { ...readJson(dir, 'tiers.json'), budget: { economy: 60, stop: 80 } });
    cli('tiers', dir, 'low=a2', 'medium=b', 'high=c');
    assert.deepEqual(readJson(dir, 'tiers.json'), { low: 'a2', medium: 'b', high: 'c', budget: { economy: 60, stop: 80 } }, 'other settings survive');
    assert.equal(cli('tiers', dir, 'low=a').code, 2);
    assert.match(cli('tiers', dir, 'low=a', 'medium=b', 'high=c', 'max=x').stderr, /bad tier/);
  });
});

describe('retry — auto-resolve within a bound, then hand up', () => {
  const retry = (input) => cli('retry', JSON.stringify(input));

  it('a transient failure is retried with backoff up to the rating\'s bound, then escalated', () => {
    assert.deepEqual([retry({ rating: 'low', kind: 'transient', attempts: 0 }).json.action, retry({ rating: 'low', kind: 'transient', attempts: 1 }).json.action], ['retry', 'escalate']);
    const waits = [0, 1, 2].map((n) => retry({ rating: 'high', kind: 'transient', attempts: n }).json.waitSeconds);
    assert.deepEqual(waits, [15, 30, 60]);
    const spent = retry({ rating: 'high', kind: 'transient', attempts: 3 }).json;
    assert.deepEqual([spent.action, spent.max], ['escalate', 3]);
    assert.match(spent.why, /3 transient retries spent/);
  });

  it('a logic failure (own mistake, failing checkpoint) is fixed and retried without waiting, up to the same bound', () => {
    const r = retry({ rating: 'medium', kind: 'logic', attempts: 1 }).json;
    assert.deepEqual([r.action, r.waitSeconds, r.max], ['retry', 0, 2]);
    assert.equal(retry({ rating: 'medium', kind: 'logic', attempts: 2 }).json.action, 'escalate');
  });

  it('an environment failure gets the documented fallback once, then escalates', () => {
    assert.equal(retry({ rating: 'high', kind: 'environment', attempts: 0 }).json.action, 'fallback');
    assert.equal(retry({ rating: 'high', kind: 'environment', attempts: 1 }).json.action, 'escalate');
  });

  it('usage limits and decisions are never retried', () => {
    assert.equal(retry({ rating: 'high', kind: 'usage', attempts: 0 }).json.action, 'escalate');
    assert.match(retry({ rating: 'high', kind: 'decision', attempts: 0 }).json.why, /stop for the person/);
  });

  it('the bound comes from tiers.json.retries; unknown kinds count as transient, unknown ratings as medium', () => {
    const root = tmp('model-retry-');
    writeJson(root, 'tiers.json', { low: 'a', medium: 'b', high: 'c', retries: { low: 3 } });
    assert.equal(retry({ rating: 'low', kind: 'transient', attempts: 2, claudeDir: root }).json.action, 'retry');
    const r = retry({ rating: 'silly', kind: 'odd', attempts: 0 }).json;
    assert.deepEqual([r.rating, r.kind, r.max], ['medium', 'transient', 2]);
    rm(root);
  });
});

describe('estimate — a person\'s hours, with the overhead estimates forget', () => {
  const est = (input) => cli('estimate', JSON.stringify(input)).json;

  it('base hours by rating, times overhead, in half hours', () => {
    assert.deepEqual([est({ rating: 'low' }).focusedHours, est({ rating: 'medium' }).focusedHours, est({ rating: 'high' }).focusedHours], [2.5, 8, 21.5]);
    assert.equal(est({ rating: 'medium' }).basis.overhead, 0.35);
  });

  it('repos, risk flags, unclear criteria and novelty each add their share; cross-repo counts through repos', () => {
    const e = est({ rating: 'high', repos: 2, flags: ['access-control', 'cross-repo', 'data-model'], unclear: true, novelty: true });
    assert.equal(e.basis.multiplier, 2.05); // 1 + 0.25 (repo) + 0.30 (two flags) + 0.30 (unclear) + 0.20 (novelty) — cross-repo is not a flag here
    assert.equal(e.focusedHours, 44.5); // 16 × 2.05 × 1.35 = 44.28
    assert.equal(e.basis.flags, 2);
    assert.match(e.why, /2 risk flags/);
  });

  it('converts to the workday: focused hours ÷ (hours × focus), calendar hours, points', () => {
    const e = est({ rating: 'medium' });
    assert.deepEqual([e.perDay, e.days, e.calendarHours, e.points, e.unitHours], [5.2, 1.5, 12.5, 2, 5.2]);
    const root = tmp('model-est-');
    writeJson(root, 'tiers.json', { low: 'a', medium: 'b', high: 'c', day: { hours: 6, focus: 0.5 }, estimate: { base: { medium: 4 }, overhead: 0.5, unitHours: 2 } });
    const f = est({ rating: 'medium', claudeDir: root });
    assert.deepEqual([f.focusedHours, f.perDay, f.days, f.points], [6, 3, 2, 3]);
    assert.match(f.why, /a day yields 3h of focus out of 6/);
    rm(root);
  });

  it('unknown ratings count as medium; a bad focus is clamped', () => {
    assert.equal(est({ rating: 'huge' }).rating, 'medium');
    const root = tmp('model-est-');
    writeJson(root, 'tiers.json', { low: 'a', medium: 'b', high: 'c', day: { focus: 9 } });
    assert.equal(est({ rating: 'low', claudeDir: root }).perDay, 8);
    rm(root);
  });
});

describe('pick records the usage reading for the office and /tp-eod', () => {
  it('writes work/_budget.json under claudeDir when the reading has windows; never without windows or with record:false', () => {
    const root = tmp('model-pick-');
    writeJson(root, 'tiers.json', TIERS);
    pick({ rating: 'medium', claudeDir: root, usage: fiveHour(74), now: NOW });
    const b = readJson(join(root, 'work'), '_budget.json');
    assert.deepEqual([b.band, b.binding.label, b.binding.percentUsed, b.windows.length], ['economy', '5-hour limit', 74, 1]);
    assert.match(b.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(b.why, /5-hour limit at 74%/);
    pick({ rating: 'medium', claudeDir: root, usage: {}, now: NOW });
    assert.equal(readJson(join(root, 'work'), '_budget.json').band, 'economy', 'an empty reading never overwrites a good one');
    const other = tmp('model-pick-');
    pick({ rating: 'low', claudeDir: other, usage: fiveHour(10), record: false });
    assert.equal(existsSync(join(other, 'work', '_budget.json')), false);
    pick({ rating: 'low', usage: fiveHour(10) });
    rm(root); rm(other);
  });
});

describe('dayConfig — the scheduled day\'s window', () => {
  it('reads start, end and advanceEvery from tiers.json.day, rejecting bad values', () => {
    assert.deepEqual([dayConfig({}).start, dayConfig({}).end, dayConfig({}).advanceEvery], ['09:00', '18:00', 30]);
    const d = dayConfig({ day: { start: '08:30', end: '17:15', advanceEvery: 45 } });
    assert.deepEqual([d.start, d.end, d.advanceEvery], ['08:30', '17:15', 45]);
    const bad = dayConfig({ day: { start: '25:00', end: '17:00', advanceEvery: 2 } });
    assert.deepEqual([bad.start, bad.end, bad.advanceEvery], ['09:00', '17:00', 30], 'only the bad values fall back');
    const inverted = dayConfig({ day: { start: '18:00', end: '09:00' } });
    assert.deepEqual([inverted.start, inverted.end], ['09:00', '18:00']);
  });
});

describe('calibrate — the base hours learn from actuals', () => {
  const ticketDir = (root, id, { rating, estimate, actual, source = 'pipeline', minutes = 60 }) => {
    const dir = join(root, 'work', id); mkdirSync(dir, { recursive: true });
    writeJson(dir, 'ticket.json', { id, complexity: rating, estimate: { source, focusedHours: estimate, basis: { rating } }, ...(actual ? { actual: { focusedHours: actual, source: 'person', at: 'x', by: 'eod' } } : {}), repos: [] });
    writeFileSync(join(dir, 'progress.md'), `# progress\n\n- 2026-01-01T10:00Z · implement · started\n- 2026-01-01T${String(10 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}Z · implement · done · x\n`);
  };

  it('proposes a base per rating from the median actual/estimate ratio once enough samples exist, and reports pipeline minutes as shape', () => {
    const root = tmp('model-cal-');
    writeJson(root, 'tiers.json', { ...TIERS, estimate: { base: { medium: 6 } } });
    ticketDir(root, 'T-1', { rating: 'medium', estimate: 8, actual: 12, minutes: 30 });
    ticketDir(root, 'T-2', { rating: 'medium', estimate: 8, actual: 16, minutes: 90 });
    ticketDir(root, 'T-3', { rating: 'medium', estimate: 4, actual: 5, minutes: 45 });
    ticketDir(root, 'T-4', { rating: 'low', estimate: 2.5, actual: 2 });
    ticketDir(root, 'T-5', { rating: 'high', estimate: 20, actual: 30, source: 'tracker' }); // a person's estimate: counted, never a sample
    ticketDir(root, 'T-6', { rating: 'high', estimate: 20 }); // no actual yet
    mkdirSync(join(root, 'work', '_scratch'), { recursive: true });
    const c = calibrate({ claudeDir: root });
    assert.equal(c.samples, 4);
    const m = c.ratings.medium;
    assert.deepEqual([m.samples, m.current, m.medianRatio, m.proposed, m.pipelineMedianMin, m.ids.sort()], [3, 6, 1.5, 9, 45, ['T-1', 'T-2', 'T-3']]);
    assert.deepEqual([c.ratings.low.samples, c.ratings.low.proposed, c.ratings.high.samples, c.ratings.high.trackerEstimated], [1, null, 0, 1]);
    assert.match(c.drift, /medium: 3 samples, actual\/estimate 1.5× \(base 6h → 9h\)/);
    assert.match(c.drift, /low: 1 sample, actual\/estimate 0.8× \(base 2h, 2 more before a proposal\)/);
    assert.equal(c.applied, null);
    assert.equal(calibrate({ claudeDir: root, minSamples: 1 }).ratings.low.proposed, 1.5);
    // --apply writes the proposal into tiers.json and keeps everything else
    const r = cli('calibrate', JSON.stringify({ claudeDir: root }), '--apply');
    assert.deepEqual(r.json.applied, { estimate: { base: { medium: 9 } } });
    assert.deepEqual(readJson(root, 'tiers.json'), { ...TIERS, estimate: { base: { medium: 9 } } });
    rm(root);
  });

  it('says so when nothing is recorded yet', () => {
    const root = tmp('model-cal-');
    mkdirSync(join(root, 'work'));
    const c = calibrate({ workroot: join(root, 'work') });
    assert.equal(c.samples, 0);
    assert.match(c.drift, /no actuals recorded yet/);
    assert.throws(() => calibrate({}), /workroot/);
    rm(root);
  });
});
