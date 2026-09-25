#!/usr/bin/env node
// The deterministic half of skills/README.md § Models and budget. The rubric there rates a task
// low | medium | high; this script turns numbers into a rating, a usage reading into a budget band,
// and a rating into the model and effort to spawn with — from the environment's own tiers.json,
// never from a name written into a skill.
//
//   node model.mjs rate   <signals.json | '{…}'>              -> { rating, score, why }
//   node model.mjs budget <usage.json | '{…}'> [tiers.json]   -> { band, binding, windows, tiers, why }
//   node model.mjs pick   <task.json | '{…}'>                 -> { action, rating, model, effort, budget, why }
//   node model.mjs rounds <review.json | '{…}'>               -> { cap, round, next, mode, open, why }
//   node model.mjs compact <context.json | '{…}'>             -> { action, rating, used, window, headroom, need, threshold, handoffs, why }
//   node model.mjs retry '{ rating, kind, attempts, claudeDir }' -> { action: retry|fallback|escalate, kind, rating, attempts, max, waitSeconds, why }
//   node model.mjs estimate '{ rating, repos, flags, unclear, novelty, claudeDir }' -> { focusedHours, calendarHours, days, points, perDay, basis, why }
//   node model.mjs calibrate '{ workroot, claudeDir, minSamples? }' [--apply] -> { samples, ratings: { <rating>: { samples, current, medianRatio,
//                                                proposed, pipelineMedianMin, ids } }, drift, applied } — the base hours proposed from the
//                                                person's recorded actuals (README § Models and budget, Estimates); --apply writes them
//   node model.mjs tiers  <.claude> low=<model> medium=<model> high=<model>   -> writes <.claude>/tiers.json
//
// signals: { steps, flags: [] | n, files, lines, repos, criteria, round, retries, unclear, mechanical, claudeDir? }
// Every command takes claudeDir (or tiers) so tiers.json's mapping and overrides apply; without it the
// defaults apply and pick returns model: null.
// usage:   the runtime's reading — { windows: [{ label, percentUsed, resetsAt }] } (extra fields ignored;
//          the app's { plan: { windows } } shape is accepted as is)
// task:    { rating, catching?, mechanical?, floor?, usage?, tiers?, claudeDir?, now?, record? }
//   rating    the rubric's rating (or `rate`'s — the higher wins, decided by the caller)
//   catching  work that exists to catch what others missed (a check, a review, evidence): one effort step up
//   mechanical the contract is a command, a lookup or a format: eligible for the economy step-down
//   floor     tier= from the invocation: no rating below it
//   record    (default true) with claudeDir and a usage reading that has windows, pick records the reading in
//             <claudeDir>/work/_budget.json — the budget gauge the office and /tp-eod show — as a side effect
// review:  { rating, files, lines, history: [{ round, open: [ids], new: [ids] }, …] } — one entry per pass posted so far
// context: { rating, used (tokens the agent estimates it holds) | percentUsed, window?, stepsLeft, stepsTotal?,
//            nextStep?: { bytes } (what the next step must read), handoffs? (hand-offs so far), perStep? }
// tiers.json: { low, medium, high, budget?: { economy: 70, stop: 90 }, thresholds?: { medium: 2, high: 4 },
//               review?: { low: 2, medium: 3, high: 4, max: 5 },
//               compact?: { window: 200000, reserve: 0.08, perStep: { low: 0.04, medium: 0.08, high: 0.12 },
//                           safety: { low: 1.2, medium: 1.5, high: 2 }, handoffs: { low: 2, medium: 4, high: 6 } },
//               retries?: { low: 1, medium: 2, high: 3 } (auto-resolve bound, README § Failures and escalation),
//               estimate?: { base: { low: 2, medium: 6, high: 16 }, perRepo: 0.25, perFlag: 0.15, unclear: 0.3, novelty: 0.2,
//                            overhead: 0.35, unitHours: null, minSamples: 3 } (a person's focused hours — README § Models and budget,
//                            Estimates; minSamples: actuals per rating before calibrate proposes a base),
//               day?: { lanes: { ample: "all", economy: 1, stop: 0, unknown: "all" }, draw: 6,  (day.mjs: lanes and the pool draw)
//                       hours: 8, focus: 0.65, switch: 0.5, slack: 0.5, attend: 0.25, carry: true,  (the person's workday, dayConfig)
//                       start: "09:00", end: "18:00", advanceEvery: 30 },                          (/tp-schedule: the scheduled day's window)
//               prices?: { low, medium, high } ($ per 1M tokens, blended — state.mjs usage prices "tokens=<n> tier=<rating>" notes),
//               doctor?: { maxAgeHours: 24, timeoutMs: 8000, checks: [{ name, run: [argv], expect? }] } (doctor.mjs: the preflight) }
// No dependencies.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
function writeAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

