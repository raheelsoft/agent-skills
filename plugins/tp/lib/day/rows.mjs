// rows.mjs — the work directories as the day planner reads them: a ticket's row, whether it is satisfied, and where it stands.
import { spawnSync } from 'node:child_process';
import { ORDER, STATE, stageIndex } from './util.mjs';

export const STARTING_GRACE_MS = 30 * 60 * 1000; // a launched ticket with no work directory after this long is reported failed

// the state script's rows for the work root, by ticket id
export function rowsOf(workroot) {
  const r = spawnSync(process.execPath, [STATE, 'all', workroot], { encoding: 'utf8' });
  let rows = [];
  try { rows = JSON.parse(r.stdout); } catch { rows = []; }
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

// a prerequisite is satisfied once its code is on the base branch (merge done on every repo) — or, when the
// project stacks dependent work, once its PR is open; a finished ticket always is
export function satisfied(row, stackable) {
  if (!row) return false;
  if (row.status === 'done') return true;
  if (row.status === 'error' || row.status === 'closed') return false;
  return stageIndex(row.next) > ORDER.indexOf(stackable ? 'create-pr' : 'merge');
}

export function statusOf(t, row, nowMs) {
  if (row) {
    if (row.status === 'stopped') return { status: 'stopped', stage: row.stopped?.stage ?? null, question: row.stopped?.question ?? null };
    if (row.status === 'done') return { status: 'done', stage: null, question: null };
    if (row.status === 'closed') return { status: 'closed', stage: null, question: null, note: row.closed?.why || 'closed early' };
    if (row.status === 'error') return { status: 'failed', stage: null, question: null, note: (row.problems || []).join('; ') || 'state error' };
    return { status: 'running', stage: row.next ?? null, question: null };
  }
  if (t.startedAt) {
    if (nowMs - Date.parse(t.startedAt) > STARTING_GRACE_MS) return { status: 'failed', stage: null, question: null, note: 'no work directory 30 min after the start — re-run /tp:run-ticket' };
    return { status: 'starting', stage: 'start-ticket', question: null };
  }
  return { status: 'queued', stage: null, question: null };
}

// blocker rows as the state script records them (ticket.json.blockedBy): ids or rows in, rows out
export function blockerRows(list, now) {
  return (Array.isArray(list) ? list : []).map((b) => (typeof b === 'string' ? { id: b } : b)).filter((b) => b && typeof b.id === 'string' && b.id)
    .map((b) => ({ id: b.id, state: b.state ?? null, resolved: b.resolved === true, soft: b.soft === true, checkedAt: b.checkedAt ?? now ?? null }));
}
