// contracts.mjs — what each of the plugin's role agents owes before it may stop (handlers/subagent-stop.mjs applies it, at most twice per agent).
// Each contract is a function of the agent's reply, the work directory its spawn prompt names and when it started; it returns the problems, [] when it holds.
// A contract reads files and asks git for what is checked out — it never runs a gate, a build or a test.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, isAbsolute, join } from 'node:path';
import { checkArtifact } from '../lib/contract/registry.mjs';
import { recordAt } from '../lib/gates.mjs';

const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

/** The reply closes the way the output contract says (reference/definitions.md § Definitions) — or is the error form. */
export function outputProblem(message) {
  const all = lines(message);
  if (!all.length) return 'your reply is empty';
  if (/^error:/i.test(all[0])) return null;
  const [complexity, cont] = all.slice(-2);
  if (!/^complexity:\s*(as rated|higher\b)/i.test(complexity || '') || !/^continue:\s*\S/i.test(cont || '')) {
    return 'your reply must end with the two lines `complexity: as rated | higher — <reason>` and `continue: no | <checkpoint path>`';
  }
  return null;
}

/** How the reply ends: `error` (the error form — a failure it could not resolve), `checkpoint` (a hand-off: `continue: <path>`), or `done`. */
export function formOf(message) {
  const all = lines(message);
  if (/^error:/i.test(all[0] || '')) return 'error';
  return /^continue:\s*(?!no\b)\S/i.test(all.slice(-1)[0] || '') ? 'checkpoint' : 'done';
}

/** The problem with a file a role must leave in the work directory: missing, from before this agent started, not valid, empty. */
export function fileProblem(workdir, file, since, artifact) {
  const path = join(workdir, file);
  if (!existsSync(path)) return `${file} is not in the work directory`;
  if (since && statSync(path).mtimeMs < since - 2000) return `${file} is the one from before you started — this pass has not written it`;
  if (!artifact) return statSync(path).size ? null : `${file} is empty`;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { return `${file} is not valid JSON`; }
  const r = checkArtifact(artifact, doc, { mode: 'write' });
  return r.ok ? null : `${file} does not match its schema: ${r.errors.slice(0, 2).join('; ')}`;
}

function reviewProblem(message) {
  if (!/\*\*Verdict:\*\*\s*(PASS WITH WARNINGS|PASS|BLOCK)\b/.test(message)) return 'the review has no `**Verdict:** PASS | PASS WITH WARNINGS | BLOCK` line';
  if (!/Reviewed: \S+ · round \d+ · open: .+ · new: .+/.test(message)) return 'the review has no `Reviewed: <sha> · round <n> · open: … · new: …` trailer';
  return null;
}

const git = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : null; };
const green = (rec) => (rec.gates && typeof rec.gates === 'object' ? !Object.values(rec.gates).some((v) => /^fail/i.test(String(v))) : /pass/i.test(String(rec.verdict)) && !/fail/i.test(String(rec.verdict)));

/**
 * The implementer is done when implement[.repo].json says so and the change is in a state a PR can be made from: everything committed, and no
 * recorded gate result for this head says FAIL. A stop for the person (`stopped` set, or fewer steps done than planned) is a legitimate end.
 */
function implementProblems(ctx, { workdir, since, prompt }) {
  const repoArg = /\brepo=([\w.-]+)/.exec(prompt)?.[1] || null;
  const file = repoArg ? `implement.${repoArg}.json` : 'implement.json';
  const found = fileProblem(workdir, file, since, 'implement');
  if (found) return [found];
  const impl = JSON.parse(readFileSync(join(workdir, file), 'utf8'));
  if (impl.stopped || impl.done < impl.total) return [];
  let ticket = null;
  try { ticket = JSON.parse(readFileSync(join(workdir, 'ticket.json'), 'utf8')); } catch { /* no ticket.json: nothing to look at */ }
  const rows = (ticket?.repos || []).filter((r) => !r.discarded);
  const row = rows.find((r) => r.name === (repoArg || impl.repo)) || (rows.length === 1 ? rows[0] : null);
  const wt = row?.worktree;
  if (!wt || !isAbsolute(wt) || !existsSync(wt)) return [];
  const head = git(wt, ['rev-parse', 'HEAD']);
  if (!head) return [];
  const dirty = git(wt, ['status', '--porcelain']);
  if (dirty) return [`the worktree has uncommitted changes (${dirty.split('\n').slice(0, 3).map((l) => l.trim()).join(', ')}) — commit them, a PR is made from commits`];
  const rec = recordAt({ repo: row.path || wt, head, claudeDir: ctx.claudeDir });
  if (rec && !green(rec)) return [`the gate result recorded for ${head.slice(0, 7)} says FAIL — fix it in the change, run /tp:verify again`];
  const reported = impl.gates && typeof impl.gates === 'object' && !Array.isArray(impl.gates) ? Object.values(impl.gates) : [];
  if (!rec && !reported.length) return [`no gate result is recorded for ${head.slice(0, 7)} and ${file} lists no gates — run /tp:verify`];
  if (!rec && reported.some((v) => /^fail/i.test(String(v)))) return [`${file} reports a failing gate`];
  return [];
}

/** What each role owes. `workdir: true` roles need the spawn prompt to name the work directory; without it only the reply is checked. */
export const CONTRACTS = {
  'tp:plan-checker': { stage: 'plan-check', how: 'write it with `state.mjs put <workdir> plan-check …`', problems: (ctx, a) => [fileProblem(a.workdir, 'plan-check.json', a.since, 'plan-check')], workdir: true },
  'tp:diff-validator': { stage: 'create-pr', how: 'write the per-file table to <workdir>/diff-validation.md', problems: (ctx, a) => [fileProblem(a.workdir, 'diff-validation.md', a.since)], workdir: true },
  'tp:researcher': { how: 'write it with `state.mjs put <workdir> research …`', problems: (ctx, a) => [fileProblem(a.workdir, 'research.json', a.since, 'research')], workdir: true },
  'tp:reviewer': { how: 'end with the review: the **Verdict:** line and the `Reviewed:` trailer', problems: (ctx, a) => [reviewProblem(a.message)] },
  'tp:implementer': { stage: 'implement', how: 'record it with `state.mjs put <workdir> implement …`, commit, and run /tp:verify', problems: implementProblems, workdir: true },
};
