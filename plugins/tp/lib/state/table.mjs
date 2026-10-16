// table.mjs — the status board as text: one row per ticket, the totals line, the problems and the worktrees nobody removed. It is what
// `state.mjs table <workroot>` prints, so the skill relays it instead of a model formatting the JSON of `all`. The columns are described in reference/definitions.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, totals } from './compute.mjs';

const HEAD = ['Ticket', 'Title', 'Decision · rating', 'Estimate', 'Status', 'Next / waiting on', 'Run', 'PR · verdict · merged', 'Tokens · cost', 'Last event', 'Age'];

const cell = (text) => String(text ?? '').replace(/(?<!\\)\|/g, '\\|').replace(/\s+/g, ' ').trim();
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** 1234567 → 1.2M, 54321 → 54k. */
export function compact(n) {
  if (n == null) return '';
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** Minutes as the largest whole unit: 12m, 3h, 26d. */
export function age(min) {
  if (min == null) return '';
  if (min < 90) return `${min}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

const estimateOf = (r) => {
  const e = r.estimate;
  const base = e && e.focusedHours != null ? `${e.focusedHours}h · ${e.days ?? '?'}d${e.source === 'pipeline' ? '*' : ''}` : '';
  const done = r.actual && r.actual.focusedHours != null ? `actual ${r.actual.focusedHours}h` : '';
  return [base, done].filter(Boolean).join(' · ');
};

const statusOf = (r) => {
  if (r.status === 'stopped') return `stopped (${r.stopped?.kind || 'question'})`;
  if (r.status === 'done' && r.retro) return 'done · retro';
  return r.status;
};

const waitingOf = (r) => {
  const queued = r.answer ? ` — answer queued (${r.answer.by || '?'}, ${r.answer.at || r.answer.ts || '?'})` : '';
  if (r.status === 'stopped') {
    const q = clip(cell(r.stopped?.question), 140);
    if (r.stopped?.kind === 'blocked' && r.blockedBy?.length) {
      const rows = r.blockedBy.map((b) => `${b.id} ${b.resolved ? 'resolved' : clip(cell(b.state || 'open'), 40)}${b.checkedAt ? ` (${b.checkedAt.slice(0, 10)})` : ''}`);
      return `${rows.join('; ')}${r.unblocked ? ' — unblocked' : ''}${queued}`;
    }
    return `${q}${r.stopped?.default ? ` [default: ${r.stopped.default}]` : ''}${queued}`;
  }
  if (r.status === 'closed') return clip(cell(r.closed?.why), 140);
  if (r.status === 'error') return clip(cell(r.problems?.[0]), 140);
  return r.next ? `next: ${r.next}` : '';
};

const lockOf = (r) => (r.lock ? `${r.lock.owner} since ${String(r.lock.since || '').slice(0, 16)}${r.lock.stale ? ' stale' : ''}` : '');

const prOf = (r) => {
  const parts = (r.prs || []).map((p) => {
    const n = /(\d+)\/?$/.exec(p.url || '')?.[1];
    return [n ? `#${n}` : p.url, p.verdict, p.merged ? `merged ${String(p.merged).slice(0, 8)}` : ''].filter(Boolean).join(' ');
  });
  const q = r.quality;
  if (q) {
    const open = Object.entries(q.open || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(' ');
    parts.push(`quality ${open || 'clean'}${open ? ` · score ${q.score}` : ''}`);
  }
  return parts.join(' · ');
};

const costOf = (r) => {
  const out = [];
  if (r.tokens) out.push(compact(r.tokens));
  if (r.cost != null) out.push(`$${r.cost}`);
  if (r.tokensUnpriced && r.cost != null) out.push(`+${compact(r.tokensUnpriced)} unpriced`);
  if (r.tokensPartial) out.push('partial');
  return out.join(' · ');
};

const rowCells = (r) => [
  r.id,
  clip(cell(r.title), 60),
  [r.decision, r.complexity].filter(Boolean).join(' · '),
  estimateOf(r),
  statusOf(r),
  waitingOf(r),
  lockOf(r),
  prOf(r),
  costOf(r),
  r.lastEvent ? `${r.lastEvent.stage} ${r.lastEvent.event}` : '',
  age(r.ageMin),
].map(cell);

/** The worktrees a finished or closed ticket still holds, each with the commands that remove them. */
function leftovers(rows, workroot) {
  const out = [];
  for (const r of rows) {
    if (!['done', 'closed'].includes(r.status) || !r.worktrees?.length) continue;
    let repos = [];
    try { repos = JSON.parse(readFileSync(join(workroot, r.id, 'ticket.json'), 'utf8')).repos || []; } catch { /* no ticket.json: no commands */ }
    for (const name of r.worktrees) {
      const repo = repos.find((x) => x.name === name);
      out.push(`- ${r.id} ${name}: ${repo?.path && repo?.worktree ? `git -C ${repo.path} worktree remove ${repo.worktree}` : 'worktree still on disk'}`);
    }
  }
  return out;
}

/**
 * The board for a work root. `filter: 'problems'` keeps only the tickets whose state reports a problem.
 * `rows` and `sum` are injectable so the rendering is testable without a work directory.
 */
export function statusTable(workroot, { filter, rows = all(workroot), sum = totals(workroot) } = {}) {
  const shown = filter === 'problems' ? rows.filter((r) => r.problems?.length) : rows;
  const lines = [`| ${HEAD.join(' | ')} |`, `|${HEAD.map(() => '---').join('|')}|`, ...shown.map((r) => `| ${rowCells(r).join(' | ')} |`)];
  const t = sum.tickets || {};
  lines.push('', `${rows.length} ticket(s): ${t.active || 0} active · ${t.stopped || 0} stopped · ${t.done || 0} done · ${t.closed || 0} closed — ${compact(sum.tokens)} tokens${sum.cost != null ? ` · $${sum.cost}` : ''}${sum.unpriced ? ` (${compact(sum.unpriced)} unpriced)` : ''}${sum.partial ? ' · partial' : ''}`);
  const problems = rows.filter((r) => r.problems?.length).flatMap((r) => r.problems.map((p) => `- ${r.id}: ${p}`));
  if (problems.length) lines.push('', 'Problems', ...problems);
  const left = leftovers(rows, workroot);
  if (left.length) lines.push('', 'Worktrees still held by finished tickets', ...left);
  const stale = rows.filter((r) => r.lock?.stale).map((r) => `- ${r.id}: node state.mjs unlock ${r.id} ${r.lock.owner}`);
  if (stale.length) lines.push('', 'Stale locks', ...stale);
  return lines.join('\n');
}