export const RATINGS = ['low', 'medium', 'high'];
const EFFORT = ['low', 'medium', 'high', 'max'];
const DEFAULT_BUDGET = { economy: 70, stop: 90 }; // percent used of any window
const DEFAULT_THRESHOLDS = { medium: 2, high: 4 }; // score → rating
const DEFAULT_REVIEW = { low: 2, medium: 3, high: 4, max: 5 }; // reviewer passes a PR may get, by the change's rating
const DEFAULT_RETRIES = { low: 1, medium: 2, high: 3 }; // re-tries a failure gets before it is handed up, by the task's rating
// A person's workday, not an agent's: `hours` at the desk, `focus` the share that is engineering time once meetings,
// breaks, mail and admin are gone, `switch` the hours lost to every extra ticket worked in the same day, `slack` how far
// a day may run over rather than carry a sliver to tomorrow, `attend` the share of a running ticket's estimate the person
// still spends on it (answers, reviews, testing) while the pipeline works it, `carry` whether a ticket may start on a
// day that cannot finish it. day.mjs reads the same block for lanes and the pool draw.
export const DEFAULT_DAY = { hours: 8, focus: 0.65, switch: 0.5, slack: 0.5, attend: 0.25, carry: true, start: '09:00', end: '18:00', advanceEvery: 30 };
// Focused hours a person needs, by rating, before the multipliers — and the overhead every estimate forgets:
// debugging, review rounds, verification, rework. `unitHours` maps hours onto the tracker's points (null = one focused day).
const DEFAULT_ESTIMATE = { base: { low: 2, medium: 6, high: 16 }, perRepo: 0.25, perFlag: 0.15, unclear: 0.3, novelty: 0.2, overhead: 0.35, unitHours: null, minSamples: 3 };
const RISK_FLAGS = new Set(['data-model', 'access-control', 'public-contract', 'irreversible']); // cross-repo is the repos count
const half = (n) => Math.round(n * 2) / 2;
const RETRY_KINDS = ['transient', 'environment', 'logic', 'usage', 'decision'];
const DEFAULT_COMPACT = { // when an agent hands its remaining work to a fresh one (README § Context management, rule 7)
  window: 200000,                                   // tokens an agent's context holds when the runtime does not say
  reserve: 0.08,                                    // share of the window kept free for the checkpoint and the report
  perStep: { low: 0.04, medium: 0.08, high: 0.12 }, // share of the window one step of a task of that rating takes in
  safety: { low: 1.2, medium: 1.5, high: 2 },       // headroom multiplier: deeper reasoning per step needs more room
  handoffs: { low: 2, medium: 4, high: 6 },         // hand-offs one invocation may make before it counts as not progressing
};

function readArg(arg) {
  if (arg == null) return {};
  if (existsSync(arg)) return JSON.parse(readFileSync(arg, 'utf8'));
  return JSON.parse(arg);
}

