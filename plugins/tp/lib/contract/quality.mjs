// quality.mjs — the score of a reviewed change. Findings carry a priority (P0 correctness, security, data loss … P4 style); what is still open
// at a pass is counted per priority, and the counts are what a gate compares: lexicographically, P0 first — one open P0 outweighs any number of P1s,
// one P1 any number of P2s. `score` is the same thing as one number for a status line (P0 1000, P1 100, P2 10, P3 3, P4 1) and never decides.
export const PRIORITY_KEYS = ['P0', 'P1', 'P2', 'P3', 'P4'];
export const WEIGHTS = { P0: 1000, P1: 100, P2: 10, P3: 3, P4: 1 };

const zero = () => Object.fromEntries(PRIORITY_KEYS.map((p) => [p, 0]));
const open = (f) => f.status === undefined || f.status === 'open';

/** What a review pass leaves open (the diff's own findings), what it fixed, and the pre-existing defects it ticketed. */
export function scoreOf(review) {
  const out = { open: zero(), resolved: zero(), preexisting: 0, score: 0 };
  for (const f of review.findings || []) {
    if (f.scope === 'pre-existing') { out.preexisting++; continue; }
    if (f.status === 'resolved') out.resolved[f.priority]++;
    else if (open(f)) out.open[f.priority]++;
  }
  out.score = PRIORITY_KEYS.reduce((n, p) => n + WEIGHTS[p] * out.open[p], 0);
  return out;
}

/** Lexicographic comparison of two open-counts: negative when `a` is the better change (fewer of the worst priority), 0 when equal. */
export function compareOpen(a, b) {
  for (const p of PRIORITY_KEYS) if (a[p] !== b[p]) return a[p] < b[p] ? -1 : 1;
  return 0;
}

const sum = (list) => list.reduce((acc, c) => Object.fromEntries(PRIORITY_KEYS.map((p) => [p, acc[p] + (c?.[p] || 0)])), zero());

/** A ticket's quality record from its passes: the latest pass of each repo decides where the ticket stands. */
export function aggregate(rounds) {
  const latest = new Map();
  for (const r of rounds) if (!latest.has(r.repo) || r.round >= latest.get(r.repo).round) latest.set(r.repo, r);
  const now = [...latest.values()];
  const counts = sum(now.map((r) => r.open));
  const verdicts = now.map((r) => r.verdict);
  return {
    open: counts,
    score: PRIORITY_KEYS.reduce((n, p) => n + WEIGHTS[p] * counts[p], 0),
    verdict: verdicts.includes('BLOCK') ? 'BLOCK' : verdicts.includes('PASS WITH WARNINGS') ? 'PASS WITH WARNINGS' : verdicts.length ? 'PASS' : null,
  };
}
