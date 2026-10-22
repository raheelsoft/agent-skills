// inboxreport.mjs — the inbox as the report the session acts on (skills/inbox/instructions/report.md): one header line, the groups in a fixed order, one
// line per stop with the stop's own wording, numbered questions and approvals shared in waiting order, and the `act:` tail. A pure function of what
// `state.mjs inbox` returns, so the stop's wording is never paraphrased and the numbers the interview uses are the numbers the report printed.

import { inbox } from './inbox.mjs';

const wait = (min) => (min == null ? 'waiting ?' : min < 60 ? `waiting ${min}m` : `waiting ${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`.replace(' 00m', ''));
const hhmm = (ts) => (typeof ts === 'string' && ts.length >= 16 ? ts.slice(11, 16) : '?');
const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const live = (i) => i.lock && !i.lock.stale;

/** The group an item belongs to, in the order the report lists them. */
function groupOf(i) {
  if (live(i)) return 'locks';
  if (i.answer) return 'queued';
  if (i.resumable) return 'resumes';
  if (i.kind === 'approval') return 'approvals';
  if (i.kind === 'blocked') return 'parked';
  if (i.kind === 'error') return 'errors';
  if (i.kind === 'problem') return 'problems';
  return 'questions';
}

/**
 * -> { text, counts, act } for the inbox items. `date` heads the report; `plan` is the day plan's one line (or null: "no plan"); `dry` leaves the act tail empty.
 */
export function renderInbox(items, { date = '', plan = null, dry = false } = {}) {
  const sorted = [...items].sort((a, b) => (b.waitingMin ?? -1) - (a.waitingMin ?? -1));
  const by = {};
  for (const i of sorted) (by[groupOf(i)] ||= []).push(i);
  const g = (k) => by[k] || [];
  const counts = { open: items.length, resume: g('resumes').length + g('queued').length, questions: g('questions').length, approvals: g('approvals').length, errors: g('errors').length, parked: g('parked').length, problems: g('problems').length };
  const L = [`inbox ${date}: ${counts.open} open · ${counts.resume} resume by themselves · ${counts.questions} questions · ${counts.approvals} approvals · ${counts.errors} errors · ${counts.parked} parked · ${counts.problems} problems`];
  const section = (title, rows) => { if (rows.length) L.push('', title, ...rows); };
  const line = (i, tail = '') => `${i.id} · ${i.stage ?? '—'} · ${wait(i.waitingMin)} · ${oneLine(i.question)}${tail}`;
  const cmd = (i) => (i.resume ? ` · ${i.resume}` : '');

  section('answers queued (re-invoke; the resume command takes the answer):', g('queued').map((i) => `- ${i.id} · ${i.stage ?? '—'} · answered "${i.answer.text}" from ${i.answer.by || '?'} ${hhmm(i.answer.queuedAt)}${i.ticket ? ` · /tp:run-ticket ${i.id}` : cmd(i)}`));
  section('resumes by itself (re-invoke):', g('resumes').map((i) => `- ${i.id} · ${i.stage ?? '—'} · ${oneLine(i.question)}${cmd(i)}`));
  let n = 0;
  const numbered = [...g('questions'), ...g('approvals')].sort((a, b) => (b.waitingMin ?? -1) - (a.waitingMin ?? -1));
  const numberOf = new Map(numbered.map((i) => [i, ++n]));
  const nline = (i) => `${numberOf.get(i)}. ${line(i, i.ticket ? '' : cmd(i))}`;
  section('questions (interview, then /tp:run-ticket <id> answers="…"):', g('questions').map(nline));
  section('approvals (interview: go-ahead, or a change):', g('approvals').map(nline));
  section('errors (needs a fix first, then answers=retry):', g('errors').map((i) => `- ${i.id} · ${i.stage ?? '—'} · ${oneLine(i.question)}${i.needs ? ` · needs: ${oneLine(i.needs)}` : ''}${cmd(i)}`));
  section('still parked (nothing to answer):', g('parked').map((i) => `- ${i.id} · ${i.stage ?? '—'} · ${oneLine(i.question)}`));
  section('problems (an inconsistency the state script found; needs a fix, then answers=retry):', g('problems').map((i) => `- ${i.id} · ${oneLine(i.question)}${cmd(i)}`));
  section('locks held elsewhere (not re-invoked):', g('locks').map((i) => `- ${i.id} · locked by ${i.lock.owner} since ${hhmm(i.lock.since)} (live) — wait, or \`unlock --force\` if that run is dead`));

  if (!dry) L.push('', `day plan ${date}: ${plan || 'no plan'}`);
  const ids = (list) => list.map((i) => i.id).join(' ');
  const act = dry ? 'act: none — dry run' : `act: ${[
    g('queued').length + g('resumes').length ? `run ${ids([...g('queued'), ...g('resumes')])}` : null,
    numbered.length ? `ask ${numbered.map((i) => numberOf.get(i)).sort((a, b) => a - b).join(' ')}` : null,
    g('errors').length + g('problems').length ? `retry ${ids([...g('errors'), ...g('problems')])}` : null,
    g('parked').length + g('locks').length ? `show ${ids([...g('parked'), ...g('locks')])}` : null,
    plan ? `plan-day ${date}` : null,
  ].filter(Boolean).join(' · ') || 'none'}`;
  L.push('', act);
  return { text: L.join('\n'), counts, act };
}

/** `state.mjs inbox <workroot> --render [--date d] [--plan "<line>"] [--dry]` — the open stops, rendered. */
export function inboxReport(workroot, o = {}) {
  return renderInbox(inbox(workroot), { date: typeof o.date === 'string' ? o.date : new Date().toISOString().slice(0, 10), plan: typeof o.plan === 'string' ? o.plan : null, dry: o.dry === true }).text;
}
