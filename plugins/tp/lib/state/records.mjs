// records.mjs — the two facts a script records in ticket.json on a person's behalf: the blockers' states and the actual hours.
import { join } from 'node:path';
import { CliError, isDir, nowIso, readJson, writeAtomic } from './util.mjs';
import { appendLine } from './progress.mjs';
import { computeState } from './compute.mjs';

// record the blockers' states (start-ticket/instructions/blocked-check.md § Re-check) in ticket.json and note it
export function recordBlockers(workdir, payload) {
  const usageLine = 'usage: blockers <workdir> \'[{ "id", "state", "resolved", "soft" }]\'';
  if (!isDir(workdir)) { throw new CliError(usageLine, 2); }
  let rows;
  try { rows = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { throw new CliError(`${usageLine}\n${e.message}`, 2); }
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== 'string' || !r.id)) { throw new CliError(`${usageLine}\nevery row needs an id`, 2); }
  const file = join(workdir, 'ticket.json');
  const ticket = readJson(file, []);
  if (!ticket) { throw new CliError(`${file} missing or invalid`, 2); }
  const now = nowIso();
  ticket.blockedBy = rows.map((r) => ({ id: r.id, state: r.state ?? null, resolved: r.resolved === true, soft: r.soft === true, checkedAt: r.checkedAt === null ? null : r.checkedAt || now })); // an explicit null is a blocker nobody has looked up yet
  writeAtomic(file, ticket);
  const unblocked = ticket.blockedBy.length > 0 && ticket.blockedBy.every((b) => b.resolved || b.soft);
  const st = computeState(workdir);
  if (st.stopped) {
    const summary = `blockers re-checked: ${ticket.blockedBy.map((b) => `${b.id} ${b.state || '?'}${b.resolved ? ' (resolved)' : b.soft ? ' (soft)' : ''}`).join(', ')}${unblocked ? ' — unblocked' : ''}`;
    appendLine(workdir, st.stopped.stage, 'note', summary, '');
  }
  return { blockedBy: ticket.blockedBy, unblocked };
}

// record the person's actual hours (reference/models-and-budget.md § Models and budget, Estimates) — the one writer of ticket.json.actual
export function recordActual(workdir, payload) {
  const usageLine = 'usage: actual <workdir> \'{ "focusedHours": n, "source": "person|tracker", "by": "eod" }\'';
  if (!isDir(workdir)) { throw new CliError(usageLine, 2); }
  let p;
  try { p = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { throw new CliError(`${usageLine}\n${e.message}`, 2); }
  if (!p || !(Number(p.focusedHours) > 0)) { throw new CliError(`${usageLine}\nfocusedHours must be a positive number`, 2); }
  const file = join(workdir, 'ticket.json');
  const ticket = readJson(file, []);
  if (!ticket) { throw new CliError(`${file} missing or invalid`, 2); }
  ticket.actual = { focusedHours: Math.round(Number(p.focusedHours) * 2) / 2, source: p.source === 'tracker' ? 'tracker' : 'person', at: nowIso(), by: typeof p.by === 'string' && p.by ? p.by : 'eod' };
  writeAtomic(file, ticket);
  return ticket.actual;
}