function readTiers(task) {
  if (task.tiers && typeof task.tiers === 'object') return task.tiers;
  const file = task.claudeDir ? join(task.claudeDir, 'tiers.json') : null;
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

const at = (r) => RATINGS.indexOf(r);
export const higherOf = (a, b) => (at(a) >= at(b) ? a : b);

/** Numeric evidence → rating. The rubric's own judgment wins where it is higher. */
export function rate(s = {}, thresholds = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const why = [];
  let n = 0;
  const flags = Array.isArray(s.flags) ? s.flags.length : Number(s.flags) || 0;
  if (flags) { n += Math.min(3, flags); why.push(`${flags} risk flag(s)`); }
  if (s.steps >= 6) { n += 2; why.push(`${s.steps} steps`); } else if (s.steps >= 3) { n += 1; why.push(`${s.steps} steps`); }
  if (s.files >= 15) { n += 2; why.push(`${s.files} files`); } else if (s.files >= 5) { n += 1; why.push(`${s.files} files`); }
  if (s.lines >= 500) { n += 2; why.push(`${s.lines} lines`); } else if (s.lines >= 150) { n += 1; why.push(`${s.lines} lines`); }
  if (s.repos > 1) { n += 1; why.push(`${s.repos} repos`); }
  if (s.criteria >= 5) { n += 1; why.push(`${s.criteria} criteria`); }
  if (s.unclear) { n += 1; why.push('unclear'); }
  if (s.round > 1 || s.retries >= 1) { n += 2; why.push('after a failed attempt'); }
  let rating = n >= th.high ? 'high' : n >= th.medium ? 'medium' : 'low';
  if (s.mechanical && !(s.round > 1 || s.retries >= 1)) { rating = 'low'; why.push('mechanical: verifiable output'); }
  return { rating, score: n, why: why.join(', ') || 'no signals' };
}

function windowHours(label = '') {
  const h = /(\d+)\s*-?\s*hour/i.exec(label);
  if (h) return Number(h[1]);
  if (/week/i.test(label)) return 168;
  if (/\bda(y|ily)\b/i.test(label)) return 24;
  if (/month/i.test(label)) return 720;
  return null;
}

/** Usage reading → budget band: ample (rating decides) | economy (70 %+) | stop (90 %+). */
export function budget(usage = {}, tiers = {}, opts = {}) {
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const limits = { ...DEFAULT_BUDGET, ...(tiers.budget || {}) };
  const raw = Array.isArray(usage.windows) ? usage.windows : Array.isArray(usage.plan?.windows) ? usage.plan.windows : [];
  const names = Object.fromEntries(RATINGS.filter((r) => typeof tiers[r] === 'string').map((r) => [r, tiers[r].toLowerCase()]));
  const windows = raw.filter((w) => w && typeof w.percentUsed === 'number').map((w) => {
    const length = windowHours(w.label);
    const hoursLeft = w.resetsAt ? Math.max(0, (Date.parse(w.resetsAt) - now) / 3600000) : null;
    const elapsed = length && hoursLeft != null ? Math.min(1, Math.max(0, 1 - hoursLeft / length)) : null;
    const projected = elapsed != null && elapsed >= 0.2 ? Math.round(w.percentUsed / elapsed) : null; // usage at reset, at this pace
    const band = w.percentUsed >= limits.stop ? 'stop'
      : (w.percentUsed >= limits.economy || (projected != null && projected >= 100 && w.percentUsed >= 50)) ? 'economy' : 'ample';
    const label = String(w.label || '');
    const tier = Object.entries(names).find(([, name]) => name && label.toLowerCase().includes(name))?.[0] || null;
    return { label, percentUsed: w.percentUsed, hoursLeft: hoursLeft == null ? null : Math.round(hoursLeft * 10) / 10, projected, band, tier, resetsAt: w.resetsAt || null };
  });
  const rank = { ample: 0, economy: 1, stop: 2 };
  const general = windows.filter((w) => !w.tier).sort((a, b) => rank[b.band] - rank[a.band] || b.percentUsed - a.percentUsed);
  const binding = general[0] || null;
  const perTier = Object.fromEntries(windows.filter((w) => w.tier).map((w) => [w.tier, w.band]));
  const band = windows.length ? (binding ? binding.band : 'ample') : 'unknown';
  const why = !windows.length ? 'no usage reading: the rating alone decides'
    : `${binding.label} at ${binding.percentUsed}%${binding.projected != null ? ` (${binding.projected}% by reset at this pace)` : ''}${binding.resetsAt ? `, resets ${binding.resetsAt}` : ''}`;
  return { band, binding, windows, tiers: perTier, why };
}

/** A rating (+ floor, catching, mechanical) and the budget → what to spawn with. */
export function pick(task = {}) {
  if (!RATINGS.includes(task.rating)) throw new Error(`rating must be one of ${RATINGS.join(', ')} (got "${task.rating}")`);
  if (task.floor != null && !RATINGS.includes(task.floor)) throw new Error(`floor must be one of ${RATINGS.join(', ')}`);
  const tiers = readTiers(task);
  const why = [];
  let rating = task.floor ? higherOf(task.rating, task.floor) : task.rating;
  if (rating !== task.rating) why.push(`raised to the floor ${task.floor}`);
  const b = budget(task.usage || {}, tiers, { now: task.now });
  // the reading, recorded for the office's gauge and /tp-eod — only a reading with windows, never over a good one with "unknown"
  if (task.claudeDir && task.record !== false && b.windows.length) {
    try { writeAtomic(join(task.claudeDir, 'work', '_budget.json'), { at: nowIso(), band: b.band, binding: b.binding, windows: b.windows, tiers: b.tiers, why: b.why }); } catch { /* a read-only install: the gauge just stays empty */ }
  }
  let action = 'run';
  if (b.band === 'stop') { action = 'stop'; why.push(`usage stop: ${b.why}`); }
  else if (b.tiers[rating] === 'stop') { action = 'stop'; why.push(`the ${rating} tier's own window is at its limit — never a downgrade to squeeze under it`); }
  else if (b.band === 'economy') {
    if (task.mechanical && rating === 'medium') { rating = 'low'; why.push(`economy: a mechanical contract runs on the fast tier (${b.why})`); }
    else { action = 'economy'; why.push(`economy: fewest agents that keep the contract (${b.why})`); }
  }
  let effort = at(rating);
  if (task.catching) effort = Math.min(EFFORT.length - 1, effort + 1);
  return {
    action, rating, model: typeof tiers[rating] === 'string' ? tiers[rating] : null, effort: EFFORT[effort],
    budget: { band: b.band, why: b.why, tiers: b.tiers },
    why: why.join('; ') || 'the rating alone decides',
    ...(RATINGS.some((r) => typeof tiers[r] === 'string') ? {} : { note: 'no tiers.json — map the ratings to this environment\'s models: node model.mjs tiers <.claude> low=… medium=… high=…' }),
  };
}

/**
 * The review loop's next step, from the change's complexity and what the passes so far left open.
 * Every pass after the first is incremental (a resolution check plus, in delta mode, the commits since the
 * reviewed sha); the budget's last pass is resolution only, so it can raise nothing new; and the loop ends
 * early when it stops converging — nothing resolved, or new items in two passes running.
 */
export function rounds(input = {}) {
  const tiers = readTiers(input);
  const cfg = { ...DEFAULT_REVIEW, ...(tiers.review || {}) };
  const rating = RATINGS.includes(input.rating) ? input.rating : 'medium';
  const large = input.files >= 15 || input.lines >= 500;
  const cap = Math.min(cfg.max, cfg[rating] + (large ? 1 : 0));
  const history = Array.isArray(input.history) ? input.history : [];
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((i) => i && i.toLowerCase() !== 'none'))];
  const round = history.length;
  const last = history[round - 1];
  const prev = history[round - 2];
  const open = last ? ids(last.open) : [];
  const fresh = last ? ids(last.new) : [];
  const budget = `${cap} pass${cap === 1 ? '' : 'es'} for a ${rating} change${large ? ' with a large diff' : ''}`;
  let next; let mode = null; let why;
  if (!last) { next = 'review'; mode = 'full'; why = `round 1 of ${budget}: the full diff`; }
  else if (!open.length) { next = 'merge'; why = `round ${round}: every fix-before-merging item is resolved`; }
  else if (round >= cap) { next = 'stop'; why = `round ${round} spent the budget of ${budget}; still open: ${open.join(', ')}`; }
  else if (prev && ids(prev.open).length && ids(prev.open).every((i) => open.includes(i)) && !fresh.length) {
    next = 'stop'; why = `round ${round} resolved nothing from round ${round - 1} (${open.join(', ')}): the fixes are not landing — a person decides`;
  } else if (round >= 3 && fresh.length && ids(prev.new).length) { // the first pass's items are the baseline, not churn
    next = 'stop'; why = `rounds ${round - 1} and ${round} both raised new items (${fresh.join(', ')}): the fixes keep introducing defects — a person decides`;
  } else {
    mode = round + 1 === cap ? 'resolution' : 'delta';
    next = 'review';
    why = `round ${round + 1} of ${budget}: ${mode === 'resolution' ? 'resolution check only — the last pass raises nothing new' : 'the delta since the reviewed sha plus a resolution check of ' + open.join(', ')}`;
  }
  return { cap, round, next, mode, open, why };
}

