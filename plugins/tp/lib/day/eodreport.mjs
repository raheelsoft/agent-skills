// eodreport.mjs — the end-of-day report as text (the format is fixed here), the one question it asks, and the recording of the answers: everything of
// /tp:eod that is formatting or bookkeeping, so the skill relays it. `renderEod` and `askStop` are pure over the object `eod()` returns; `writeEod` and `answerEod` touch the work root.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { STATE, fail } from './util.mjs';
import { eod } from './eod.mjs';

const hm = (min) => (min == null ? '?' : min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m` : `${min}m`);
const hhmm = (ts) => (typeof ts === 'string' && ts.length >= 16 ? ts.slice(11, 16) : '');
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const clip = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The report, as the format in skills/eod/SKILL.md fixes it. */
export function renderEod(d) {
  const L = [`# End of day — ${d.date}`, ''];
  L.push(`done: ${d.done.length}${d.done.length ? ` — ${d.done.map((x) => `${x.id} ${clip(x.title, 70)} (${String(x.stage).split(':')[0]} ${hhmm(x.at)}${x.partial ? ', partial — still in progress' : ''})`).join(', ')}` : ''}`, '');
  const live = [];
  if (d.inProgress.length) live.push(`in progress: ${d.inProgress.map((x) => `${x.id} at ${x.stage || '?'}`).join(', ')}`);
  if (d.stopped.length) live.push(`stopped: ${d.stopped.map((x) => `${x.id} · ${x.stage} · ${x.kind} · waiting ${hm(x.waitingMin)} — ${clip(x.question)}${x.resume ? `; resume: ${x.resume}` : ''}`).join(' | ')}`);
  L.push(live.join(' | ') || 'in progress: none | stopped: none', '');
  const parked = d.parked.map((x) => `${x.id} ${clip(x.question, 120)}`).join(' | ');
  const errors = d.errors.map((x) => `${x.id} — ${clip(x.question, 120)}${x.resume ? ` (${x.resume})` : ''}`).join(' | ');
  L.push(`parked: ${parked || 'none'} | errors: ${errors || 'none'}`, '');
  L.push('| Ticket | Rating | Estimate | Actual | Pipeline | Tokens · cost |', '|---|---|---|---|---|---|');
  for (const t of [...d.perTicket].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
    L.push(`| ${t.id} | ${t.rating || '—'} | ${t.estimate ? `${t.estimate.focusedHours}h${t.estimate.source === 'pipeline' ? '*' : ''}` : '—'} | ${t.actual != null ? `${t.actual}h` : '—'} | ${hm(t.pipelineMin)} | ${num(t.tokens)} · ${t.cost != null ? `$${t.cost}` : '—'} |`);
  }
  const tot = d.totals;
  const b = d.budget;
  L.push('', `today: ${num(tot.tokens)} tokens · ${tot.cost != null ? `$${tot.cost}${tot.unpriced ? ` (${num(tot.unpriced)} unpriced)` : ''}` : `cost unavailable (${num(tot.unpriced)} unpriced)`}${b ? ` · budget ${b.band} ${b.binding?.percentUsed != null ? `${b.binding.percentUsed}% ` : ''}at ${hhmm(b.at)}` : ''}`, '');
  L.push(`tomorrow: ${d.carryOver.length ? d.carryOver.join(', ') : 'nothing carries over'}${d.plan?.why ? ` — ${d.plan.why}${d.plan.stale ? ` (plan from ${d.plan.date}, stale)` : ''}` : ''}`, '');
  L.push(`estimates: ${d.calibrate?.drift || 'no calibration yet'}`);
  return L.join('\n');
}

