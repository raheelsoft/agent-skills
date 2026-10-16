// files.mjs — the day's plan on disk (work/_day/<date>.json and .md), the stop that asks the person to approve it, and reading it back.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, nowIso, today } from './util.mjs';

export function planFile(workroot, date) { return join(workroot, '_day', `${date}.json`); }

// the ids the latest earlier plan left queued, starting, running or on a later day — today's first candidates
export function previousPlan(workroot, date) {
  const dir = join(workroot, '_day');
  if (!existsSync(dir)) return [];
  const prev = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < date).sort().pop();
  if (!prev) return [];
  try {
    const p = JSON.parse(readFileSync(join(dir, prev), 'utf8'));
    return (p.tickets || []).filter((t) => ['queued', 'starting', 'running'].includes(t.status)).map((t) => t.id);
  } catch { return []; }
}

export function write(workroot, planObj) {
  const dir = join(workroot, '_day');
  mkdirSync(dir, { recursive: true });
  const file = planFile(workroot, planObj.date);
  writeFileSync(`${file}.tmp`, JSON.stringify(planObj, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  writeFileSync(join(dir, `${planObj.date}.md`), markdown(planObj));
}

export function markdown(p) {
  const line = (t, i) => `| ${i + 1} | ${t.id} ${t.title || ''} | ${t.rating || '—'} | ${t.hours ?? '—'}${t.hoursSource === 'model' ? '*' : ''} | ${t.day ?? '—'}${t.endDay && t.endDay !== t.day ? `–${t.endDay}` : ''} | ${t.after.length ? t.after.join(', ') : '—'} | ${t.status}${t.stage ? ` (${t.stage})` : ''}${t.question ? ` — ${t.question}` : ''}${t.note ? ` — ${t.note}` : ''} |`;
  const list = (title, items) => (items.length ? `\n${title}\n${items.map((s) => `- ${s}`).join('\n')}\n` : '');
  const dayLine = (d) => `| ${d.day} | ${d.date} | ${d.tickets.map((t) => `${t.id} ${t.hours}h`).join(', ') || '—'} | ${d.load} / ${d.capacity}h${d.carried ? ` (${d.carried} ${Math.round((d.load - d.tickets.reduce((s, t) => s + t.hours, 0)) * 10) / 10}h)` : ''} |`;
  return `# Day plan — ${p.date} (${p.from}${p.iteration ? `: ${p.iteration}` : ''})\n\n` +
    `features: ${p.features.length ? p.features.join(' · ') : 'all'} · lanes: ${p.lanes}${p.band ? ` (${p.band})` : ''} · count: ${p.count ?? 'all'} · seed: ${p.seed}\n` +
    `day: ${p.day.hours}h at ${Math.round(p.day.focus * 100)}% focus = ${p.day.perDay}h · switch ${p.day.switch}h · attend ${Math.round(p.day.attend * 100)}% of a running ticket\n` +
    `${p.approved ? `approved: ${p.approved}${p.approvedBy ? ` (${p.approvedBy})` : ''}` : 'awaiting approval — a proposal; nothing starts until `/tp:plan-day date=<date> answers=go-ahead`'}\n\n` +
    `| # | Ticket | Rating | Hours | Day | After | Status |\n|---|---|---|---|---|---|---|\n${p.tickets.map(line).join('\n')}\n` +
    `\n| Day | Date | Tickets | Load |\n|---|---|---|---|\n${(p.days || []).map(dayLine).join('\n')}\n` +
    `\nBatches: ${p.batches.map((b) => b.join(' + ')).join(' → ') || 'none'}\n` +
    list('In flight (already in the pipeline):', p.inFlight.map((i) => `${i.id} — ${i.status}${i.stage ? ` (${i.stage})` : ''}${i.question ? ` — ${i.question}` : ''}${i.attention ? ` — ${i.attention}h of attention today` : ''}`)) +
    (p.carried && p.carried.length ? `\nCarried over from the previous plan: ${p.carried.join(', ')}\n` : '') +
    (p.tickets.some((t) => t.hoursSource === 'model') ? '\n\\* hours estimated by the model (no tracker estimate)\n' : '') +
    list('Skipped:', p.skipped.map((s) => `${s.id} — ${s.why}`)) +
    (p.undrawn.length ? `\nNot drawn today: ${p.undrawn.join(', ')}\n` : '');
}

// the approval stop as the state script classifies it (reference/definitions.md § Definitions, Asking the user): kind approval, default go-ahead
export function proposalQuestion(planObj, proposal) {
  const now = proposal.start.length ? `now: ${proposal.start.join(', ')}` : 'now: nothing (everything waits or is blocked)';
  const then = proposal.waiting.map((w) => `${w.id} after ${w.on.map((o) => o.id).join(', ')}`);
  return `approval needed: day plan ${planObj.date} — ${planObj.tickets.length} ticket${planObj.tickets.length === 1 ? '' : 's'} — ${now}${then.length ? ` · then: ${then.join(' · ')}` : ''}` +
    `${planObj.skipped.length ? ` · skipped: ${planObj.skipped.map((s) => s.id).join(', ')}` : ''} — approve (go-ahead), or adjust: drop <ids> | only <ids> | add <ids> | first <ids> | lanes=<n|all>`;
}

export function stopFile(workroot, date) { return join(workroot, '_scratch', `plan-day-${date}.stop.json`); }

export function writeStop(workroot, planObj, question, nowMs) {
  mkdirSync(join(workroot, '_scratch'), { recursive: true });
  const file = stopFile(workroot, planObj.date);
  // `doc`: the day's plan itself — nobody approves a day they have not read (reference/definitions.md § Definitions, Asking the user)
  const rec = { id: `plan-day:${planObj.date}`, skill: 'plan-day', slug: planObj.date, kind: 'approval', question, doc: join('_day', `${planObj.date}.md`), at: nowIso(nowMs), default: 'go-ahead', resume: `/tp:plan-day date=${planObj.date}` };
  writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 2) + '\n'); renameSync(`${file}.tmp`, file);
}

export function clearStop(workroot, date) { const f = stopFile(workroot, date); if (existsSync(f)) rmSync(f, { force: true }); }

export function show(workroot, date) {
  const file = planFile(workroot, date || '');
  if (!date || !existsSync(file)) fail(`no plan for ${date || '<date>'} under ${join(workroot, '_day')}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// the latest plan on or before `date` (YYYY-MM-DD), or null
export function latestPlan(workroot, date) {
  const dir = join(workroot, '_day');
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= date).sort().pop()?.slice(0, 10) || null;
}