/**
 * Compaction at a step boundary: hand the remaining work to a fresh agent when the next step would not
 * fit in the context that is left — the point is derived from the task's rating and size, never a fixed
 * percentage. `used` is the agent's own estimate (the runtime reports only the session's window).
 */
export function compact(input = {}) {
  const tiers = readTiers(input);
  const cfg = { ...DEFAULT_COMPACT, ...(tiers.compact || {}) };
  for (const k of ['perStep', 'safety', 'handoffs']) cfg[k] = { ...DEFAULT_COMPACT[k], ...(tiers.compact?.[k] || {}) };
  const rating = RATINGS.includes(input.rating) ? input.rating : 'medium';
  const window = Number(input.window) > 0 ? Number(input.window) : cfg.window;
  const used = Number(input.used) >= 0 ? Number(input.used) : Number(input.percentUsed) >= 0 ? Math.round(window * Number(input.percentUsed) / 100) : 0;
  const stepsLeft = Number(input.stepsLeft) >= 0 ? Number(input.stepsLeft) : 1;
  const stepsTotal = Number(input.stepsTotal) > 0 ? Number(input.stepsTotal) : Math.max(1, stepsLeft);
  const handoffsSoFar = Number(input.handoffs) >= 0 ? Number(input.handoffs) : 0;
  const maxHandoffs = Math.max(1, Math.min(cfg.handoffs[rating], stepsTotal));
  const reserve = Math.round(window * cfg.reserve);
  const perStep = Number(input.perStep) > 0 ? Number(input.perStep) : Math.round(window * cfg.perStep[rating]);
  const nextRead = input.nextStep && Number(input.nextStep.bytes) > 0 ? Math.round(Number(input.nextStep.bytes) / 4) : 0;
  const need = Math.round(Math.max(perStep, nextRead + Math.round(perStep / 2)) * cfg.safety[rating]);
  const headroom = window - used - reserve;
  const threshold = Math.max(0, Math.round((1 - cfg.reserve - (need / window)) * 100)); // percent used at which this task hands off
  const pct = Math.round((used / window) * 100);
  let action; let why;
  if (stepsLeft === 0) { action = 'finish'; why = `no steps left: finish and report (${pct}% used)`; }
  else if (headroom >= need) { action = 'continue'; why = `the next step needs ~${need} tokens and ${headroom} are left (${pct}% used; this ${rating} task hands off at ~${threshold}%)`; }
  else if (handoffsSoFar >= maxHandoffs) { action = 'stop'; why = `the next step needs ~${need} tokens, ${headroom} are left, and ${handoffsSoFar} hand-off${handoffsSoFar === 1 ? '' : 's'} already happened (the most a ${rating} task with ${stepsTotal} step${stepsTotal === 1 ? '' : 's'} gets is ${maxHandoffs}) — not progressing; a person decides`; }
  else { action = 'checkpoint'; why = `the next step needs ~${need} tokens and only ${headroom} are left (${pct}% used): write the checkpoint and hand off (${handoffsSoFar + 1} of at most ${maxHandoffs})`; }
  return { action, rating, used, window, headroom, need, threshold, handoffs: { done: handoffsSoFar, max: maxHandoffs }, why };
}

