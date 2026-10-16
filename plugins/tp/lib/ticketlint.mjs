#!/usr/bin/env node
// ticketlint.mjs — the mechanical half of a ticket draft's review (skills/create-ticket/instructions/ticket-template.md): the template's sections, at least one
// checkbox acceptance criterion, a defect's reproduction block, the brief's `Involves:` line, every `path:line` it cites really there, and no personal data. A
// ticket created from a draft that fails these costs the next stage a rework; the script says so before the tracker call, for no tokens.
//
//   node ticketlint.mjs <draft.md> [--repo <checkout>]...   -> { ok, findings: [{ severity: "blocking"|"advisory", rule, text }] }   exit 0 ok, 1 blocking findings
// A citation is checked against a `--repo` checkout (repeat for several); without one, citations are not checked and that is said as an advisory.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTIONS = ['Problem', 'Acceptance criteria', 'Implementation brief', 'Out of scope'];
const INVOLVES = ['data model', 'access control', 'public contract', 'second repo'];
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;
const PHONE = /(?<![\w./:-])\+?\d[\d ()-]{8,}\d(?![\w./:-])/g;
const hasPhone = (t) => [...t.matchAll(PHONE)].some((m) => m[0].replace(/\D/g, '').length >= 9); // a date or a version has fewer digits

const sectionOf = (text, name) => {
  const m = new RegExp(`^##\\s+${name}\\s*$`, 'mi').exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
};

export function lintTicket(text, { repos = [] } = {}) {
  const findings = [];
  const add = (severity, rule, msg) => findings.push({ severity, rule, text: msg });
  const body = String(text || '');
  for (const name of SECTIONS) {
    const s = sectionOf(body, name);
    if (s === null) add('blocking', 'sections', `## ${name} is missing`);
    else if (!s) add('blocking', 'sections', `## ${name} is empty`);
  }
  const ac = sectionOf(body, 'Acceptance criteria') || '';
  const boxes = ac.split('\n').filter((l) => /^\s*-\s*\[[ xX]\]/.test(l));
  if (!boxes.length) add('blocking', 'criteria', 'the acceptance criteria are not a checklist: one `- [ ] <observable outcome>` per criterion');
  for (const b of boxes) if (!b.replace(/^\s*-\s*\[[ xX]\]\s*/, '').trim()) add('blocking', 'criteria', 'an acceptance criterion is empty');
  if (/Steps to reproduce/i.test(body)) {
    if (!/\*\*Current:\*\*|^Current:/mi.test(body) || !/\*\*Expected:\*\*|Expected:/i.test(body)) add('blocking', 'defect', 'a defect states what happens (Current) and what should (Expected)');
    if (!/\*\*Environment:\*\*|^Environment:/mi.test(body)) add('advisory', 'defect', 'a defect names the environment, build or date of the report');
  }
  const brief = sectionOf(body, 'Implementation brief') || '';
  const inv = /Involves:(.*)/i.exec(brief);
  if (brief && !inv) add('advisory', 'brief', 'the brief has no `Involves:` line (data model, access control, public contract, second repo)');
  else if (inv) for (const k of INVOLVES) if (!inv[1].toLowerCase().includes(k)) add('advisory', 'brief', `the \`Involves:\` line does not say yes or no for ${k}`);
  const cites = [...brief.matchAll(/`([^`\s:]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:-\d+)?`/g)].map((m) => ({ path: m[1], line: Number(m[2]) }));
  if (cites.length && !repos.length) add('advisory', 'citations', `${cites.length} cited path(s) were not checked: no --repo was given`);
  else for (const c of cites) {
    const hit = repos.map((r) => join(r, c.path)).find((p) => existsSync(p) && statSync(p).isFile());
    if (!hit) add('blocking', 'citations', `\`${c.path}:${c.line}\` is not in ${repos.length > 1 ? 'any of the repos' : 'the repo'}`);
    else if (readFileSync(hit, 'utf8').split('\n').length < c.line) add('blocking', 'citations', `\`${c.path}:${c.line}\`: the file is shorter than that`);
  }
  if (EMAIL.test(body)) add('blocking', 'personal-data', 'an email address is in the draft: describe the person, do not name them (reference/procedures.md § Personal data)');
  if (hasPhone(body)) add('blocking', 'personal-data', 'a phone-number-like sequence is in the draft: describe it or use a synthetic one');
  return { ok: !findings.some((f) => f.severity === 'blocking'), findings };
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  const a = process.argv.slice(2);
  const file = a.find((x, i) => !x.startsWith('--') && a[i - 1] !== '--repo');
  if (!file || !existsSync(file)) { console.error('usage: ticketlint.mjs <draft.md> [--repo <checkout>]...'); process.exit(2); }
  const repos = a.flatMap((x, i) => (a[i - 1] === '--repo' ? [x] : []));
  const r = lintTicket(readFileSync(file, 'utf8'), { repos });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
