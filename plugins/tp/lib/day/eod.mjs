// eod.mjs — the day's close: what finished, what carries over, estimates against minutes and actual hours, tokens and cost.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { estimate, calibrate } from '../model/index.mjs';
import { STATE, fail, nowIso, today, uniq } from './util.mjs';
import { rowsOf } from './rows.mjs';
import { planFile } from './files.mjs';
import { status } from './advance.mjs';

// the day's end (skills/eod/SKILL.md): everything a person wants to know at the close, from the rows and the plan
export function eod(workroot, date, input = {}) {
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  const day = date || today(nowMs);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`date must be YYYY-MM-DD, got "${day}"`);
  const claudeDir = input.claudeDir || dirname(workroot);
  const rowsById = rowsOf(workroot);
  const rows = Object.values(rowsById).filter((r) => r.status !== 'error');
  const onDay = (ts) => typeof ts === 'string' && ts.startsWith(day);
  const FINAL = ['accept', 'release', 'merge', 'create-pr', 'implement', 'plan', 'triage', 'start-ticket'];
  const rank = (name) => FINAL.indexOf(String(name).split(':')[0]);
  const done = []; const touched = new Set();
  for (const r of rows) {
    const todays = (r.stages || []).filter((s) => onDay(s.at) && (s.status === 'done' || s.status === 'stopped'));
    if (todays.length || onDay(r.lastEvent?.ts)) touched.add(r.id);
    const finished = (r.stages || []).filter((s) => s.status === 'done' && onDay(s.at) && ['accept', 'release', 'merge'].includes(String(s.name).split(':')[0]));
    if (r.status === 'done' && finished.length) { const top = finished.sort((a, b) => rank(a.name) - rank(b.name))[0]; done.push({ id: r.id, title: r.title, stage: top.name, at: top.at }); }
    else if (finished.length) done.push({ id: r.id, title: r.title, stage: finished.sort((a, b) => rank(a.name) - rank(b.name))[0].name, at: finished[0].at, partial: true });
  }
  const inProgress = rows.filter((r) => r.status === 'in-progress').map((r) => ({ id: r.id, title: r.title, stage: r.next, lock: r.lock ? r.lock.owner : null }));
  const stopped = rows.filter((r) => r.status === 'stopped').map((r) => ({ id: r.id, title: r.title, stage: r.stopped.stage, kind: r.stopped.kind, since: r.stopped.at, waitingMin: r.stopped.at ? Math.max(0, Math.round((nowMs - Date.parse(r.stopped.at)) / 60000)) : null, question: r.stopped.question, resume: r.stopped.resume, resumable: !!r.stopped.resumable, answer: r.answer || null }));
  const parked = stopped.filter((s) => s.kind === 'blocked');
  const errors = [...stopped.filter((s) => s.kind === 'error'), ...rows.filter((r) => (r.problems || []).length && r.status !== 'closed').map((r) => ({ id: r.id, kind: 'problem', question: r.problems.join('; '), resume: `/tp:run-ticket ${r.id} answers=retry` }))];
  const perTicket = rows.filter((r) => touched.has(r.id) || done.some((d) => d.id === r.id)).map((r) => ({
    id: r.id, title: r.title, rating: r.complexity, status: r.status,
    estimate: r.estimate ? { focusedHours: r.estimate.focusedHours, source: r.estimate.source } : null,
    actual: r.actual ? r.actual.focusedHours : null,
    pipelineMin: Object.values(r.durations || {}).reduce((a, b) => a + b, 0),
    tokens: r.tokens || 0, cost: r.cost ?? null,
  }));
  const missingActuals = done.filter((d) => !d.partial && !rowsById[d.id]?.actual).map((d) => ({ id: d.id, title: d.title, estimate: rowsById[d.id]?.estimate?.focusedHours ?? null }));
  const t = spawnSync(process.execPath, [STATE, 'totals', workroot, '--date', day], { encoding: 'utf8' });
  let totals = { tokens: 0, cost: null, unpriced: 0, partial: false }; try { totals = JSON.parse(t.stdout); } catch { /* keep the empty totals */ }
  let budget = null; try { budget = JSON.parse(readFileSync(join(workroot, '_budget.json'), 'utf8')); } catch { budget = null; }
  let plan = null; try { plan = status(workroot, existsSync(planFile(workroot, day)) ? day : null, { rows: rowsById, now: input.now }); } catch { plan = null; }
  const carryOver = plan ? uniq([...plan.tickets.filter((x) => ['queued', 'starting', 'running', 'stopped'].includes(x.status)).map((x) => x.id), ...(plan.later || []).map((l) => l.id)]) : [];
  let cal = null; try { const c = calibrate({ workroot, claudeDir }); cal = { drift: c.drift, samples: c.samples, ratings: Object.fromEntries(Object.entries(c.ratings).map(([k, v]) => [k, { samples: v.samples, current: v.current, medianRatio: v.medianRatio, proposed: v.proposed }])) }; } catch (e) { cal = { drift: `calibration unavailable: ${e.message}` }; }
  const out = {
    date: day, at: nowIso(nowMs), done, inProgress, stopped, parked, errors, perTicket, missingActuals, totals,
    budget: budget ? { at: budget.at, band: budget.band, binding: budget.binding } : null,
    plan: plan ? { date: plan.date, stale: plan.stale, lanes: plan.lanes, band: plan.band, finished: plan.finished, why: plan.why } : null,
    carryOver, calibrate: cal,
  };
  mkdirSync(join(workroot, '_day'), { recursive: true });
  const file = join(workroot, '_day', `${day}.eod.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  return out;
}