/**
 * Auto-resolve before escalating (README § Failures and escalation): what a failure of `kind` gets after `attempts`
 * tries. transient (network, 429/5xx, a busy resource, a flaky command): retry with backoff up to the rating's bound;
 * environment (a missing tool, expired auth, a denied permission): the documented fallback once, then escalate;
 * logic (the agent's own mistake, a failing checkpoint, a gate its change broke): fix and retry up to the bound;
 * usage: escalate at once (the usage pause); decision: escalate at once (a stop for the person, never a retry).
 */
export function retry(input = {}) {
  const tiers = readTiers(input);
  const cfg = { ...DEFAULT_RETRIES, ...(tiers.retries || {}) };
  const rating = RATINGS.includes(input.rating) ? input.rating : 'medium';
  const kind = RETRY_KINDS.includes(input.kind) ? input.kind : 'transient';
  const attempts = Number(input.attempts) >= 0 ? Math.floor(Number(input.attempts)) : 0;
  const max = Math.max(0, Number(cfg[rating]) || 0);
  let action; let waitSeconds = 0; let why;
  if (kind === 'usage') { action = 'escalate'; why = 'a usage limit is never retried — log the usage pause and stop'; }
  else if (kind === 'decision') { action = 'escalate'; why = 'a decision, an answer or a permission is a stop for the person, never a retry'; }
  else if (kind === 'environment') {
    if (attempts === 0) { action = 'fallback'; why = 'try the documented alternative once (README § Remote access failures, § Toolchain) — never a change to credentials, remotes or shell config'; }
    else { action = 'escalate'; why = 'the fallback failed too — checkpoint and hand up with the resume steps'; }
  } else if (attempts < max) {
    action = 'retry';
    waitSeconds = kind === 'transient' ? Math.min(120, 15 * 2 ** attempts) : 0;
    why = `${kind} failure: attempt ${attempts + 1} of ${max} for a ${rating} task${waitSeconds ? ` after ${waitSeconds}s` : ''}`;
  } else { action = 'escalate'; why = `${max} ${kind} retr${max === 1 ? 'y' : 'ies'} spent (the bound for a ${rating} task) — checkpoint and hand up with the resume steps`; }
  return { action, kind, rating, attempts, max, waitSeconds, why };
}

