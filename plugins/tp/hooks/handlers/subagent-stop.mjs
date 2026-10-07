// subagent-stop — SubagentStop for the plugin's role agents. A role agent is not done until its contract holds: the output contract's two closing
// lines (reference/README.md § Definitions, Output contract) or the error form, and the one thing its job produces — a valid plan-check.json for the
// plan checker, diff-validation.md for the diff validator, the review's verdict line and trailer for the reviewer. A broken contract sends the agent
// back to finish, at most twice per agent: the gate reads files and runs nothing, and past the bound it lets the agent stop and records an error
// stop on the ticket, so a person is told instead of the loop going round for ever.
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkArtifact } from '../../lib/contract/registry.mjs';
import { log } from '../../lib/state/progress.mjs';
import { tpProject, workRoot } from '../shared.mjs';

export const MAX_BLOCKS = 2;
const REASON_MAX = 290;

/** What each role must leave behind. `file` is read against the work directory the spawn prompt names. */
export const CONTRACTS = {
  'tp:plan-checker': { stage: 'plan-check', file: 'plan-check.json', artifact: 'plan-check', how: 'write it with `state.mjs put <workdir> plan-check …`' },
  'tp:diff-validator': { stage: 'create-pr', file: 'diff-validation.md', how: 'write the per-file table to <workdir>/diff-validation.md' },
  'tp:reviewer': { review: true, how: 'end with the review: the **Verdict:** line and the `Reviewed:` trailer' },
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

/** Does the reply close the way the output contract says — or is it the error form, or a checkpoint hand-off? Returns the problem or null. */
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

/** The reviewer's reply must carry the verdict and the trailer the merge loop reads its history from — unless it hands off at a checkpoint. */
function reviewProblem(message) {
  if (/^continue:\s*(?!no\b)\S/im.test(lines(message).slice(-1)[0] || '') || /^error:/i.test(lines(message)[0] || '')) return null;
  if (!/\*\*Verdict:\*\*\s*(PASS WITH WARNINGS|PASS|BLOCK)\b/.test(message)) return 'the review has no `**Verdict:** PASS | PASS WITH WARNINGS | BLOCK` line';
  if (!/Reviewed: \S+ · round \d+ · open: .+ · new: .+/.test(message)) return 'the review has no `Reviewed: <sha> · round <n> · open: … · new: …` trailer';
  return null;
}

/** The first line of the agent's transcript: its spawn prompt as text, and when it started. Reads a few kilobytes, never the whole file. */
export function spawnOf(transcriptPath) {
  try {
    const fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const first = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]);
    const c = first.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text || '').join('\n') : '';
    return { text, at: Date.parse(first.timestamp) || 0 };
  } catch { return { text: '', at: 0 }; }
}

/** The one work directory the spawn prompt names, or null when it names none or several. */
export function workdirIn(prompt, ctx) {
  const found = new Set();
  for (const m of prompt.matchAll(/(\/[^\s'"`<>()[\]{},;:]*\/work\/[^\s/'"`<>()[\]{},;:]+)/g)) {
    const dir = m[1].replace(/[.]+$/, '');
    if (!dir.includes('/work/_') && (existsSync(join(dir, 'progress.md')) || existsSync(join(dir, 'ticket.json')))) found.add(dir);
  }
  const inProject = [...found].filter((d) => d.startsWith(join(ctx.claudeDir, 'work') + '/'));
  const pick = inProject.length ? inProject : [...found];
  return pick.length === 1 ? pick[0] : null;
}

/** The problem with the file a role must leave behind, or null. */
function fileProblem(contract, workdir, since) {
  const file = join(workdir, contract.file);
  if (!existsSync(file)) return `${contract.file} is not in the work directory`;
  if (since && statSync(file).mtimeMs < since - 2000) return `${contract.file} is the one from before you started — this pass has not written it`;
  if (contract.artifact) {
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return `${contract.file} is not valid JSON`; }
    const r = checkArtifact(contract.artifact, doc, { mode: 'write' });
    if (!r.ok) return `${contract.file} does not match its schema: ${r.errors.slice(0, 2).join('; ')}`;
  } else if (!statSync(file).size) return `${contract.file} is empty`;
  return null;
}

const counterFile = (ctx, id) => join(workRoot(ctx), '_gates', `${String(id).replace(/[^\w.-]/g, '_')}.json`);

export default function subagentStop(payload, ctx) {
  const contract = CONTRACTS[payload.agent_type];
  if (!contract || !tpProject(ctx) || !payload.agent_id) return null;
  const message = String(payload.last_assistant_message || '');
  const spawn = spawnOf(payload.agent_transcript_path);
  const workdir = contract.file ? workdirIn(spawn.text, ctx) : null;

  const problems = [];
  const out = outputProblem(message);
  if (out) problems.push(out);
  if (contract.review) { const r = reviewProblem(message); if (r) problems.push(r); }
  if (contract.file && workdir) { const f = fileProblem(contract, workdir, spawn.at); if (f) problems.push(f); }

  const counter = counterFile(ctx, payload.agent_id);
  if (!problems.length) { try { unlinkSync(counter); } catch { /* none to clear */ } return null; }

  let blocks = 0;
  try { blocks = JSON.parse(readFileSync(counter, 'utf8')).blocks || 0; } catch { /* the first time */ }
  if (blocks < MAX_BLOCKS) {
    mkdirSync(join(workRoot(ctx), '_gates'), { recursive: true });
    writeFileSync(counter, JSON.stringify({ agent: payload.agent_type, blocks: blocks + 1 }));
    return { decision: 'block', reason: clip(`tp: before you stop — ${problems.join('; ')}. ${contract.how[0].toUpperCase()}${contract.how.slice(1)}, then finish.`, REASON_MAX) };
  }
  // past the bound: let it stop, and say so where a person looks
  try { unlinkSync(counter); } catch { /* already gone */ }
  if (workdir && contract.stage) {
    try { log(workdir, contract.stage, 'stopped', `error: contract violation — the ${payload.agent_type.replace('tp:', '')} stopped without: ${problems.join('; ')}`, ''); } catch { /* a ticket in no state to log to */ }
  }
  return null;
}
