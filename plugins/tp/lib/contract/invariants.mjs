// invariants.mjs — what a schema cannot say: rules across fields of one artifact. Each holds for every artifact the pipeline has ever
// written (the private corpus check proves it) and is a mistake when it fails, never a style point. Run only after the shape is valid.
const num = (v) => typeof v === 'number' && Number.isFinite(v);

const RULES = {
  plan: (p) => {
    const out = [];
    if (num(p.openQuestions) && p.status === 'ready' && p.openQuestions > 0) out.push(`$.status: "ready" but openQuestions is ${p.openQuestions}`);
    if (num(p.openQuestions) && p.status === 'open-questions' && p.openQuestions === 0) out.push('$.status: "open-questions" but openQuestions is 0');
    return out;
  },
  implement: (i) => (num(i.done) && num(i.total) && i.done > i.total ? [`$.done: ${i.done} steps done of ${i.total}`] : []),
  accept: (a) => {
    const out = [];
    for (const [key, result] of [['passed', 'pass'], ['failed', 'fail'], ['manual', 'manual']]) {
      const n = (a.criteria || []).filter((c) => c && c.result === result).length;
      if (num(a[key]) && a[key] !== n) out.push(`$.${key}: ${a[key]} but ${n} criteria have result "${result}"`);
    }
    return out;
  },
  pr: (p) => (p.merged && !p.verdict ? ['$.verdict: merged without a recorded verdict'] : []),
};

/** The cross-field errors of one artifact — [] for a kind without rules. */
export function invariants(artifact, value) {
  const rule = RULES[artifact];
  return rule && value && typeof value === 'object' ? rule(value) : [];
}