/** The stop that asks for the hours — null when every finished ticket already has them. */
export function askStop(d) {
  if (!d.missingActuals.length) return null;
  const q = d.missingActuals.map((m, i) => `${i + 1}. ${m.id} ${clip(m.title, 70)} — hours you spent? (estimate ${m.estimate ?? '?'}h) Default: ${m.estimate ?? 'skip'}`).join(' | ');
  return { id: `eod:${d.date}`, skill: 'eod', slug: d.date, kind: 'question', question: q, at: d.at, resume: `/tp:eod date=${d.date} answers="1: <hours> | 2: skip | …"`, tickets: d.missingActuals.map((m) => ({ id: m.id, estimate: m.estimate })) };
}

const stopFile = (workroot, date) => join(workroot, '_scratch', `eod-${date}.stop.json`);
const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };

/** Compute the day, write `_day/<date>.eod.md` and — unless `dry` — the stop that asks for the hours. */
export function writeEod(workroot, date, input = {}, { dry = false } = {}) {
  const d = eod(workroot, date, input);
  const file = join(workroot, '_day', `${d.date}.eod.md`);
  put(file, `${renderEod(d)}\n`);
  const stop = dry ? null : askStop(d);
  if (stop) put(stopFile(workroot, d.date), `${JSON.stringify(stop, null, 2)}\n`);
  else if (existsSync(stopFile(workroot, d.date))) rmSync(stopFile(workroot, d.date));
  return { date: d.date, report: file, asks: stop ? stop.question : null, done: d.done.length, stopped: d.stopped.length, tokens: d.totals.tokens, cost: d.totals.cost, notify: notifyLine(d) };
}

/** The one line /tp:notify sends at the close. */
export const notifyLine = (d) => `${d.date} · end of day · ${d.done.length} done · ${d.stopped.length} stopped · ${num(d.totals.tokens)} tokens${d.totals.cost != null ? ` · $${d.totals.cost}` : ''}`;

/** `1: 5 | 2: skip | 3: ` → { 1: 5, 2: 'skip', 3: '' }. */
export function parseAnswers(text) {
  const out = {};
  for (const part of String(text).split('|')) {
    const m = /^\s*(\d+)\s*[:.)]?\s*(.*?)\s*$/.exec(part);
    if (m) out[Number(m[1])] = m[2];
  }
  return out;
}

/** Record the answered hours, drop the stop, and write the report again so it and the drift reflect them. */
export function answerEod(workroot, date, text, input = {}) {
  const day = date || eod(workroot, null, input).date;
  const file = stopFile(workroot, day);
  if (!existsSync(file)) fail(`no actuals question for ${day} (${file} is missing): run the report first`);
  const stop = JSON.parse(readFileSync(file, 'utf8'));
  const answers = parseAnswers(text);
  const recorded = []; const skipped = [];
  (stop.tickets || []).forEach((t, i) => {
    const a = answers[i + 1];
    if (a === undefined || /^skip$/i.test(a)) { skipped.push(t.id); return; }
    const hours = a === '' ? Number(t.estimate) : Number(String(a).replace(/h$/i, ''));
    if (!(hours > 0)) { skipped.push(t.id); return; }
    const r = spawnSync(process.execPath, [STATE, 'actual', join(workroot, t.id), JSON.stringify({ focusedHours: hours, source: 'person', by: 'eod' })], { encoding: 'utf8' });
    if (r.status === 0) recorded.push({ id: t.id, hours }); else fail(`could not record ${t.id}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  });
  rmSync(file);
  const rep = writeEod(workroot, day, input, { dry: true });
  return { date: day, recorded, skipped, report: rep.report, notify: rep.notify };
}

/** `day.mjs eod <root> [date] ['<json>'] [--render [--dry]] [--answers "<text>"]` — which of the three the arguments ask for. `readArg` parses the JSON argument. */
export function eodMain(workroot, rest, readArg) {
  const ai = rest.indexOf('--answers');
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(ai >= 0 && i === ai + 1));
  const date = pos[0] || null; const input = readArg(pos[1]);
  if (ai >= 0) return answerEod(workroot, date, rest[ai + 1] ?? '', input);
  if (rest.includes('--render')) return writeEod(workroot, date, input, { dry: rest.includes('--dry') });
  return eod(workroot, date, input);
}
