// office.mjs — what the office draws, as one document: the agents with their status, the tickets, the inbox, the day, the budget, the doctor's last word
// and the totals.
import { join, dirname, resolve } from 'node:path';
import { status as dayStatus } from '../day.mjs';
import { EXTRA_STAGES, LOCK_STALE_MS } from './constants.mjs';
import { nowIso, readJson } from './util.mjs';
import { parseProgress } from './progress.mjs';
import { repoNames, stageStatus } from './stages.mjs';
import { computeState, rowOf, ticketDirs, totals } from './compute.mjs';
import { inbox } from './inbox.mjs';
import { officeConfig, readAgents } from './agents.mjs';

// the status the office shows for one agent, from its record, its stage and its relatives
export function agentStatus(a, agents, ticketState, entries, now) {
  if (a.left) return { status: a.left.status, since: a.left.at, question: null };
  const byId = Object.fromEntries(agents.map((x) => [x.id, x]));
  for (let p = a.parent && byId[a.parent]; p; p = p.parent && byId[p.parent]) if (p.left) return { status: 'gone', since: p.left.at, question: null };
  if (!ticketState) return { status: now - Date.parse(a.started) > LOCK_STALE_MS ? 'gone' : 'working', since: a.started, question: null };
  const idle = ticketState.lastEvent ? now - Date.parse(ticketState.lastEvent.ts) > LOCK_STALE_MS : false;
  if (idle || ticketState.lock?.stale) return { status: 'gone', since: ticketState.lastEvent?.ts || a.started, question: null };
  const children = agents.filter((x) => x.parent === a.id && !x.left);
  if (children.some((c) => agentStatus(c, agents, ticketState, entries, now).status === 'working')) return { status: 'working', since: a.started, question: null };
  if (a.level === 'manager') return ticketState.lock && !ticketState.lock.stale ? { status: 'working', since: a.started, question: null } : { status: 'gone', since: a.started, question: null };
  const stage = ticketState.stages.find((s) => s.name === a.stage) || (EXTRA_STAGES.has(a.stage) ? stageStatus(entries, a.stage) : null);
  const st = stage?.status || 'pending';
  const question = st === 'stopped' && ticketState.stopped?.stage === a.stage ? ticketState.stopped.question : null;
  const map = { 'in-progress': 'working', stopped: 'stopped', done: 'done', stale: 'gone', pending: 'working' };
  return { status: map[st] || 'working', since: stage?.at || a.started, question };
}

export function office(workroot) {
  const cfg = officeConfig(workroot);
  const now = Date.now();
  const problems = [];
  const dirs = ticketDirs(workroot);
  const states = Object.fromEntries(dirs.map((d) => { const s = computeState(d); return [s.id, { state: s, entries: parseProgress(d, []), dir: d }]; }));
  const rows = dirs.map(rowOf);
  const agents = readAgents(workroot).map((a) => {
    const t = a.ticket ? states[a.ticket] : null;
    const st = agentStatus(a, readAgents(workroot), t?.state || null, t?.entries || [], now);
    const suffix = a.stage.includes(':') ? a.stage.split(':')[1] : null;
    const projects = a.level === 'manager' ? [] : a.repo ? [a.repo] : suffix ? [suffix] : t ? repoNames(readJson(join(t.dir, 'ticket.json'), []), []) : [];
    return { ...a, ...st, projects };
  });
  const active = new Set(agents.filter((a) => a.ticket).map((a) => a.ticket));
  const tickets = rows.filter((r) => r.status !== 'done' || active.has(r.id));
  const names = new Set(cfg.projects);
  for (const r of tickets) for (const n of r.repos || []) names.add(n);
  for (const a of agents) for (const n of a.projects) names.add(n);
  const projects = [...names].map((name) => ({ name, tickets: tickets.filter((r) => (r.repos || []).includes(name)).map((r) => r.id) }));
  for (const r of rows) for (const p of r.problems || []) problems.push(`${r.id}: ${p}`);
  const claudeDir = dirname(resolve(workroot));
  // the day board: the latest plan with live statuses (day.mjs status, dry — the rows are the ones computed above)
  let day = null;
  try { day = dayStatus(workroot, null, { rows: Object.fromEntries(rows.map((r) => [r.id, r])) }); } catch (e) { day = { error: e.message }; }
  // the last usage reading pick recorded, and the last preflight (reference/models-and-budget.md § Models and budget; § Using it, Preflight)
  const budgetFile = readJson(join(workroot, '_budget.json'), []);
  const budget = budgetFile && budgetFile.at ? { ...budgetFile, ageMin: Math.max(0, Math.round((now - Date.parse(budgetFile.at)) / 60000)) } : null;
  const doctorFile = readJson(join(workroot, '_doctor.json'), []);
  const doctor = doctorFile && doctorFile.at ? {
    at: doctorFile.at, ok: doctorFile.ok !== false, ageHours: Math.max(0, Math.round((now - Date.parse(doctorFile.at)) / 360000) / 10),
    counts: ['ok', 'warn', 'fail'].reduce((c, k) => ({ ...c, [k]: (doctorFile.checks || []).filter((x) => x.status === k).length }), {}),
    checks: Array.isArray(doctorFile.checks) ? doctorFile.checks : [],
  } : null;
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const totalsAll = totals(workroot, { claudeDir });
  return {
    team: cfg.team, generatedAt: nowIso(), poll: cfg.poll, linger: cfg.linger, projects, tickets, agents, problems,
    inbox: inbox(workroot, now), day, budget, doctor,
    totals: { ...totalsAll, today: totals(workroot, { claudeDir, date: todayStr }) },
  };
}