/** The person's day: tiers.json.day over the defaults (hours, focus, switch, slack, attend, carry). */
export function dayConfig(tiersOrTask = {}) {
  const tiers = tiersOrTask.tiers || tiersOrTask.claudeDir ? readTiers(tiersOrTask) : tiersOrTask;
  const d = { ...DEFAULT_DAY, ...(tiers.day || {}) };
  for (const k of ['hours', 'focus', 'switch', 'slack', 'attend']) if (!(Number(d[k]) >= 0)) d[k] = DEFAULT_DAY[k];
  d.focus = Math.min(1, Math.max(0.05, d.focus));
  d.carry = d.carry !== false;
  // the scheduled day's window (README § Unattended runs, Scheduled runs): HH:MM local, advances every n minutes
  for (const k of ['start', 'end']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(d[k]))) d[k] = DEFAULT_DAY[k];
  if (d.end <= d.start) { d.start = DEFAULT_DAY.start; d.end = DEFAULT_DAY.end; }
  d.advanceEvery = Number.isInteger(d.advanceEvery) && d.advanceEvery >= 5 && d.advanceEvery <= 720 ? d.advanceEvery : DEFAULT_DAY.advanceEvery;
  d.perDay = Math.round(d.hours * d.focus * 10) / 10; // focused hours a day yields
  return d;
}

/**
 * A ticket's estimate in a person's hours (README § Models and budget, Estimates): the base hours of its rating
 * × the multipliers the ticket's signals add (repos beyond the first, risk flags, unclear criteria, no pattern to
 * follow) × (1 + overhead) — then the same effort as calendar hours, workdays and tracker points, using the day model.
 * Signals: rating; repos (count); flags (names or a count); unclear (derived criteria / open questions); novelty.
 */
