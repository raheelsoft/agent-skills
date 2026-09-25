#!/usr/bin/env node
// day.mjs — the day planner's arithmetic (skills/tp-plan-day/SKILL.md): which of a day's candidate tickets
// run, in what order, and how many at once — deterministic, so the same day plans the same way twice.
// It reads the state script's rows for the work root and its own plan file; it writes only
// <workroot>/_day/<date>.json (the contract) and <workroot>/_day/<date>.md (for people).
//
//   node day.mjs plan <workroot> '<json>'            -> selects, orders, writes the plan; returns it with `start` — or, with
//                                                       `review: true`, as a PROPOSAL: nothing starts, `proposed` holds what would,
//                                                       `question` is the approval stop, also written to _scratch/plan-day-<date>.stop.json
//                                                       so the inbox and the office list it; `drop`/`only`/`first`/`lanes` are the
//                                                       person's adjustments on a re-plan
//   node day.mjs approve <workroot> <date> ['<json>']  -> the person's go-ahead: marks the plan approved, removes the stop, starts
//                                                       what is ready (a real advance); { by?, now? }
//   node day.mjs advance <workroot> <date> ['<json>'] -> refreshes every ticket's status from the work directories;
//                                                       returns what starts now, what waits on what, what resumes by itself
//                                                       (`resumable`: a usage pause past its reset, a parked ticket whose blockers
//                                                       are resolved) and, given `recheck`, re-queues skipped-blocked candidates
//                                                       whose blockers are now resolved (`unblocked`)
//   node day.mjs eod <workroot> <date> ['<json>']     -> the day's end: what finished, what stands where, estimate vs actual vs the
//                                                       pipeline's minutes, tokens and cost, tomorrow's carry-over, the calibration
//                                                       drift — written to <workroot>/_day/<date>.eod.json (/tp-eod writes the .md)
//   node day.mjs show <workroot> <date>              -> the plan as stored
//   node day.mjs status <workroot> [<date>]          -> the plan (the date's, else the latest) with live statuses — a dry
//                                                       advance that writes nothing; `stale` when the plan is older than today
//   node day.mjs lanes <band> [<.claude>]            -> { band, lanes, draw } from tiers.json.day
//
// plan input: { date?: "YYYY-MM-DD" (today), from: "sprint"|"pool", iteration?, features?: [], claudeDir?,
//               lanes?: n | band?: ample|economy|stop, count?: n, stackable?: bool, dry?: bool, seed?, now?,
//               hours?: n, focus?: 0–1 (today's workday, over tiers.json.day),
//               tickets: [{ id, title?, rating?, priority?, after?: [ids], blocked?: "<why>", soft?: "<why>", inFlight?: bool,
//                           hours?: n (the person's focused hours — the tracker's estimate converted, or given),
//                           repos?, flags?, unclear?, novelty? (estimate signals when `hours` is absent — model.mjs estimate) }] }
//   review    true → a proposal for the person (nothing starts until `approve`); false/absent → approved as planned
//   drop      ids the person took out (a dependent of a dropped ticket is skipped with it); only: keep these and their
//             prerequisites, nothing else; first: these ids run first, in this order (before priority and carry-over)
//   after     candidates this one must follow (the tracker's blocked-by relations, stated dependencies)
//   blocked   an unresolved blocker outside the candidates — skipped, never planned
//   soft      only soft-blocked (start-ticket's blocked-check.md) — skipped; the person may start it by hand
//   inFlight  already in the pipeline (a work directory exists) — listed, never selected, a valid `after` target
//   count     at most this many tickets (a sprint day takes every ticket that qualifies; a pool day draws
//             `draw`); a dependent is only taken with its prerequisites
//   lanes     runs at once — given (a number, or "all"), or from the band through tiers.json.day: every ticket
//             that is ready — unblocked, no unfinished prerequisite — starts in parallel unless the usage band caps
//             it (`ample`/`unknown` "all", `economy` 1, `stop` 0); `stackable` (the project stacks dependent work on
//             the open branch) lets a dependent start once its prerequisite's PR is open instead of merged
//   hours     the day is a PERSON's day (model.mjs DEFAULT_DAY): `hours` × `focus` focused hours a day, `switch`
//             hours lost per extra ticket in a day, `slack` a day may run over, `attend` the share of a running
//             ticket's estimate the person still spends on it. Tickets are placed first-fit into consecutive
//             workdays (Mon–Fri) in plan order; one that does not fit what is left of a day starts anyway and
//             carries over (`carry`); a dependent never starts before the day its prerequisite ends. The days are
//             the PERSON's attention forecast, never a gate on the pipeline: `start` is every ready ticket up to
//             the free lanes, whatever day it was placed on; a dependent starts the moment its prerequisites are
//             satisfied.
// advance input: { lanes? | band?, stackable?, dry?, now?, claudeDir?,
//                  recheck?: { "<id>": [{ id, state, resolved, soft, checkedAt? }] } }  — `dry` computes `start` without marking
//                it started; `recheck` is the blocker lookup's result (tp-start-ticket/instructions/blocked-check.md § Re-check) for
//                skipped-blocked candidates: recorded on the plan, and a candidate whose blockers are all resolved (or only soft)
//                is re-queued and scheduled behind what is already planned
//
// tiers.json.day (defaults): { lanes: { ample: "all", economy: 1, stop: 0, unknown: "all" }, draw: 6,
//                               hours: 8, focus: 0.65, switch: 0.5, slack: 0.5, attend: 0.25, carry: true }
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimate, dayConfig as personDay, calibrate } from './model.mjs';

