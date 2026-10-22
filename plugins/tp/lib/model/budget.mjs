// budget.mjs — a usage reading to a band (ample | economy | stop), and a rating plus the band to what to spawn an agent with.
import { join } from 'node:path';
import { RATINGS, at, higherOf, nowIso, readTiers, writeAtomic } from './common.mjs';
import { withinCeiling } from './ceiling.mjs';

export const EFFORT = ['low', 'medium', 'high', 'max'];

export const DEFAULT_BUDGET = { economy: 70, stop: 90 }; // percent used of any window

export function windowHours(label = '') {
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
    const onTiers = RATINGS.filter((r) => names[r] && label.toLowerCase().includes(names[r])); // every tier that runs on this window's model
    const tier = onTiers[0] || null;
    return { label, percentUsed: w.percentUsed, hoursLeft: hoursLeft == null ? null : Math.round(hoursLeft * 10) / 10, projected, band, tier, tiers: onTiers, resetsAt: w.resetsAt || null };
  });
  const rank = { ample: 0, economy: 1, stop: 2 };
  const general = windows.filter((w) => !w.tier).sort((a, b) => rank[b.band] - rank[a.band] || b.percentUsed - a.percentUsed);
  const binding = general[0] || null;
  const perTier = {};
  for (const w of windows) for (const r of w.tiers) perTier[r] = rank[w.band] >= rank[perTier[r] || 'ample'] ? w.band : perTier[r]; // the worst window of the model
  const band = windows.length ? (binding ? binding.band : 'ample') : 'unknown';
  const why = !windows.length ? 'no usage reading: the rating alone decides'
    : !binding ? `only per-model windows (${windows.map((w) => `${w.label} at ${w.percentUsed}%`).join(', ')}): the rating alone decides, the model's own window stops what runs on it`
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
  // the reading, recorded for the office's gauge and /tp:eod — only a reading with windows, never over a good one with "unknown"
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
  const named = typeof tiers[rating] === 'string' ? tiers[rating] : null;
  const capped = named ? withinCeiling(named, tiers) : { model: null, clamped: false };
  if (capped.clamped) why.push(`${named} is above the ceiling ${capped.model}: the agent runs on the ceiling`);
  return {
    action, rating, model: capped.model, effort: EFFORT[effort],
    budget: { band: b.band, why: b.why, tiers: b.tiers },
    why: why.join('; ') || 'the rating alone decides',
    ...(RATINGS.some((r) => typeof tiers[r] === 'string') ? {} : { note: 'no tiers.json — choose the largest model the pipeline may use: node model.mjs tiers <.claude> ceiling=<model> ladder=<smallest>,…,<largest>' }),
  };
}

/**
 * The review loop's next step, from the change's complexity and what the passes so far left open.
 * Every pass after the first is incremental (a resolution check plus, in delta mode, the commits since the
 * reviewed sha); the budget's last pass is resolution only, so it can raise nothing new; and the loop ends
 * early when it stops converging — nothing resolved, or new items in two passes running.
 */
