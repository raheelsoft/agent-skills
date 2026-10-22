// config.mjs — tiers.json's day block: how many tickets run per usage band, the pool draw, and the person's workday.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayConfig as personDay } from '../model/index.mjs';

export const DEFAULT_DAY = { lanes: { ample: 'all', economy: 1, stop: 0, unknown: 'all' }, draw: 6 };

// a lane count is a non-negative integer or "all" (no cap: every ready ticket runs)
export const laneValue = (v, fallback) => (v === 'all' || v === Infinity ? 'all' : Number.isInteger(v) && v >= 0 ? v : fallback);

export const laneCap = (lanes) => (lanes === 'all' ? Infinity : Math.max(0, Number(lanes) || 0));

export function dayConfig(claudeDir, input = {}) {
  const file = claudeDir ? join(claudeDir, 'tiers.json') : null;
  const t = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const day = t.day || {};
  const person = personDay(t); // hours, focus, switch, slack, attend, carry, perDay
  if (Number(input.hours) > 0) person.hours = Number(input.hours);
  if (Number(input.focus) > 0) person.focus = Math.min(1, Number(input.focus));
  person.perDay = Math.round(person.hours * person.focus * 10) / 10;
  const { lanes: _l, draw: _d, ...personOnly } = person; // tiers.json.day holds both blocks; the person's fields only
  const lanes = Object.fromEntries(Object.keys(DEFAULT_DAY.lanes).map((b) => [b, laneValue((day.lanes || {})[b], DEFAULT_DAY.lanes[b])]));
  return { lanes, draw: Number.isInteger(day.draw) && day.draw > 0 ? day.draw : DEFAULT_DAY.draw, ...personOnly, tiers: t };
}

export function lanesFor(input, cfg, planObj) {
  const given = laneValue(input.lanes, null);
  if (given !== null) return { lanes: given, band: input.band || null, lanesGiven: true };
  if (planObj?.lanesGiven) return { lanes: planObj.lanes, band: input.band || planObj.band || null, lanesGiven: true }; // the person's choice stands for the day
  const band = input.band || planObj?.band || null; // this reading, else the last one the plan saw
  return { lanes: band ? cfg.lanes[band] ?? cfg.lanes.unknown : cfg.lanes.unknown, band, lanesGiven: false }; // through tiers.json, never a number a stale plan stored
}

export function lanesInfo(band, claudeDir) {
  const cfg = dayConfig(claudeDir);
  return { band: band || 'unknown', lanes: cfg.lanes[band] ?? cfg.lanes.unknown, draw: cfg.draw, count: cfg.draw, day: { hours: cfg.hours, focus: cfg.focus, perDay: cfg.perDay, switch: cfg.switch, slack: cfg.slack, attend: cfg.attend, carry: cfg.carry } };
}
