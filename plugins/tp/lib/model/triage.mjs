// triage.mjs — the triage rubric as a function. /tp:triage's agent reads the ticket and the code and judges each row of skills/triage/instructions/criteria.md
// (that judgment is the model's); what the rows then *add up to* — needs-input, plan or direct, and the complexity the rubric of reference/models-and-budget.md
// gives — is mechanical: the first column that applies decides, the highest rating column wins, uncertain means higher, and when direct and plan are both
// defensible the answer is plan. The agent records the evidence; this returns the decision, so two tickets with the same evidence are never triaged differently.
import { RATINGS } from './common.mjs';

const up = (r) => RATINGS[Math.min(RATINGS.length - 1, RATINGS.indexOf(r) + 1)];
const max = (...rs) => rs.reduce((a, b) => (RATINGS.indexOf(b) > RATINGS.indexOf(a) ? b : a), 'low');

/**
 * @param {{ epic?: boolean, criteria: 'clear'|'partial'|'missing'|'contradict', files: number|null, areas?: number, pattern: 'adjacent'|'elsewhere'|'none',
 *           dataModel?: boolean, access?: boolean, contract?: boolean, repos?: number, irreversible?: boolean, sharedEnv?: boolean,
 *           questions?: 'none'|'planner'|'stakeholder', derived?: boolean, uncertain?: boolean }} e
 * @returns {{ decision: 'needs-input'|'plan'|'direct', complexity: 'low'|'medium'|'high', why: string[], columns: object }}
 */
export function triage(e = {}) {
  const files = e.files == null ? null : Number(e.files);
  const areas = Number(e.areas ?? 1);
  const repos = Number(e.repos ?? 1);
  const risky = [e.dataModel && 'data model', e.access && 'access control', e.contract && 'public contract', e.irreversible && 'irreversible', e.sharedEnv && 'shared environment'].filter(Boolean);
  const why = [];

  let decision;
  if (e.epic) { decision = 'needs-input'; why.push('an epic or container: which sub-issue?'); }
  if (e.criteria === 'missing' || e.criteria === 'contradict') { decision = 'needs-input'; why.push(`acceptance criteria ${e.criteria === 'missing' ? 'missing' : 'contradict the code'}`); }
  if (e.questions === 'stakeholder') { decision = 'needs-input'; why.push('a decision only the person can make'); }
  if (files === null) { decision = 'needs-input'; why.push("the blast radius can't be estimated"); }
  if (!decision) {
    if (e.criteria === 'partial') why.push('criteria partly clear');
    if (files > 5) why.push(`${files} files`);
    if (areas > 1) why.push(`${areas} areas`);
    if (e.pattern === 'none') why.push('no pattern to follow');
    for (const r of risky) why.push(r);
    if (repos > 1) why.push(`${repos} repos`);
    if (e.questions === 'planner') why.push('questions a planner can answer from the code');
    decision = why.length ? 'plan' : 'direct';
    if (decision === 'direct') why.push('clear criteria, ≤ 5 files in one area with a pattern, none of the risk rows');
  }

  const scope = files === null || areas > 1 || repos > 1 || files > 5 || e.pattern === 'none' ? 'high' : files <= 1 ? 'low' : 'medium';
  const ambiguity = e.criteria === 'clear' && !e.derived && (e.questions || 'none') === 'none' ? 'low' : e.criteria === 'partial' && !e.derived && e.questions !== 'stakeholder' ? 'medium' : 'high';
  const risk = risky.length ? 'high' : (files ?? 2) <= 1 ? 'low' : 'medium';
  const novelty = e.pattern === 'adjacent' ? 'low' : e.pattern === 'elsewhere' ? 'medium' : 'high';
  const columns = { scope, ambiguity, risk, novelty };
  let complexity = max(scope, ambiguity, risk, novelty);
  if (e.uncertain) { complexity = up(complexity); why.push('uncertain: one level up'); }
  return { decision, complexity, why, columns };
}
