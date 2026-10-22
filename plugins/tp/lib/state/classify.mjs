// classify.mjs — what a stop is: its kind (question, approval, error, usage, blocked, problem), the document a person must read to answer it, the reset
// time of a usage pause, and the command that resumes it (reference/definitions.md § Definitions, Asking the user). Pure: it reads nothing but the stop it is given.
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// the reset time a usage pause names ("resume after <ISO>" or "<HH:MM>[Z]"), resolved against the stop's own day
export function resetTimeOf(question, at) {
  const m = /resume after ([^—|]+)/i.exec(question || '');
  if (!m) return null;
  const raw = m[1].trim().replace(/[.)\]]+$/, '');
  if (!Number.isNaN(Date.parse(raw))) return new Date(Date.parse(raw)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hm = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (!hm || !/^\d{4}-\d{2}-\d{2}T/.test(at || '')) return null;
  let t = Date.parse(`${at.slice(0, 10)}T${hm[1].padStart(2, '0')}:${hm[2]}:00Z`);
  if (t < Date.parse(at)) t += 24 * 3600000; // a reset before the stop's time is tomorrow's
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The document a stop is about (reference/definitions.md § Definitions, Asking the user). A one-line question is enough to decide
// "which API?", never enough to approve a plan: the stop names the file and the context that interviews shows it to
// the person before asking. Named, never inlined: the question itself stays one line, and that line is what goes to
// chat. The path is relative to the WORK ROOT, one base for every stop — a ticket's ("<id>/plan.md") and a scratch
// stop's ("_day/<date>.md") sit in the same inbox, and a reader that has one has the other.
export function docOf(stopped, ctx) {
  const q = stopped.question || '';
  if (!/^(approval needed:|open questions in)/i.test(q)) return null;
  const f = `${String(stopped.stage || '').split(':')[0]}.md`;
  return ctx.workdir && existsSync(join(ctx.workdir, f)) ? join(basename(ctx.workdir), f) : null;
}

// every stop gets a kind, what continues it and whether it can continue by itself — from the stop's own wording
// (reference/definitions.md § Definitions, Asking the user); never from re-reading progress.md
export function classifyStop(stopped, ctx = {}, now = Date.now()) {
  const q = stopped.question || '';
  const id = ctx.id || '?';
  let kind = 'question'; let dflt = null; let resetAt = null; let resumable = false; let needs = null; let resume = null;
  if (/^error:/i.test(q)) {
    kind = 'error';
    const parts = q.split(/\s+—\s+/);
    const r = parts.find((p) => /^resume:/i.test(p));
    resume = r ? r.replace(/^resume:\s*/i, '').trim() : `/tp:run-ticket ${id} answers=retry`;
    needs = parts.slice(1).filter((p) => !/^resume:/i.test(p)).join(' — ') || null;
    dflt = 'retry';
  } else if (/^usage at/i.test(q)) {
    kind = 'usage';
    resetAt = resetTimeOf(q, stopped.at);
    resumable = resetAt ? Date.parse(resetAt) <= now : false;
    resume = `/tp:run-ticket ${id}`;
  } else if (ctx.triageBlocked || /nothing to answer/i.test(q)) {
    kind = 'blocked';
    resumable = !!ctx.unblocked;
    resume = `/tp:run-ticket ${id}`;
    needs = q.replace(/^.*nothing to answer\s*[—-]?\s*/i, '').trim() || null;
  } else if (/^approval needed:/i.test(q)) {
    kind = 'approval';
    dflt = 'go-ahead';
    resume = `/tp:run-ticket ${id} answers=go-ahead`;
  } else {
    const items = q.split(/ \| (?=\d+[.:)]\s)/); // numbered questions are joined with " | "; a choice list inside one question is too
    const defaults = items.map((it) => { const m = /Default:\s*(.+?)\s*$/.exec(it); return m ? m[1].replace(/[.]$/, '') : null; });
    if (/^hand-off budget spent/i.test(q)) dflt = 'continue';
    else if (items.length === 1) dflt = defaults[0];
    else if (defaults.some(Boolean)) dflt = defaults.map((d, i) => `${i + 1}: ${d ?? ''}`).join(' | ');
    resume = `/tp:run-ticket ${id} answers="${dflt ?? '…'}"`;
  }
  Object.assign(stopped, { kind, default: dflt, resetAt, resumable, needs, resume, doc: stopped.doc ?? docOf(stopped, ctx) });
  return stopped;
}
