// usage.mjs — tokens an agent reported (`tokens=<n> tier=<rating>` in a progress line), per stage and per tier, priced when tiers.json names prices
// (reference/models-and-budget.md § Models and budget, Cost).
import { join, dirname, resolve } from 'node:path';
import { RATING_VALUES } from './constants.mjs';
import { isDir, readJson } from './util.mjs';
import { parseProgress } from './progress.mjs';

// <.claude>/tiers.json `prices` — $ per 1M tokens per tier — for the work root's .claude directory
export function pricesOf(claudeDir) {
  const t = claudeDir ? readJson(join(claudeDir, 'tiers.json'), []) : null;
  const p = t?.prices && typeof t.prices === 'object' ? t.prices : null;
  if (!p) return null;
  const out = {};
  for (const r of RATING_VALUES) if (Number(p[r]) >= 0) out[r] = Number(p[r]);
  return Object.keys(out).length ? out : null;
}

// tokens an agent reported, recorded as "tokens=<n> tier=<rating>" anywhere in a line's summary or links; priced when
// tiers.json names prices (reference/models-and-budget.md § Models and budget). `claudeDir` defaults to the parent of the work root; `date`
// keeps the lines of one day. `partial` when a run said its totals are incomplete ("tokens partial").
export function usage(workdir, opts = {}) {
  const entries = isDir(workdir) ? parseProgress(workdir, []) : [];
  const prices = pricesOf(opts.claudeDir || dirname(dirname(resolve(workdir))));
  const perStage = {}; const perTier = {};
  let total = 0; let unpriced = 0; let cost = 0; let partial = false;
  for (const e of entries) {
    if (opts.date && !e.ts.startsWith(opts.date)) continue;
    const text = `${e.summary} ${e.links}`;
    if (/\btokens partial\b/.test(text)) partial = true;
    const m = /\btokens=(\d+)\b(?:\s+tier=(low|medium|high)\b)?/.exec(text);
    if (!m) continue;
    const n = Number(m[1]); const tier = m[2] || null;
    perStage[e.stage] = (perStage[e.stage] || 0) + n;
    perTier[tier || 'untiered'] = (perTier[tier || 'untiered'] || 0) + n;
    total += n;
    if (prices && tier && tier in prices) cost += n * prices[tier] / 1e6; else unpriced += n;
  }
  return { perStage, perTier, total, cost: prices ? Math.round(cost * 100) / 100 : null, unpriced, partial };
}