const STATE = join(dirname(fileURLToPath(import.meta.url)), 'state.mjs');
const ORDER = ['start-ticket', 'triage', 'plan', 'plan-check', 'implement', 'create-pr', 'merge', 'release', 'accept'];
const RATINGS = ['low', 'medium', 'high'];
const DEFAULT_DAY = { lanes: { ample: 'all', economy: 1, stop: 0, unknown: 'all' }, draw: 6 };
// a lane count is a non-negative integer or "all" (no cap: every ready ticket runs)
const laneValue = (v, fallback) => (v === 'all' || v === Infinity ? 'all' : Number.isInteger(v) && v >= 0 ? v : fallback);
const laneCap = (lanes) => (lanes === 'all' ? Infinity : Math.max(0, Number(lanes) || 0));
const STARTING_GRACE_MS = 30 * 60 * 1000; // a launched ticket with no work directory after this long is reported failed

const nowIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const today = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const uniq = (list) => [...new Set(list)];
const fail = (msg) => { throw new Error(msg); };

function readArg(arg) {
  if (arg == null || arg === '') return {};
  if (existsSync(arg)) return JSON.parse(readFileSync(arg, 'utf8'));
  return JSON.parse(arg);
}

function dayConfig(claudeDir, input = {}) {
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

// the person's focused hours a ticket costs: given, else the model's estimate from the ticket's signals
function hoursOf(t, cfg) {
  if (Number(t.hours) > 0) return { hours: Math.round(Number(t.hours) * 2) / 2, source: t.hoursSource || 'given', why: null };
  const e = estimate({ rating: t.rating || 'medium', repos: t.repos, flags: t.flags, unclear: t.unclear, novelty: t.novelty, tiers: cfg.tiers });
  return { hours: e.focusedHours, source: 'model', why: e.why };
}

// the next workday (Mon–Fri) `n` workdays after `date`
function workday(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--; }
  return d.toISOString().slice(0, 10);
}

// first-fit into consecutive workdays: `tickets` in plan order (dependency order first), each with `hours` and `after`
function schedule(tickets, cfg, date, initialLoad = 0) {
  const cap = cfg.perDay;
  const days = [{ day: 1, date, tickets: [], load: Math.round(initialLoad * 10) / 10, capacity: cap, carried: initialLoad ? 'in-flight attention' : null }];
  const endDay = {};
  const dayAt = (n) => { while (days.length < n) days.push({ day: days.length + 1, date: workday(date, days.length), tickets: [], load: 0, capacity: cap, carried: null }); return days[n - 1]; };
  for (const t of tickets) {
    let remaining = t.hours; let n = Math.max(1, ...t.after.map((a) => endDay[a] ?? 1)); t.day = null; t.slices = [];
    for (let guard = 0; remaining > 0 && guard < 120; guard++, n++) {
      const d = dayAt(n);
      const switchCost = d.load > 0 ? cfg.switch : 0;
      const room = cap + cfg.slack - d.load - switchCost;      // what the day can still take, slack included
      const real = cap - d.load - switchCost;                  // what it can take without running over
      if (remaining <= room) { d.load = Math.round((d.load + switchCost + remaining) * 10) / 10; d.tickets.push({ id: t.id, hours: remaining }); t.slices.push({ day: n, hours: remaining }); if (t.day == null) t.day = n; remaining = 0; endDay[t.id] = n; }
      else if (cfg.carry && real >= 1) { const part = Math.round(real * 10) / 10; d.load = Math.round((d.load + switchCost + part) * 10) / 10; d.tickets.push({ id: t.id, hours: part }); t.slices.push({ day: n, hours: part }); if (t.day == null) t.day = n; remaining = Math.round((remaining - part) * 10) / 10; }
    }
    if (remaining > 0) { const d = dayAt(n); d.tickets.push({ id: t.id, hours: remaining }); t.slices.push({ day: n, hours: remaining }); if (t.day == null) t.day = n; endDay[t.id] = n; } // never happens within the guard
    t.endDay = endDay[t.id];
  }
  return days;
}

function lanesFor(input, cfg, planObj) {
  const given = laneValue(input.lanes, null);
  if (given !== null) return { lanes: given, band: input.band || null, lanesGiven: true };
  if (planObj?.lanesGiven) return { lanes: planObj.lanes, band: input.band || planObj.band || null, lanesGiven: true }; // the person's choice stands for the day
  const band = input.band || planObj?.band || null; // this reading, else the last one the plan saw
  return { lanes: band ? cfg.lanes[band] ?? cfg.lanes.unknown : cfg.lanes.unknown, band, lanesGiven: false }; // through tiers.json, never a number a stale plan stored
}

