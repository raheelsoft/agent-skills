// derive.mjs — what `put` computes instead of trusting. A count the model types is a count the model can get wrong, and a fact already in another file
// is a fact that can disagree with it: plan.json's counts come from plan.md, accept.json's tallies from its own criteria, and the criteria themselves
// must be the ticket's. Runs on the document before the schema check, so what is written is consistent by construction; a document that cannot be made
// consistent (a criterion dropped, evidence left empty) is refused with the reason.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './util.mjs';
import { parsePlan } from '../contract/plan.mjs';

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** plan.json: status, flags, steps and openQuestions come from plan.md when it is there; the model supplies `complexity`. */
function plan(doc, workdir) {
  const file = join(workdir, 'plan.md');
  if (!existsSync(file)) return doc;
  const p = parsePlan(readFileSync(file, 'utf8'));
  const flags = (p.header.flags || []).filter((f) => f !== 'none');
  return { ...doc, status: p.header.status || doc.status, flags: p.header.flags ? flags : doc.flags, steps: p.steps.length || doc.steps, openQuestions: p.questions.length };
}

/** accept.json: the three tallies are the criteria's results; the criteria are the ticket's, each with its evidence. */
function accept(doc, workdir, fail) {
  if (!Array.isArray(doc.criteria)) return doc;
  const tally = (r) => doc.criteria.filter((c) => c && c.result === r).length;
  const out = { ...doc, passed: tally('pass'), failed: tally('fail'), manual: tally('manual') };
  const ticket = readJson(join(workdir, 'ticket.json'));
  if (ticket && Array.isArray(ticket.acceptanceCriteria) && ticket.acceptanceCriteria.length) {
    const have = new Set(doc.criteria.map((c) => c && c.n));
    const want = ticket.acceptanceCriteria.map((_, i) => i + 1);
    const missing = want.filter((n) => !have.has(n));
    const extra = [...have].filter((n) => !want.includes(n));
    if (missing.length) fail(`accept.json leaves out criterion ${missing.join(', ')} of ticket.json.acceptanceCriteria — every one is proved, or recorded as manual`);
    if (extra.length) fail(`accept.json has criterion ${extra.join(', ')}, which ticket.json.acceptanceCriteria (${want.length}) does not have`);
  }
  const bare = doc.criteria.filter((c) => c && (c.result === 'pass' || c.result === 'fail') && !String(c.evidence || '').trim()).map((c) => c.n);
  if (bare.length) fail(`accept.json: criterion ${bare.join(', ')} is recorded pass or fail with no evidence — name what was run or seen`);
  return out;
}

const DERIVE = { plan, accept };

/** The document with its derived fields filled, or a CliError (exit 2) naming what makes it inconsistent. */
export function derive(kind, doc, workdir) {
  const fn = DERIVE[kind];
  if (!fn) return doc;
  return fn(doc, workdir, (why) => { throw new CliError(`refused ${kind}.json: ${why}\nnothing was written — correct the JSON and put it again`, 2); });
}

/** accept.md, the same record as a table — written by `put accept`, so the two cannot differ. */
export function renderAccept(doc) {
  const cell = (t, n) => { const x = String(t ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  const where = doc.where === 'live' ? `live: ${(doc.targets || []).map((t) => `${t.repo}${t.env ? ` @ ${t.env.name || t.env.url || '?'}` : ''}`).join(', ')}` : `checkout: ${(doc.targets || []).map((t) => t.repo).join(', ')}`;
  const L = ['# Acceptance', '', `${where} — ${doc.passed} pass · ${doc.failed} fail · ${doc.manual} manual`, '', '| # | Criterion | Result | Evidence |', '|---|---|---|---|'];
  for (const c of doc.criteria || []) L.push(`| ${c.n} | ${cell(c.text, 120)} | ${c.result} | ${cell(c.evidence, 240)} |`);
  return `${L.join('\n')}\n`;
}
