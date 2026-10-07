// loops.mjs — the bounds of the pipeline's loops: how many review passes a change gets, when an agent hands its work to a fresh one, how often a failure is retried.
import { RATINGS, readTiers } from './common.mjs';

export const DEFAULT_REVIEW = { low: 2, medium: 3, high: 4, max: 5 }; // reviewer passes a PR may get, by the change's rating

export const DEFAULT_RETRIES = { low: 1, medium: 2, high: 3 }; // re-tries a failure gets before it is handed up, by the task's rating

export const RETRY_KINDS = ['transient', 'environment', 'logic', 'usage', 'decision'];

export const DEFAULT_COMPACT = { // when an agent hands its remaining work to a fresh one (reference/context-management.md § Context management, rule 7)
  window: 200000,                                   // tokens an agent's context holds when the runtime does not say
  reserve: 0.08,                                    // share of the window kept free for the checkpoint and the report
  perStep: { low: 0.04, medium: 0.08, high: 0.12 }, // share of the window one step of a task of that rating takes in
  safety: { low: 1.2, medium: 1.5, high: 2 },       // headroom multiplier: deeper reasoning per step needs more room
  handoffs: { low: 2, medium: 4, high: 6 },         // hand-offs one invocation may make before it counts as not progressing
};

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
 * Auto-resolve before escalating (reference/failures-and-stops.md § Failures and escalation): what a failure of `kind` gets after `attempts`
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
    if (attempts === 0) { action = 'fallback'; why = 'try the documented alternative once (reference/procedures.md § Remote access failures, § Toolchain) — never a change to credentials, remotes or shell config'; }
    else { action = 'escalate'; why = 'the fallback failed too — checkpoint and hand up with the resume steps'; }
  } else if (attempts < max) {
    action = 'retry';
    waitSeconds = kind === 'transient' ? Math.min(120, 15 * 2 ** attempts) : 0;
    why = `${kind} failure: attempt ${attempts + 1} of ${max} for a ${rating} task${waitSeconds ? ` after ${waitSeconds}s` : ''}`;
  } else { action = 'escalate'; why = `${max} ${kind} retr${max === 1 ? 'y' : 'ies'} spent (the bound for a ${rating} task) — checkpoint and hand up with the resume steps`; }
  return { action, kind, rating, attempts, max, waitSeconds, why };
}

/** The person's day: tiers.json.day over the defaults (hours, focus, switch, slack, attend, carry). */