// the state script's rows for the work root, by ticket id
function rowsOf(workroot) {
  const r = spawnSync(process.execPath, [STATE, 'all', workroot], { encoding: 'utf8' });
  let rows = [];
  try { rows = JSON.parse(r.stdout); } catch { rows = []; }
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

const stageIndex = (next) => { if (!next) return ORDER.length; const i = ORDER.indexOf(String(next).split(':')[0]); return i < 0 ? ORDER.length : i; };

// a prerequisite is satisfied once its code is on the base branch (merge done on every repo) — or, when the
// project stacks dependent work, once its PR is open; a finished ticket always is
function satisfied(row, stackable) {
  if (!row) return false;
  if (row.status === 'done') return true;
  if (row.status === 'error' || row.status === 'closed') return false;
  return stageIndex(row.next) > ORDER.indexOf(stackable ? 'create-pr' : 'merge');
}

function statusOf(t, row, nowMs) {
  if (row) {
    if (row.status === 'stopped') return { status: 'stopped', stage: row.stopped?.stage ?? null, question: row.stopped?.question ?? null };
    if (row.status === 'done') return { status: 'done', stage: null, question: null };
    if (row.status === 'closed') return { status: 'closed', stage: null, question: null, note: row.closed?.why || 'closed early' };
    if (row.status === 'error') return { status: 'failed', stage: null, question: null, note: (row.problems || []).join('; ') || 'state error' };
    return { status: 'running', stage: row.next ?? null, question: null };
  }
  if (t.startedAt) {
    if (nowMs - Date.parse(t.startedAt) > STARTING_GRACE_MS) return { status: 'failed', stage: null, question: null, note: 'no work directory 30 min after the start — re-run /tp-run-ticket' };
    return { status: 'starting', stage: 'start-ticket', question: null };
  }
  return { status: 'queued', stage: null, question: null };
}

// mulberry32 seeded from the seed's sha1 — the same seed draws the same tickets
function seeded(seed) {
  let a = parseInt(createHash('sha1').update(String(seed)).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const idKey = (id) => { const m = /^(.*?)(\d+)$/.exec(id); return m ? [m[1], Number(m[2])] : [id, 0]; };
const byId = (a, b) => { const [pa, na] = idKey(a), [pb, nb] = idKey(b); return pa < pb ? -1 : pa > pb ? 1 : na - nb; };

// Kahn's algorithm over the `after` edges restricted to `ids`: levels (what can run together) or the cycle
function levels(cands, ids) {
  const set = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, cands.get(id).after.filter((a) => set.has(a)).length]));
  const out = []; let layer = ids.filter((id) => indeg.get(id) === 0).sort(byId);
  const seen = new Set();
  while (layer.length) {
    out.push(layer); layer.forEach((id) => seen.add(id));
    const next = [];
    for (const id of ids) {
      if (seen.has(id) || next.includes(id)) continue;
      if (cands.get(id).after.filter((a) => set.has(a)).every((a) => seen.has(a))) next.push(id);
    }
    layer = next.sort(byId);
  }
  const cycle = ids.filter((id) => !seen.has(id)).sort(byId);
  return { levels: out, cycle };
}

function planFile(workroot, date) { return join(workroot, '_day', `${date}.json`); }

// the ids the latest earlier plan left queued, starting, running or on a later day — today's first candidates
function previousPlan(workroot, date) {
  const dir = join(workroot, '_day');
  if (!existsSync(dir)) return [];
  const prev = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < date).sort().pop();
  if (!prev) return [];
  try {
    const p = JSON.parse(readFileSync(join(dir, prev), 'utf8'));
    return (p.tickets || []).filter((t) => ['queued', 'starting', 'running'].includes(t.status)).map((t) => t.id);
  } catch { return []; }
}

