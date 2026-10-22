// proof.mjs — the plan's promise that each acceptance criterion will be proved. § Verification of plan.md maps every numbered criterion of § Goal to
// the check that proves it, one line each:
//
//   - Criteria checks:
//     1 → test `test/list.test.js` "filters by q"        (a test file, optionally a test name that must appear in it)
//     2 → test `test/list.test.js` "returns all without q"
//     3 → manual 2                                       (step 2 of the Manual list below: a person proves it in a running instance)
//     4 → command `npm run test:e2e -- contacts`         (a command a stage may run; recorded, never run by the coverage script)
//
// `checksOf` reads the lines; `lintChecks` is plan-lint's rule that every criterion has at least one and each line is well-formed; `coverage.mjs`
// later checks the promises against the change. No dependencies.

const LINE = /^\s*(?:[-*]\s*)?(\d+)\s*(?:→|->)\s*(test|manual|command)\b\s*(.*)$/i;

/** The body of § Verification as [{ text, index }] outside code fences, and where it sits. */
function verification(plan) {
  const s = plan.sections.verification;
  if (!s) return [];
  const starts = Object.values(plan.sections).map((x) => x.line).filter((l) => l > s.line).sort((a, b) => a - b);
  const end = starts.length ? starts[0] - 1 : plan.rawLines.length;
  const out = [];
  for (let i = s.line; i < end; i++) if (!plan.fenced[i]) out.push({ text: plan.rawLines[i], index: i, line: i + 1 });
  return out;
}

/** { checks: [{ criterion, type, path?, name?, manual?, command?, line, text }], manualSteps } from § Verification. */
export function checksOf(plan) {
  const lines = verification(plan);
  const checks = [];
  let manual = 0; let inManual = false;
  for (const l of lines) {
    const m = LINE.exec(l.text);
    if (m) {
      const type = m[2].toLowerCase(); const rest = m[3].trim();
      const c = { criterion: Number(m[1]), type, line: l.line, text: rest };
      if (type === 'test') { c.path = /`([^`]+)`/.exec(rest)?.[1] || null; c.name = /["“]([^"”]+)["”]/.exec(rest)?.[1] || null; } else if (type === 'manual') c.manual = Number(/\d+/.exec(rest)?.[0]) || null; else c.command = /`([^`]+)`/.exec(rest)?.[1] || null;
      checks.push(c);
      continue;
    }
    if (/^\s*[-*]\s*Manual\b/i.test(l.text)) { inManual = true; continue; }
    if (inManual) { if (/^\s*\d+[.)]\s+\S/.test(l.text)) manual++; else if (/^\s*[-*]\s+\S/.test(l.text) && !/^\s{2,}/.test(l.text)) inManual = false; }
  }
  return { checks, manualSteps: manual };
}

/** plan-lint's rule: every criterion proved by a well-formed check. `add(severity, step, rule, text)`. Nothing to check without criteria. */
export function lintChecks(plan, add) {
  if (!plan.criteria.length) return;
  const { checks, manualSteps } = checksOf(plan);
  const nums = new Set(plan.criteria.map((c) => c.n));
  if (!checks.length) {
    add('blocking', '—', 'criteria-checks', '§ Verification maps no criterion to a check: add "- Criteria checks:" with one line per criterion, `<n> → test `<file>` "<name>"` | `manual <step>` | `command `<cmd>``');
    return;
  }
  for (const n of nums) if (!checks.some((c) => c.criterion === n)) add('blocking', '—', 'criteria-checks', `criterion ${n} has no check in § Verification`);
  for (const c of checks) {
    if (!nums.has(c.criterion)) add('blocking', '—', 'criteria-checks', `§ Verification line ${c.line} checks criterion ${c.criterion}, which § Goal does not number`);
    else if (c.type === 'test' && !c.path) add('blocking', '—', 'criteria-checks', `§ Verification line ${c.line}: a test check names its file in backticks`);
    else if (c.type === 'command' && !c.command) add('blocking', '—', 'criteria-checks', `§ Verification line ${c.line}: a command check gives the command in backticks`);
    else if (c.type === 'manual' && (!c.manual || c.manual > manualSteps)) add('blocking', '—', 'criteria-checks', `§ Verification line ${c.line}: "manual ${c.manual ?? '?'}" names a step of the Manual list, which has ${manualSteps}`);
  }
}