export function estimate(input = {}) {
  const tiers = readTiers(input);
  const cfg = { ...DEFAULT_ESTIMATE, ...(tiers.estimate || {}) };
  cfg.base = { ...DEFAULT_ESTIMATE.base, ...(tiers.estimate?.base || {}) };
  const day = dayConfig(tiers);
  const rating = RATINGS.includes(input.rating) ? input.rating : 'medium';
  const repos = Math.max(1, Math.floor(Number(input.repos)) || 1);
  const flags = Array.isArray(input.flags) ? input.flags.filter((f) => RISK_FLAGS.has(f)).length : Math.max(0, Math.floor(Number(input.flags)) || 0);
  const unclear = !!input.unclear;
  const novelty = !!input.novelty;
  const multiplier = 1 + cfg.perRepo * (repos - 1) + cfg.perFlag * flags + (unclear ? cfg.unclear : 0) + (novelty ? cfg.novelty : 0);
  const base = Number(cfg.base[rating]) > 0 ? Number(cfg.base[rating]) : DEFAULT_ESTIMATE.base[rating];
  const focusedHours = Math.max(0.5, half(base * multiplier * (1 + cfg.overhead)));
  const calendarHours = half(focusedHours / day.focus);
  const days = Math.round((focusedHours / day.perDay) * 10) / 10;
  const unitHours = Number(cfg.unitHours) > 0 ? Number(cfg.unitHours) : day.perDay;
  const points = Math.max(1, Math.round(focusedHours / unitHours));
  const parts = [`${base}h base for ${rating}`];
  if (repos > 1) parts.push(`+${Math.round(cfg.perRepo * (repos - 1) * 100)}% for ${repos} repos`);
  if (flags) parts.push(`+${Math.round(cfg.perFlag * flags * 100)}% for ${flags} risk flag${flags === 1 ? '' : 's'}`);
  if (unclear) parts.push(`+${Math.round(cfg.unclear * 100)}% unclear criteria`);
  if (novelty) parts.push(`+${Math.round(cfg.novelty * 100)}% nothing to copy`);
  parts.push(`+${Math.round(cfg.overhead * 100)}% debugging, review, verification`);
  const why = `${parts.join(', ')} = ${focusedHours} focused hours; a day yields ${day.perDay}h of focus out of ${day.hours} (meetings, breaks, admin take the rest) → ${calendarHours} calendar hours, ${days} day${days === 1 ? '' : 's'}, ${points} point${points === 1 ? '' : 's'} at ${unitHours}h a point`;
  return { rating, focusedHours, calendarHours, days, points, perDay: day.perDay, unitHours, basis: { base, multiplier: Math.round(multiplier * 100) / 100, overhead: cfg.overhead, repos, flags, unclear, novelty }, why };
}