function write(workroot, planObj) {
  const dir = join(workroot, '_day');
  mkdirSync(dir, { recursive: true });
  const file = planFile(workroot, planObj.date);
  writeFileSync(`${file}.tmp`, JSON.stringify(planObj, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  writeFileSync(join(dir, `${planObj.date}.md`), markdown(planObj));
}

function markdown(p) {
  const line = (t, i) => `| ${i + 1} | ${t.id} ${t.title || ''} | ${t.rating || '—'} | ${t.hours ?? '—'}${t.hoursSource === 'model' ? '*' : ''} | ${t.day ?? '—'}${t.endDay && t.endDay !== t.day ? `–${t.endDay}` : ''} | ${t.after.length ? t.after.join(', ') : '—'} | ${t.status}${t.stage ? ` (${t.stage})` : ''}${t.question ? ` — ${t.question}` : ''}${t.note ? ` — ${t.note}` : ''} |`;
  const list = (title, items) => (items.length ? `\n${title}\n${items.map((s) => `- ${s}`).join('\n')}\n` : '');
  const dayLine = (d) => `| ${d.day} | ${d.date} | ${d.tickets.map((t) => `${t.id} ${t.hours}h`).join(', ') || '—'} | ${d.load} / ${d.capacity}h${d.carried ? ` (${d.carried} ${Math.round((d.load - d.tickets.reduce((s, t) => s + t.hours, 0)) * 10) / 10}h)` : ''} |`;
  return `# Day plan — ${p.date} (${p.from}${p.iteration ? `: ${p.iteration}` : ''})\n\n` +
    `features: ${p.features.length ? p.features.join(' · ') : 'all'} · lanes: ${p.lanes}${p.band ? ` (${p.band})` : ''} · count: ${p.count ?? 'all'} · seed: ${p.seed}\n` +
    `day: ${p.day.hours}h at ${Math.round(p.day.focus * 100)}% focus = ${p.day.perDay}h · switch ${p.day.switch}h · attend ${Math.round(p.day.attend * 100)}% of a running ticket\n` +
    `${p.approved ? `approved: ${p.approved}${p.approvedBy ? ` (${p.approvedBy})` : ''}` : 'awaiting approval — a proposal; nothing starts until `/tp-plan-day date=<date> answers=go-ahead`'}\n\n` +
    `| # | Ticket | Rating | Hours | Day | After | Status |\n|---|---|---|---|---|---|---|\n${p.tickets.map(line).join('\n')}\n` +
    `\n| Day | Date | Tickets | Load |\n|---|---|---|---|\n${(p.days || []).map(dayLine).join('\n')}\n` +
    `\nBatches: ${p.batches.map((b) => b.join(' + ')).join(' → ') || 'none'}\n` +
    list('In flight (already in the pipeline):', p.inFlight.map((i) => `${i.id} — ${i.status}${i.stage ? ` (${i.stage})` : ''}${i.question ? ` — ${i.question}` : ''}${i.attention ? ` — ${i.attention}h of attention today` : ''}`)) +
    (p.carried && p.carried.length ? `\nCarried over from the previous plan: ${p.carried.join(', ')}\n` : '') +
    (p.tickets.some((t) => t.hoursSource === 'model') ? '\n\\* hours estimated by the model (no tracker estimate)\n' : '')
    list('Skipped:', p.skipped.map((s) => `${s.id} — ${s.why}`)) +
    (p.undrawn.length ? `\nNot drawn today: ${p.undrawn.join(', ')}\n` : '');
}

// refresh statuses, fill the free lanes, mark what starts — shared by plan and advance
function step(planObj, rows, opts) {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const stackable = !!planObj.stackable;
  for (const t of planObj.tickets) {
    if (t.status === 'skipped') continue;
    Object.assign(t, statusOf(t, rows[t.id], nowMs));
    if ((t.status === 'done' || t.status === 'failed' || t.status === 'closed') && !t.endedAt) t.endedAt = nowIso(nowMs);
  }
  for (const i of planObj.inFlight) {
    const row = rows[i.id];
    if (row) Object.assign(i, { status: row.status, stage: row.stopped?.stage ?? row.next ?? null, question: row.stopped?.question ?? null });
  }
  const prereqState = (id) => {
    const t = planObj.tickets.find((x) => x.id === id);
    const row = rows[id];
    const ok = t ? t.status === 'done' || satisfied(row, stackable) : satisfied(row, stackable);
    return { id, ok, status: t ? t.status : row ? row.status : planObj.inFlight.some((i) => i.id === id) ? 'in-flight' : 'missing' };
  };
  const running = planObj.tickets.filter((t) => t.status === 'running' || t.status === 'starting').map((t) => t.id);
  const lanes = laneCap(planObj.lanes);
  const free = Math.max(0, lanes - running.length);
  const queued = planObj.tickets.filter((t) => t.status === 'queued');
  const ready = []; const waiting = [];
  for (const t of queued) {
    // ready = every prerequisite satisfied; the day it was placed on is the person's forecast, not a gate
    const pre = t.after.map(prereqState);
    if (!pre.every((p) => p.ok)) { waiting.push({ id: t.id, on: pre.filter((p) => !p.ok).map((p) => ({ id: p.id, status: p.status })) }); continue; }
    ready.push(t);
  }
  const start = ready.slice(0, free).map((t) => t.id);
  if (!opts.dry) for (const t of ready.slice(0, free)) { t.status = 'starting'; t.stage = 'start-ticket'; t.startedAt = nowIso(nowMs); }
  for (const w of waiting) w.on = w.on.map((o) => ({ ...o, status: prereqState(o.id).status })); // as they stand after the starts
  const stopped = planObj.tickets.filter((t) => t.status === 'stopped').map((t) => ({ id: t.id, stage: t.stage, question: t.question }));
  // what goes on by itself: a usage pause past its reset, a parked ticket whose blockers the state reports resolved
  const resumable = uniq([...planObj.tickets, ...planObj.inFlight].filter((t) => rows[t.id]?.stopped?.resumable).map((t) => t.id));
  const done = planObj.tickets.filter((t) => t.status === 'done').map((t) => t.id);
  const failed = planObj.tickets.filter((t) => t.status === 'failed').map((t) => ({ id: t.id, note: t.note }));
  const closedList = planObj.tickets.filter((t) => t.status === 'closed').map((t) => ({ id: t.id, why: t.note }));
  const finished = start.length === 0 && planObj.tickets.every((t) => ['done', 'failed', 'closed'].includes(t.status));
  let why;
  const laneText = lanes === Infinity ? 'no lane cap' : `${lanes} lane${lanes === 1 ? '' : 's'}`;
  if (start.length) why = lanes === Infinity ? `starting every ready ticket in parallel — ${start.join(', ')}` : `${start.length} of ${lanes} lane${lanes === 1 ? '' : 's'} free — starting ${start.join(', ')}`;
  else if (lanes === 0) why = `no lanes${planObj.band ? ` (usage band ${planObj.band})` : ''} — nothing starts until the budget allows`;
  else if (finished) why = "the day's plan is complete";
  else if (free === 0) why = `all ${laneText} busy (${running.join(', ')})`;
  else if (waiting.length) why = `waiting on prerequisites: ${waiting.map((w) => `${w.id} on ${w.on.map((o) => `${o.id} (${o.status})`).join(', ')}`).join('; ')}`;
  else why = stopped.length ? `stopped: ${stopped.map((s) => s.id).join(', ')} — answer them through /tp-run-ticket` : 'nothing queued';
  planObj.updatedAt = nowIso(nowMs);
  return { start, running: running.concat(opts.dry ? [] : start), waiting, stopped, resumable, done, failed, closed: closedList, finished, why };
}

// blocker rows as the state script records them (ticket.json.blockedBy): ids or rows in, rows out
function blockerRows(list, now) {
  return (Array.isArray(list) ? list : []).map((b) => (typeof b === 'string' ? { id: b } : b)).filter((b) => b && typeof b.id === 'string' && b.id)
    .map((b) => ({ id: b.id, state: b.state ?? null, resolved: b.resolved === true, soft: b.soft === true, checkedAt: b.checkedAt ?? now ?? null }));
}

export function plan(workroot, input = {}) {
  if (!workroot) fail('usage: day.mjs plan <workroot> \'<json>\'');
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  const date = input.date ?? today(nowMs);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`date must be YYYY-MM-DD, got "${date}"`);
  const from = input.from;
  if (!['sprint', 'pool'].includes(from)) fail('from must be "sprint" or "pool"');
  if (!Array.isArray(input.tickets)) fail('tickets must be an array');
  const ids = input.tickets.map((t) => t && t.id);
  if (ids.some((id) => typeof id !== 'string' || !/^\S+$/.test(id))) fail('every ticket needs an id without spaces');
  if (uniq(ids).length !== ids.length) fail('ticket ids must be unique');
  const cfg = dayConfig(input.claudeDir, input);
  const { lanes, band, lanesGiven } = lanesFor(input, cfg);
  const rows = rowsOf(workroot);
  const skipped = []; const inFlight = []; const cands = new Map();
  const dropped = new Set(Array.isArray(input.drop) ? input.drop : []);
  for (const t of input.tickets) {
    if (dropped.has(t.id)) { skipped.push({ id: t.id, why: 'dropped by the person' }); continue; }
    const row = rows[t.id];
    if (row && row.status === 'done') { skipped.push({ id: t.id, why: 'already done (its work directory is complete)' }); continue; }
    if (row && row.status === 'closed') { skipped.push({ id: t.id, why: `closed: ${row.closed?.why || 'the run ended early'}` }); continue; }
    if (t.inFlight || row) {
      const h = hoursOf(t, cfg);
      inFlight.push({ id: t.id, title: t.title || '', status: row ? row.status : 'in-flight', stage: row ? row.stopped?.stage ?? row.next ?? null : null, question: row?.stopped?.question ?? null, hours: h.hours, attention: Math.round(h.hours * cfg.attend * 10) / 10 });
      continue;
    }
    if (t.blocked) {
      // kept whole, so a later advance can re-queue it once a re-check finds its blockers resolved
      const h = hoursOf(t, cfg);
      skipped.push({ id: t.id, why: `blocked: ${t.blocked}`, blockedBy: blockerRows(t.blockedBy), candidate: { title: t.title || '', rating: RATINGS.includes(t.rating) ? t.rating : null, priority: Number.isFinite(t.priority) ? t.priority : null, after: uniq((Array.isArray(t.after) ? t.after : []).filter((a) => typeof a === 'string' && a !== t.id)), hours: h.hours, hoursSource: h.source, hoursWhy: h.why } });
      continue;
    }
    if (t.soft) { skipped.push({ id: t.id, why: `soft-blocked: ${t.soft}` }); continue; }
    const h = hoursOf(t, cfg);
    cands.set(t.id, {
      id: t.id, title: t.title || '', rating: RATINGS.includes(t.rating) ? t.rating : null,
      priority: Number.isFinite(t.priority) ? t.priority : null,
      after: uniq((Array.isArray(t.after) ? t.after : []).filter((a) => typeof a === 'string' && a !== t.id)),
      hours: h.hours, hoursSource: h.source, hoursWhy: h.why,
    });
  }
  if (Array.isArray(input.only) && input.only.length) { // keep these and their prerequisites, nothing else
    const keep = new Set();
    const walk = (id) => { if (!cands.has(id) || keep.has(id)) return; keep.add(id); for (const a of cands.get(id).after) walk(a); };
    for (const id of input.only) walk(id);
    for (const c of [...cands.values()]) if (!keep.has(c.id)) { cands.delete(c.id); skipped.push({ id: c.id, why: 'left out by the person (only …)' }); }
  }
  const inFlightIds = new Set(inFlight.map((i) => i.id));
  // `after` must point at a candidate, a ticket in flight or a finished one — anything else is a blocker
  for (let changed = true; changed;) {
    changed = false;
    for (const c of [...cands.values()]) {
      const kept = [];
      for (const a of c.after) {
        if (rows[a]?.status === 'done') continue;
        if (cands.has(a) || inFlightIds.has(a)) { kept.push(a); continue; }
        const s = skipped.find((x) => x.id === a);
        skipped.push({ id: c.id, why: `waits on ${a} (${s ? s.why : "not in today's candidates"})` });
        cands.delete(c.id); changed = true; break;
      }
      if (cands.has(c.id)) c.after = kept;
    }
  }
  const all = levels(cands, [...cands.keys()]);
  if (all.cycle.length) { const e = new Error(`dependency cycle: ${all.cycle.join(', ')}`); e.cycle = all.cycle; throw e; }
  const seed = input.seed ?? date;
  let order = [...cands.values()];
  if (from === 'sprint') {
    const dependents = new Map(order.map((c) => [c.id, order.filter((o) => o.after.includes(c.id)).length]));
    order.sort((a, b) => ((a.priority ?? Infinity) - (b.priority ?? Infinity)) || (dependents.get(b.id) - dependents.get(a.id)) || byId(a.id, b.id));
  } else order = shuffle(order.sort((a, b) => byId(a.id, b.id)), seeded(seed));
  // what an earlier day planned and did not finish comes first, in that day's order
  const carried = previousPlan(workroot, date);
  if (carried.length) {
    const rank = new Map(carried.map((id, i) => [id, i]));
    order.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
  }
  if (Array.isArray(input.first) && input.first.length) { // the person's order wins over everything
    const rank = new Map(input.first.map((id, i) => [id, i]));
    order.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
  }
  const count = Number.isInteger(input.count) && input.count > 0 ? input.count : from === 'pool' ? cfg.draw : null;
  const selected = []; const chosen = new Set();
  const closure = (id, out = [], seen = new Set()) => {
    if (seen.has(id)) return out;
    seen.add(id);
    for (const a of cands.get(id).after) if (cands.has(a)) closure(a, out, seen);
    out.push(id); return out;
  };
  const undrawn = [];
  for (const c of order) {
    if (chosen.has(c.id)) continue;
    const need = closure(c.id).filter((x) => !chosen.has(x));
    if (count != null && selected.length + need.length > count) { undrawn.push(c.id); continue; }
    for (const x of need) { chosen.add(x); selected.push(cands.get(x)); }
  }
  const { levels: batches } = levels(cands, selected.map((s) => s.id));
  const chosenOrder = new Map(selected.map((s, i) => [s.id, i]));
  // dependency levels first, then the selection order inside a level — the order the days are filled in
  const ordered = batches.flatMap((level) => level.slice().sort((a, b) => chosenOrder.get(a) - chosenOrder.get(b))).map((id) => {
    const c = cands.get(id);
    return { id, title: c.title, rating: c.rating, after: c.after, hours: c.hours, hoursSource: c.hoursSource, hoursWhy: c.hoursWhy, status: 'queued', stage: null, question: null, note: null, startedAt: null, endedAt: null };
  });
  const attention = inFlight.filter((i) => i.status !== 'stopped').reduce((sum, i) => sum + (i.attention || 0), 0);
  const days = schedule(ordered, cfg, date, attention);
  const review = !!input.review;
  const planObj = {
    date, from, iteration: input.iteration ?? null, features: Array.isArray(input.features) ? input.features : [],
    seed, lanes, lanesGiven, band, count, stackable: !!input.stackable, createdAt: nowIso(nowMs), updatedAt: nowIso(nowMs),
    approved: review ? null : nowIso(nowMs), approvedBy: review ? null : 'plan',
    adjustments: { drop: [...dropped], only: Array.isArray(input.only) ? input.only : [], first: Array.isArray(input.first) ? input.first : [] },
    day: { hours: cfg.hours, focus: cfg.focus, perDay: cfg.perDay, switch: cfg.switch, slack: cfg.slack, attend: cfg.attend, carry: cfg.carry },
    candidates: input.tickets.length, tickets: ordered, batches, days, carried, inFlight, skipped, undrawn: undrawn.sort(byId),
  };
  const previous = existsSync(planFile(workroot, date)) ? JSON.parse(readFileSync(planFile(workroot, date), 'utf8')) : null;
  for (const t of planObj.tickets) { // a re-plan keeps the launch stamps of tickets it already started
    const old = previous?.tickets.find((o) => o.id === t.id);
    if (old?.startedAt) { t.startedAt = old.startedAt; t.status = old.status === 'queued' ? 'queued' : 'starting'; }
  }
  if (review) { // a proposal: what would start, and the question the person answers
    const proposal = step(planObj, rows, { dry: true, now: input.now });
    const question = proposalQuestion(planObj, proposal);
    writeStop(workroot, planObj, question, nowMs);
    write(workroot, planObj);
    return { ...planObj, ...proposal, start: [], proposed: proposal.start, question, why: `awaiting approval — /tp-plan-day date=${date} answers=go-ahead, or an adjustment` };
  }
  clearStop(workroot, date);
  const result = step(planObj, rows, { dry: !!input.dry, now: input.now });
  write(workroot, planObj);
  return { ...planObj, ...result };
}

// the approval stop as the state script classifies it (README § Definitions, Asking the user): kind approval, default go-ahead
function proposalQuestion(planObj, proposal) {
  const now = proposal.start.length ? `now: ${proposal.start.join(', ')}` : 'now: nothing (everything waits or is blocked)';
  const then = proposal.waiting.map((w) => `${w.id} after ${w.on.map((o) => o.id).join(', ')}`);
  return `approval needed: day plan ${planObj.date} — ${planObj.tickets.length} ticket${planObj.tickets.length === 1 ? '' : 's'} — ${now}${then.length ? ` · then: ${then.join(' · ')}` : ''}` +
    `${planObj.skipped.length ? ` · skipped: ${planObj.skipped.map((s) => s.id).join(', ')}` : ''} — approve (go-ahead), or adjust: drop <ids> | only <ids> | add <ids> | first <ids> | lanes=<n|all>`;
}
function stopFile(workroot, date) { return join(workroot, '_scratch', `plan-day-${date}.stop.json`); }
function writeStop(workroot, planObj, question, nowMs) {
  mkdirSync(join(workroot, '_scratch'), { recursive: true });
  const file = stopFile(workroot, planObj.date);
  // `doc`: the day's plan itself — nobody approves a day they have not read (README § Definitions, Asking the user)
  const rec = { id: `plan-day:${planObj.date}`, skill: 'plan-day', slug: planObj.date, kind: 'approval', question, doc: join('_day', `${planObj.date}.md`), at: nowIso(nowMs), default: 'go-ahead', resume: `/tp-plan-day date=${planObj.date}` };
  writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 2) + '\n'); renameSync(`${file}.tmp`, file);
}
function clearStop(workroot, date) { const f = stopFile(workroot, date); if (existsSync(f)) rmSync(f, { force: true }); }

