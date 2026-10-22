// step.mjs — one advance of a plan: refresh every ticket's status, start what is ready within the lanes, report what waits.
import { nowIso, uniq } from './util.mjs';
import { laneCap } from './config.mjs';
import { satisfied, statusOf } from './rows.mjs';

// refresh statuses, fill the free lanes, mark what starts — shared by plan and advance
export function step(planObj, rows, opts) {
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
  else why = stopped.length ? `stopped: ${stopped.map((s) => s.id).join(', ')} — answer them through /tp:run-ticket` : 'nothing queued';
  planObj.updatedAt = nowIso(nowMs);
  return { start, running: running.concat(opts.dry ? [] : start), waiting, stopped, resumable, done, failed, closed: closedList, finished, why };
}
