// estimate.mjs — a person's workday and a ticket's estimate in the person's hours (reference/models-and-budget.md § Models and budget, Estimates).
import { RATINGS, readTiers } from './common.mjs';

// A person's workday, not an agent's: `hours` at the desk, `focus` the share that is engineering time once meetings,
// breaks, mail and admin are gone, `switch` the hours lost to every extra ticket worked in the same day, `slack` how far
// a day may run over rather than carry a sliver to tomorrow, `attend` the share of a running ticket's estimate the person
// still spends on it (answers, reviews, testing) while the pipeline works it, `carry` whether a ticket may start on a
// day that cannot finish it. day.mjs reads the same block for lanes and the pool draw.
export const DEFAULT_DAY = { hours: 8, focus: 0.65, switch: 0.5, slack: 0.5, attend: 0.25, carry: true, start: '09:00', end: '18:00', advanceEvery: 30 };

// Focused hours a person needs, by rating, before the multipliers — and the overhead every estimate forgets:
// debugging, review rounds, verification, rework. `unitHours` maps hours onto the tracker's points (null = one focused day).
export const DEFAULT_ESTIMATE = { base: { low: 2, medium: 6, high: 16 }, perRepo: 0.25, perFlag: 0.15, unclear: 0.3, novelty: 0.2, overhead: 0.35, unitHours: null, minSamples: 3 };

export const RISK_FLAGS = new Set(['data-model', 'access-control', 'public-contract', 'irreversible']); // cross-repo is the repos count

export const half = (n) => Math.round(n * 2) / 2;

export function dayConfig(tiersOrTask = {}) {
  const tiers = tiersOrTask.tiers || tiersOrTask.claudeDir ? readTiers(tiersOrTask) : tiersOrTask;
  const d = { ...DEFAULT_DAY, ...(tiers.day || {}) };
  for (const k of ['hours', 'focus', 'switch', 'slack', 'attend']) if (!(Number(d[k]) >= 0)) d[k] = DEFAULT_DAY[k];
  d.focus = Math.min(1, Math.max(0.05, d.focus));
  d.carry = d.carry !== false;
  // the scheduled day's window (reference/observability.md § Unattended runs, Scheduled runs): HH:MM local, advances every n minutes
  for (const k of ['start', 'end']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(d[k]))) d[k] = DEFAULT_DAY[k];
  if (d.end <= d.start) { d.start = DEFAULT_DAY.start; d.end = DEFAULT_DAY.end; }
  d.advanceEvery = Number.isInteger(d.advanceEvery) && d.advanceEvery >= 5 && d.advanceEvery <= 720 ? d.advanceEvery : DEFAULT_DAY.advanceEvery;
  d.perDay = Math.round(d.hours * d.focus * 10) / 10; // focused hours a day yields
  return d;
}

/**
 * A ticket's estimate in a person's hours (reference/models-and-budget.md § Models and budget, Estimates): the base hours of its rating
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