// the person's go-ahead: the plan is approved from here on and what is ready starts now
export function approve(workroot, date, input = {}) {
  const planObj = show(workroot, date);
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  planObj.approved = nowIso(nowMs); planObj.approvedBy = input.by || 'person';
  clearStop(workroot, date);
  write(workroot, planObj);
  return advance(workroot, date, { now: input.now, band: input.band, claudeDir: input.claudeDir });
}

export function show(workroot, date) {
  const file = planFile(workroot, date || '');
  if (!date || !existsSync(file)) fail(`no plan for ${date || '<date>'} under ${join(workroot, '_day')}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function advance(workroot, date, input = {}) {
  const planObj = show(workroot, date);
  const cfg = dayConfig(input.claudeDir, { hours: planObj.day?.hours, focus: planObj.day?.focus });
  const { lanes, band, lanesGiven } = lanesFor(input, cfg, planObj);
  planObj.lanes = lanes; planObj.lanesGiven = lanesGiven; if (band) planObj.band = band;
  if (typeof input.stackable === 'boolean') planObj.stackable = input.stackable;
  const rows = rowsOf(workroot);
  const unblocked = recheck(planObj, rows, input.recheck, cfg, input.now);
  if (planObj.approved === null) { // a proposal the person has not answered (a plan an older planner wrote has no field: it ran as drawn): nothing starts, the question stands
    const proposal = step(planObj, rows, { dry: true, now: input.now });
    const question = proposalQuestion(planObj, proposal);
    if (!input.dry) { writeStop(workroot, planObj, question, input.now ? Date.parse(input.now) : Date.now()); write(workroot, planObj); }
    return { ...planObj, ...proposal, start: [], proposed: proposal.start, question, unblocked, why: `awaiting approval — /tp-plan-day date=${date} answers=go-ahead, or an adjustment` };
  }
  const result = step(planObj, rows, { dry: !!input.dry, now: input.now });
  if (!input.dry) write(workroot, planObj); // a dry advance reads and reports; only a real one marks starts and stamps the file
  return { ...planObj, ...result, unblocked };
}

// a re-check's rows on the plan's skipped-blocked candidates: recorded; a candidate whose blockers are all resolved (or
// only soft) leaves `skipped`, joins `tickets` (queued, after what is already planned) and the days are scheduled again
function recheck(planObj, rows, input, cfg, now) {
  if (!input || typeof input !== 'object') return [];
  const nowMs = now ? Date.parse(now) : Date.now();
  const stamp = nowIso(nowMs);
  const unblocked = [];
  for (const sk of planObj.skipped.slice()) {
    if (!sk.candidate || !Array.isArray(input[sk.id])) continue;
    sk.blockedBy = blockerRows(input[sk.id], stamp);
    const ok = sk.blockedBy.length > 0 && sk.blockedBy.every((b) => b.resolved || b.soft);
    sk.why = `blocked: ${sk.blockedBy.map((b) => `${b.id} ${b.state || '?'}${b.resolved ? ' (resolved)' : b.soft ? ' (soft)' : ''}`).join(', ')}`;
    if (!ok) continue;
    const c = sk.candidate;
    const known = new Set([...planObj.tickets.map((t) => t.id), ...planObj.inFlight.map((i) => i.id)]);
    const after = c.after.filter((a) => known.has(a) || rows[a]?.status === 'done' || !!rows[a]);
    planObj.tickets.push({ id: sk.id, title: c.title, rating: c.rating, after, hours: c.hours, hoursSource: c.hoursSource, hoursWhy: c.hoursWhy, status: 'queued', stage: null, question: null, note: `unblocked ${stamp}`, startedAt: null, endedAt: null, day: null, endDay: null, slices: [] });
    planObj.skipped = planObj.skipped.filter((x) => x.id !== sk.id);
    unblocked.push(sk.id);
  }
  if (!unblocked.length) return unblocked;
  // the days again, over what is not settled: a re-queued ticket lands behind the plan's own order
  const settled = (t) => ['done', 'failed', 'closed'].includes(t.status);
  const attention = planObj.inFlight.filter((i) => i.status !== 'stopped').reduce((sum, i) => sum + (i.attention || 0), 0);
  planObj.days = schedule(planObj.tickets.filter((t) => !settled(t)), cfg, planObj.date, attention);
  const { levels: batches } = levels(new Map(planObj.tickets.map((t) => [t.id, { after: t.after }])), planObj.tickets.map((t) => t.id));
  planObj.batches = batches;
  return unblocked;
}

// the latest plan on or before `date` (YYYY-MM-DD), or null
function latestPlan(workroot, date) {
  const dir = join(workroot, '_day');
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= date).sort().pop()?.slice(0, 10) || null;
}

// the plan with live statuses, without writing: what the office draws and /tp-eod reads. `date` given → that plan;
// else the latest one on or before today. `rows` (the state script's rows by id) may be passed by a caller that
// already has them, so nothing is spawned twice.
export function status(workroot, date, input = {}) {
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  const todayStr = today(nowMs);
  const which = date || latestPlan(workroot, todayStr);
  if (!which) return null;
  const planObj = show(workroot, which);
  if (!planObj.lanesGiven) planObj.lanes = lanesFor({}, dayConfig(input.claudeDir), planObj).lanes; // as an advance would see it
  const rows = input.rows && typeof input.rows === 'object' ? input.rows : rowsOf(workroot);
  const result = step(planObj, rows, { dry: true, now: input.now });
  if (planObj.approved === null) return { ...planObj, ...result, start: [], proposed: result.start, question: proposalQuestion(planObj, result), stale: which < todayStr, why: `awaiting approval — /tp-plan-day date=${which} answers=go-ahead, or an adjustment` };
  return { ...planObj, ...result, stale: which < todayStr };
}

// the day's end (skills/tp-eod/SKILL.md): everything a person wants to know at the close, from the rows and the plan
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
  const errors = [...stopped.filter((s) => s.kind === 'error'), ...rows.filter((r) => (r.problems || []).length && r.status !== 'closed').map((r) => ({ id: r.id, kind: 'problem', question: r.problems.join('; '), resume: `/tp-run-ticket ${r.id} answers=retry` }))];
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

export function lanesInfo(band, claudeDir) {
  const cfg = dayConfig(claudeDir);
  return { band: band || 'unknown', lanes: cfg.lanes[band] ?? cfg.lanes.unknown, draw: cfg.draw, count: cfg.draw, day: { hours: cfg.hours, focus: cfg.focus, perDay: cfg.perDay, switch: cfg.switch, slack: cfg.slack, attend: cfg.attend, carry: cfg.carry } };
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n', () => process.exit(code));
}

// run as a command only when this file is the entry point — compared by real path, so a symlinked temp folder (macOS /var) counts
function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const [, , cmd, target, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'plan': emit(plan(target, readArg(rest[0]))); break;
      case 'advance': emit(advance(target, rest[0], readArg(rest[1]))); break;
      case 'approve': emit(approve(target, rest[0], readArg(rest[1]))); break;
      case 'show': emit(show(target, rest[0])); break;
      case 'status': { const r = status(target, rest[0] || null, readArg(rest[1])); if (!r) { console.error(`no plan under ${join(target, '_day')}`); process.exit(2); } emit(r); break; }
      case 'eod': emit(eod(target, rest[0] || null, readArg(rest[1]))); break;
      case 'lanes': emit(lanesInfo(target, rest[0])); break;
      default: console.error('usage: day.mjs plan|approve|advance|show|status|eod|lanes …'); process.exit(2);
    }
  } catch (e) {
    if (e.cycle) emit({ error: e.message, cycle: e.cycle }, 1);
    else { console.error(e.message); process.exit(2); }
  }
}
