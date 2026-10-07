// calibrate.mjs — the base hours learned from the actual hours a person recorded (README § Models and budget, Estimates).
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATINGS, readTiers } from './common.mjs';
import { DEFAULT_ESTIMATE, half } from './estimate.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..'); // lib/, where state.mjs is
const median = (list) => { const a = list.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

/**
 * The base hours learn from actuals (README § Models and budget, Estimates): every ticket whose estimate the pipeline made
 * and whose actual hours a person recorded (`ticket.json.actual`, through /tp:eod) gives one actual/estimate ratio; per rating
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
    const d = spawnSync(process.execPath, [join(LIB, 'state.mjs'), 'durations', dir], { encoding: 'utf8' });
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
  const drift = lines.length ? lines.join('; ') : `no actuals recorded yet — /tp:eod records a person's hours per finished ticket; ${minSamples} per rating before a proposal`;
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

/**
 * `ceiling=<model> [ladder=<smallest>,…,<largest>]` derives the three tiers (tiersFor) and records the ceiling and the ladder with them;
 * `low=` `medium=` `high=` after it name a tier by hand. Without `ceiling=` all three tiers are named, as before — and when the file
 * already holds a ceiling, each must sit on its ladder at or below it. Everything else in the file is kept.
 */
