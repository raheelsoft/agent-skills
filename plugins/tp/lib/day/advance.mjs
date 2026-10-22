// advance.mjs — the plan after the person's approval: approve it, advance the running day, re-check blockers, show the status with live statuses.
import { nowIso, today } from './util.mjs';
import { dayConfig, lanesFor } from './config.mjs';
import { schedule } from './schedule.mjs';
import { blockerRows, rowsOf } from './rows.mjs';
import { levels } from './select.mjs';
import { clearStop, latestPlan, proposalQuestion, show, write, writeStop } from './files.mjs';
import { step } from './step.mjs';

// the person's go-ahead: the plan is approved from here on and what is ready starts now
export function approve(workroot, date, input = {}) {
  const planObj = show(workroot, date);
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  planObj.approved = nowIso(nowMs); planObj.approvedBy = input.by || 'person';
  clearStop(workroot, date);
  write(workroot, planObj);
  return advance(workroot, date, { now: input.now, band: input.band, claudeDir: input.claudeDir });
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
    return { ...planObj, ...proposal, start: [], proposed: proposal.start, question, unblocked, why: `awaiting approval — /tp:plan-day date=${date} answers=go-ahead, or an adjustment` };
  }
  const result = step(planObj, rows, { dry: !!input.dry, now: input.now });
  if (!input.dry) write(workroot, planObj); // a dry advance reads and reports; only a real one marks starts and stamps the file
  return { ...planObj, ...result, unblocked };
}

// a re-check's rows on the plan's skipped-blocked candidates: recorded; a candidate whose blockers are all resolved (or
// only soft) leaves `skipped`, joins `tickets` (queued, after what is already planned) and the days are scheduled again
export function recheck(planObj, rows, input, cfg, now) {
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

// the plan with live statuses, without writing: what the office draws and /tp:eod reads. `date` given → that plan;
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
  if (planObj.approved === null) return { ...planObj, ...result, start: [], proposed: result.start, question: proposalQuestion(planObj, result), stale: which < todayStr, why: `awaiting approval — /tp:plan-day date=${which} answers=go-ahead, or an adjustment` };
  return { ...planObj, ...result, stale: which < todayStr };
}
