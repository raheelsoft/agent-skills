// retrofacts.mjs — what a retrospective counts and quotes, gathered by the script: the stops, the answers asked, the plan's implementation summary, the
// criteria that ended `manual`, the plan check's findings, the review rounds and what they left open, the minutes and tokens per stage, the estimate against
// the actual hours. The retro agent used to read about eight files and hand-count `questions` and `manualCriteria`; now it reads this and spends its
// tokens on the judgment — was each deviation foreseeable, which answers belong in the conventions file — which no script can make.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, isDir, readJson } from './util.mjs';
import { computeState, durations } from './compute.mjs';
import { usage } from './usage.mjs';

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

/** answers.md → [{ at, stage, question, answer }]: the `## <ts> — <stage> (…)` sections with their **Q:** and **A:** lines; go-ahead records are not questions. */
export function answersOf(text) {
  const out = [];
  for (const block of String(text).split(/^## /m).slice(1)) {
    const head = /^(\S+)\s+—\s+([^\n(]+?)\s*(?:\(|$)/m.exec(block);
    const q = /\*\*Q:\*\*\s*([\s\S]*?)(?=\n\*\*A:\*\*|\n## |$)/.exec(block)?.[1]?.trim() || '';
    const a = /\*\*A:\*\*\s*([\s\S]*?)(?=\n\ngo-ahead:|\n## |$)/.exec(block)?.[1]?.trim() || '';
    if (q || a) out.push({ at: head?.[1] || null, stage: head?.[2]?.trim() || null, question: q, answer: a });
  }
  return out;
}

/** plan.md § Implementation summary → { steps, commits, deviations (text), gates }. */
export function summaryOf(planText) {
  const m = /^## Implementation summary\s*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m.exec(planText);
  if (!m) return null;
  const line = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(m[1])?.[1]?.trim() || null;
  const steps = /^steps:\s*(\d+)\/(\d+)/mi.exec(m[1]);
  return { steps: steps ? { done: Number(steps[1]), total: Number(steps[2]) } : null, commits: line('commits') || (/commits:\s*(.*)$/mi.exec(m[1])?.[1] ?? null), deviations: line('deviations'), gates: line('gates') };
}

export function retroFacts(workdir, { claudeDir } = {}) {
  if (!isDir(workdir)) throw new CliError(`usage: retro-facts <workdir> — ${workdir} is not a directory`, 2);
  const st = computeState(workdir);
  const ticket = readJson(join(workdir, 'ticket.json'), []) || {};
  const progress = read(join(workdir, 'progress.md')).split('\n').filter((l) => l.includes(' · stopped · ')).map((l) => l.replace(/^- /, ''));
  const answers = answersOf(read(join(workdir, 'answers.md')));
  const accept = readJson(join(workdir, 'accept.json'), []);
  const check = readJson(join(workdir, 'plan-check.json'), []);
  const quality = readJson(join(workdir, 'quality.json'), []);
  const summary = summaryOf(read(join(workdir, 'plan.md')));
  const manual = (accept?.criteria || []).filter((c) => c.result === 'manual').map((c) => ({ n: c.n, text: c.text }));
  const u = usage(workdir, { claudeDir });
  const ratio = ticket.actual?.focusedHours && ticket.estimate?.focusedHours ? Math.round((100 * ticket.actual.focusedHours) / ticket.estimate.focusedHours) / 100 : null;
  return {
    id: st.id, title: st.title, rating: st.complexity, status: st.status || (st.next ? 'in-progress' : 'done'),
    estimate: ticket.estimate ? { focusedHours: ticket.estimate.focusedHours, source: ticket.estimate.source } : null, actual: ticket.actual?.focusedHours ?? null, actualOverEstimate: ratio,
    minutes: durations(workdir), tokens: { total: u.total, cost: u.cost, perStage: u.perStage },
    stops: progress, answers, summary, manualCriteria: manual,
    planCheck: check ? { verdict: check.verdict, round: check.round, findings: (check.findings || []).map((f) => ({ severity: f.severity, step: f.step, text: String(f.text).slice(0, 160) })) } : null,
    review: { prs: (st.prs || []).map((p) => ({ url: p.url, verdict: p.verdict, rounds: p.reviewRounds })), open: quality?.open || null, score: quality?.score ?? null },
    counts: { questions: answers.length, manualCriteria: manual.length, stops: progress.length },
  };
}
