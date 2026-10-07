// findings.mjs — a review pass as data. The reviewer reports JSON (schemas/review-findings.schema.json): each finding has a priority, P0 to
// P4. This derives what used to be the model's to format and to judge — the tier a finding falls in, the verdict, the PR comment, the
// trailer the merge loop reads its history from — so the same findings always give the same comment and the same verdict.
//
//   P0 correctness, security, data loss      P1 contract break, regression, missing test      → Fix before merging  (gates the merge)
//   P2 design (SOLID, duplication, layering)                                                   → Should fix
//   P3 clean code     P4 style                                                                 → Could improve
//   a defect the diff did not introduce → Pre-existing · a resolution pass's leftover → Noted, not gating · a fixed item → Resolved
//
// verdictOf: BLOCK when a gate failed or a fix-before-merging item is open; PASS WITH WARNINGS when any other item of the diff is open; else PASS.
export const PRIORITIES = { P0: 'correctness, security, data loss', P1: 'contract break, regression, missing test', P2: 'design', P3: 'clean code', P4: 'style' };

export const TIERS = [
  { key: 'fix', title: 'Fix before merging', suffix: '', passes: ['full', 'delta', 'resolution'] },
  { key: 'should', title: 'Should fix', suffix: '. Your call.', passes: ['full'] },
  { key: 'could', title: 'Could improve', suffix: '. Your call.', passes: ['full'] },
  { key: 'resolved', title: 'Resolved', suffix: '', passes: ['delta', 'resolution'] },
  { key: 'preexisting', title: 'Pre-existing', suffix: '', passes: ['full', 'delta', 'resolution'] },
  { key: 'noted', title: 'Noted, not gating', suffix: '', passes: ['resolution'] },
];

/** The tier a finding falls in. */
export function tierOf(f) {
  if (f.status === 'resolved') return 'resolved';
  if (f.scope === 'pre-existing') return 'preexisting';
  if (f.status === 'noted') return 'noted';
  if (f.priority === 'P0' || f.priority === 'P1') return 'fix';
  return f.priority === 'P2' ? 'should' : 'could';
}

const isOpen = (f) => f.status === undefined || f.status === 'open';
const isDiff = (f) => f.scope !== 'pre-existing';

/** BLOCK, PASS WITH WARNINGS or PASS. */
export function verdictOf(review) {
  const failedGate = (review.gates || []).some((g) => /^fail/i.test(String(g.status).trim()));
  const open = (review.findings || []).filter((f) => isOpen(f) && isDiff(f) && f.status !== 'noted');
  if (failedGate || open.some((f) => tierOf(f) === 'fix')) return 'BLOCK';
  return open.length ? 'PASS WITH WARNINGS' : 'PASS';
}

/** Ids of the fix-before-merging items still open, and of those this pass raised — what pr.json's review row and the trailer record. */
export function idsOf(review) {
  const fixOpen = (review.findings || []).filter((f) => tierOf(f) === 'fix' && isOpen(f)).map((f) => f.id);
  const raised = (review.findings || []).filter((f) => (f.new !== undefined ? f.new : review.mode === 'full')).map((f) => f.id);
  return { open: fixOpen, new: raised };
}

/** The `pr.json` review row for this pass. */
export function rowOf(review) {
  const { open, new: raised } = idsOf(review);
  return { round: review.round, sha: review.sha, verdict: verdictOf(review), open, new: raised };
}

const list = (ids) => (ids.length ? ids.join(', ') : 'none');
const where = (f) => (f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``);

/** The PR comment, in the format skills/review/SKILL.md § 5 gives: only tiers that have items, and only the tiers this kind of pass has. */
export function renderReview(review) {
  const out = ['## Review Summary', '', `**Verdict:** ${verdictOf(review)}`, `**Confidence:** ${review.confidence}/5`];
  if ((review.gates || []).length) {
    out.push('', '### Gates', '| Gate  | Status | Notes |', '|-------|--------|-------|');
    for (const g of review.gates) out.push(`| ${g.gate} | ${g.status} | ${g.notes || ''} |`);
  }
  for (const tier of TIERS) {
    if (!tier.passes.includes(review.mode)) continue;
    const items = (review.findings || []).filter((f) => tierOf(f) === tier.key).sort((a, b) => a.id - b.id);
    if (!items.length) continue;
    out.push('', `#### ${tier.title} (${items.length})`);
    for (const f of items) {
      if (tier.key === 'preexisting') out.push(`${f.id}. ${where(f)} — ${f.text} — ${f.ticket ? `tracked as ${f.ticket}` : 'ticket needed'}`);
      else if (tier.key === 'noted' || tier.key === 'resolved') out.push(`${f.id}. ${where(f)} — ${f.text}${tier.key === 'resolved' ? ' — resolved' : ''}`);
      else out.push(`${f.id}. ${where(f)} — ${f.text}`, `   → ${tier.key === 'could' ? 'Minor. ' : ''}${(f.fix || '').replace(/[.\s]+$/, '')}${tier.suffix}`);
    }
  }
  const { open, new: raised } = idsOf(review);
  out.push('', `Reviewed: ${review.sha} · round ${review.round} · open: ${list(open)} · new: ${list(raised)}`);
  return `${out.join('\n')}\n`;
}