const median = (list) => { const a = list.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

/**
 * The base hours learn from actuals (README § Models and budget, Estimates): every ticket whose estimate the pipeline made
 * and whose actual hours a person recorded (`ticket.json.actual`, through /tp-eod) gives one actual/estimate ratio; per rating
 * the median ratio, once `estimate.minSamples` exist, proposes `estimate.base[rating]` = current × median (half-hour
 * rounded). The pipeline's own minutes per ticket (state.mjs durations) are reported as shape only, never as a person's
 * hours. Nothing is written unless `apply` is set.
 */
export function calibrate(input = {}) {
  const workroot = input.workroot || (input.claudeDir ? join(input.claudeDir, 'work') : null);
  if (!workroot || !existsSync(workroot)) throw new Error('calibrate needs workroot (or claudeDir with a work/ directory)');
  const claudeDir = input.claudeDir || dirname(workroot);
  const tiers = readTiers({ claudeDir });
  const cfg = { ...DEFAULT_ESTIMATE, ...(tiers.estimate || {}) };
  cfg.base = { ...DEFAULT_ESTIMATE.base, ...(tiers.estimate?.base || {}) };
  const minSamples = Number(input.minSamples) > 0 ? Math.floor(Number(input.minSamples)) : (Number(cfg.minSamples) > 0 ? Number(cfg.minSamples) : DEFAULT_ESTIMATE.minSamples);
  const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
  const per = Object.fromEntries(RATINGS.map((r) => [r, { samples: 0, ratios: [], minutes: [], ids: [], tracker: 0 }]));
  let samples = 0;
  for (const name of readdirSync(workroot)) {
    const dir = join(workroot, name);
    if (name.startsWith('_') || !statSync(dir).isDirectory() || !existsSync(join(dir, 'ticket.json'))) continue;
    const ticket = read(join(dir, 'ticket.json')); const triage = read(join(dir, 'triage.json')); const plan = read(join(dir, 'plan.json'));
    const est = triage?.estimate || ticket?.estimate;
    const actual = ticket?.actual;
    if (!est || !(Number(est.focusedHours) > 0) || !actual || !(Number(actual.focusedHours) > 0)) continue;
    const rating = RATINGS.includes(est.basis?.rating) ? est.basis.rating : RATINGS.includes(plan?.complexity) ? plan.complexity : RATINGS.includes(triage?.complexity) ? triage.complexity : RATINGS.includes(ticket?.complexity) ? ticket.complexity : null;
    if (!rating) continue;
    if (est.source === 'tracker') { per[rating].tracker++; continue; } // a person's estimate says nothing about the pipeline's base
    const d = spawnSync(process.execPath, [join(HERE, 'state.mjs'), 'durations', dir], { encoding: 'utf8' });
    let minutes = 0; try { minutes = Object.values(JSON.parse(d.stdout)).reduce((a, b) => a + b, 0); } catch { minutes = 0; }
    per[rating].samples++; per[rating].ratios.push(Number(actual.focusedHours) / Number(est.focusedHours)); per[rating].minutes.push(minutes); per[rating].ids.push(ticket.id || name);
    samples++;
  }
  const ratings = {};
  const lines = [];
  for (const r of RATINGS) {
    const p = per[r];
    const current = Number(cfg.base[r]) > 0 ? Number(cfg.base[r]) : DEFAULT_ESTIMATE.base[r];
    const medianRatio = p.samples ? Math.round(median(p.ratios) * 100) / 100 : null;
    const proposed = p.samples >= minSamples ? Math.max(0.5, half(current * medianRatio)) : null;
    ratings[r] = { samples: p.samples, trackerEstimated: p.tracker, current, medianRatio, proposed, pipelineMedianMin: p.samples ? Math.round(median(p.minutes)) : null, ids: p.ids };
    if (p.samples) lines.push(`${r}: ${p.samples} sample${p.samples === 1 ? '' : 's'}, actual/estimate ${medianRatio}× (base ${current}h${proposed != null ? ` → ${proposed}h` : `, ${minSamples - p.samples} more before a proposal`})`);
  }
  const drift = lines.length ? lines.join('; ') : `no actuals recorded yet — /tp-eod records a person's hours per finished ticket; ${minSamples} per rating before a proposal`;
  let applied = null;
  if (input.apply) {
    const proposals = Object.fromEntries(RATINGS.filter((r) => ratings[r].proposed != null).map((r) => [r, ratings[r].proposed]));
    if (Object.keys(proposals).length) {
      const file = join(claudeDir, 'tiers.json');
      const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      const out = { ...prev, estimate: { ...(prev.estimate || {}), base: { ...(prev.estimate?.base || {}), ...proposals } } };
      writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
      applied = { estimate: { base: out.estimate.base } };
    } else applied = { estimate: { base: {} } };
  }
  return { minSamples, samples, ratings, drift, applied };
}

function writeTiers(claudeDir, pairs) {
  const t = {};
  for (const p of pairs) {
    const m = /^(low|medium|high)=(.+)$/.exec(p);
    if (!m) { console.error(`bad tier "${p}" — use low=<model> medium=<model> high=<model>`); process.exit(2); }
    t[m[1]] = m[2];
  }
  for (const k of RATINGS) if (!t[k]) { console.error(`missing ${k}=<model>`); process.exit(2); }
  const file = join(claudeDir, 'tiers.json');
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const out = { ...prev, ...t };
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return out;
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n', () => process.exit(code));
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , cmd, a, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'rate': { const s = readArg(a); emit(rate(s, s.thresholds || readTiers(s).thresholds)); break; }
      case 'budget': { const u = readArg(a); emit(budget(u, rest[0] ? readArg(rest[0]) : {})); break; }
      case 'pick': emit(pick(readArg(a))); break;
      case 'rounds': emit(rounds(readArg(a))); break;
      case 'compact': emit(compact(readArg(a))); break;
      case 'retry': emit(retry(readArg(a))); break;
      case 'estimate': emit(estimate(readArg(a))); break;
      case 'calibrate': emit(calibrate({ ...readArg(a), apply: rest.includes('--apply') })); break;
      case 'tiers': { if (!a) throw new Error('usage: tiers <.claude> low=… medium=… high=…'); emit(writeTiers(a, rest)); break; }
      default: console.error('usage: model.mjs rate|budget|pick|rounds|compact|retry|estimate|calibrate|tiers …'); process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(2); }
}
