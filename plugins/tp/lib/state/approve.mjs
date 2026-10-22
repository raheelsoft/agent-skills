// approve.mjs — recording a plan's approval, which has one exact shape the rest of the pipeline reads: the `answers.md` line `go-ahead: <timestamp> —
// round <n> — <risk flags>` at the start of a line (`n` = ticket.json.round, so an earlier round's go-ahead never covers a new plan), the check's
// override when it still said `revise` (the person accepted the open risks), and the `plan note "approved"` log. Typed by hand, a malformed line leaves the
// ticket stuck at `plan`; written here it cannot be malformed. The approval itself stays the person's: this runs when `answers=go-ahead` arrives, and refuses
// when the plan is not the one waiting for it (open questions, or not stopped at `plan`).
import { join } from 'node:path';
import { CliError, isDir, nowIso, readJson } from './util.mjs';
import { computeState } from './compute.mjs';
import { writeDoc } from './doc.mjs';
import { putArtifact } from './put.mjs';
import { log } from './progress.mjs';

/** -> { line, round, flags, override: boolean, steps } */
export function approvePlan(workdir, { by = null } = {}) {
  if (!isDir(workdir)) throw new CliError(`usage: approve <workdir> — ${workdir} is not a directory`, 2);
  const st = computeState(workdir);
  if (!st.stopped || st.stopped.stage !== 'plan') throw new CliError(`${st.id} is not waiting for a plan approval (${st.stopped ? `stopped at ${st.stopped.stage}` : st.next ? `next: ${st.next}` : 'finished'})`, 3);
  const plan = readJson(join(workdir, 'plan.json'), []);
  if (!plan || plan.status !== 'ready' || plan.openQuestions > 0) throw new CliError('the plan has open questions: they are answered first, an approval does not cover them', 3);
  const ticket = readJson(join(workdir, 'ticket.json'), []) || {};
  const round = Number(ticket.round) || 1;
  const flags = (plan.flags || []).length ? plan.flags.join(', ') : 'none';
  const line = `go-ahead: ${nowIso()} — round ${round} — ${flags}${by ? ` — from ${by}` : ''}`;
  writeDoc(workdir, 'answers.md', line, { append: true });
  const check = readJson(join(workdir, 'plan-check.json'), []);
  const override = !!check && check.verdict === 'revise' && !check.override;
  if (override) putArtifact(workdir, 'plan-check', { override: `${nowIso()} — the person accepted the open findings` }, { merge: true });
  log(workdir, 'plan', 'note', 'approved');
  return { line, round, flags: plan.flags || [], override, steps: plan.steps };
}
