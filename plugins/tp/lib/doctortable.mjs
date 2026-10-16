// doctortable.mjs — the preflight as text: the checks `doctor.mjs run` (and `add`) left in <.claude>/work/_doctor.json as a table, failures first, and
// the one summary line a run or a person reads. Rendered here so the skill relays it instead of redrawing JSON after every added check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORDER = { fail: 0, warn: 1, ok: 2 };
const cell = (t) => String(t ?? '').replace(/(?<!\\)\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The table and summary of a doctor record ({ at, checks: [{ name, status, detail, fix }] }). */
export function renderDoctor(rec) {
  const checks = [...(rec.checks || [])].sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3));
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const L = ['| check | status | detail | fix |', '|---|---|---|---|', ...checks.map((c) => `| ${cell(c.name)} | ${c.status} | ${cell(c.detail)} | ${cell(c.fix)} |`)];
  L.push('', `preflight: ${fails || warns ? `${warns} warning(s) | ${fails} failure(s)` : 'ok'} — ${rec.at || 'not run'}`);
  return { text: L.join('\n'), failures: fails, warnings: warns };
}

/** Read <.claude>/work/_doctor.json and render it. */
export function doctorTable(claudeDir) {
  let rec;
  try { rec = JSON.parse(readFileSync(join(claudeDir, 'work', '_doctor.json'), 'utf8')); } catch { return { text: 'preflight: not run — `node <lib>/doctor.mjs run <.claude>` first', failures: 1, warnings: 0 }; }
  return renderDoctor(rec);
}
