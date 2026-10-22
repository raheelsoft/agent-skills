// mergegate.mjs — may this pull request be merged now? The irreversible step, decided by one function instead of four paragraphs: the review loop's own
// answer (`model.mjs rounds` → next), the platform's report (mergeable, required checks), and the person's word in its precedence — an explicit merge= on the
// invocation, else the conventions file or the person's standing instruction, else `ask` (reference/procedures.md § Review scope and rounds, Merging).
// A merge with an open P0/P1 finding is impossible here, not merely discouraged. Pure.

/**
 * @param {{ next: 'merge'|'fix'|'stop', open?: object, verdict?: string, mergeable?: boolean|null, checks?: 'pass'|'fail'|'pending'|'none'|null,
 *           merge?: 'auto'|'ask'|null, standing?: 'auto'|'ask'|null, why?: string }} s
 * @returns {{ action: 'merge'|'ask'|'fix'|'stop'|'sync'|'wait', why: string, mode?: 'auto'|'ask' }}
 *   fix   send the open fix-before-merging items back through /tp:create-pr update=true
 *   stop  the loop is over with items open (budget spent or no longer converging): report, do not merge
 *   sync  the base moved: /tp:create-pr update=true to sync, then ask again
 *   wait  required checks still running: look again, bounded by the caller
 *   ask   everything is in order and the person has not said to merge on a pass: the stop
 */
export function mergeDecision(s) {
  const blocking = (s.open?.P0 || 0) + (s.open?.P1 || 0);
  if (s.verdict === 'BLOCK' || blocking > 0) {
    if (s.next === 'stop') return { action: 'stop', why: s.why || `${blocking} fix-before-merging item(s) are still open and the loop is over` };
    return { action: 'fix', why: `${blocking} fix-before-merging item(s) open` };
  }
  if (s.next === 'fix') return { action: 'fix', why: s.why || 'the loop asks for another round' };
  if (s.next === 'stop') return { action: 'stop', why: s.why || 'the review loop ended' };
  if (s.mergeable === false) return { action: 'sync', why: 'the pull request is not mergeable: the base moved on' };
  if (s.checks === 'fail') return { action: 'stop', why: 'a required check is failing' };
  if (s.checks === 'pending') return { action: 'wait', why: 'required checks are still running' };
  const mode = s.merge || s.standing || 'ask';
  return mode === 'auto' ? { action: 'merge', mode, why: `passing review, every fix-before-merging item resolved, merge=auto${s.merge ? '' : ' (standing)'}` } : { action: 'ask', mode, why: `review ${s.verdict || 'passed'} — merge (merge), or send fixes (fix <what>)?` };
}
