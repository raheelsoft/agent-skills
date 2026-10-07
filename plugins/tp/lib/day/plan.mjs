// plan.mjs — a day's plan: the candidates, their blockers and dependencies, estimates and schedule, put to the person for review.
import { existsSync, readFileSync } from 'node:fs';
import { RATINGS, byId, fail, nowIso, today, uniq } from './util.mjs';
import { dayConfig, lanesFor } from './config.mjs';
import { hoursOf, schedule } from './schedule.mjs';
import { blockerRows, rowsOf } from './rows.mjs';
import { levels, seeded, shuffle } from './select.mjs';
import { clearStop, planFile, previousPlan, proposalQuestion, write, writeStop } from './files.mjs';
import { step } from './step.mjs';

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
    return { ...planObj, ...proposal, start: [], proposed: proposal.start, question, why: `awaiting approval — /tp:plan-day date=${date} answers=go-ahead, or an adjustment` };
  }
  clearStop(workroot, date);
  const result = step(planObj, rows, { dry: !!input.dry, now: input.now });
  write(workroot, planObj);
  return { ...planObj, ...result };
}
