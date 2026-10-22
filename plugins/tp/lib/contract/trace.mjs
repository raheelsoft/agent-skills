// trace.mjs — a review's proof that it looked: every acceptance criterion of the ticket has a row, a criterion the change does not deliver is a
// finding that blocks, and every high-priority hit of the mechanical scan (diffscan.mjs) is either raised or dismissed with a reason. Pure; `findings.mjs
// check --criteria <n> --scan <diffscan.json>` runs it after the schema, so a review that skipped any of it is refused before it is posted.

const BLOCKING = new Set(['P0', 'P1']);

/** Errors (strings) of a schema-valid review against the ticket's criteria count and the scan's hits. Empty = traced. */
export function traceErrors(review, { criteria = null, scan = null } = {}) {
  const errors = [];
  if (criteria !== null && criteria > 0 && review.mode !== 'resolution') {
    const rows = new Map((review.criteria || []).map((c) => [c.n, c]));
    for (let n = 1; n <= criteria; n++) {
      const row = rows.get(n);
      if (!row) { errors.push(`criterion ${n} of the ticket has no row in "criteria" — judge it against the diff`); continue; }
      if (row.status === 'covered' && !String(row.evidence || '').trim()) errors.push(`criterion ${n} is covered but names no evidence (file:line, test or request)`);
      if (row.status === 'missing' && !(review.findings || []).some((f) => f.criterion === n && BLOCKING.has(f.priority) && (f.status === undefined || f.status === 'open'))) errors.push(`criterion ${n} is missing in the change but no open P0/P1 finding carries "criterion": ${n}`);
    }
    for (const c of review.criteria || []) if (c.n > criteria) errors.push(`"criteria" has a row for ${c.n}, the ticket has ${criteria} criteria`);
  }
  if (scan && Array.isArray(scan.hits)) {
    for (const h of scan.hits.filter((x) => x.hint === 'P0' || x.hint === 'P1')) {
      const raised = (review.findings || []).some((f) => f.file === h.file && (h.line === 0 || f.line === h.line || f.line == null));
      const dismissed = (review.dismissed || []).some((d) => d.file === h.file && (d.rule === h.rule || !d.rule));
      if (!raised && !dismissed) errors.push(`the scan's ${h.rule} at ${h.file}${h.line ? `:${h.line}` : ''} is neither a finding nor in "dismissed" with a reason`);
    }
  }
  return errors;
}
