// subagent-stop — SubagentStop for the plugin's role agents. A role agent is not done until its contract holds: the output contract's two closing
// lines (reference/README.md § Definitions, Output contract) or the error form, and the one thing its job produces — a valid plan-check.json for the
// plan checker, diff-validation.md for the diff validator, the review's verdict line and trailer for the reviewer. A broken contract sends the agent
// back to finish, at most twice per agent: the gate reads files and runs nothing, and past the bound it lets the agent stop and records an error
// stop on the ticket, so a person is told instead of the loop going round for ever. The error form and a checkpoint hand-off are not "done": they owe
// no artifact, only the form they are in.
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS, formOf, outputProblem } from '../contracts.mjs';
import { log } from '../../lib/state/progress.mjs';
import { tpProject, workRoot } from '../shared.mjs';

export const MAX_BLOCKS = 2;
const REASON_MAX = 290;
export { CONTRACTS, outputProblem };

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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

const counterFile = (ctx, id) => join(workRoot(ctx), '_gates', `${String(id).replace(/[^\w.-]/g, '_')}.json`);

export default function subagentStop(payload, ctx) {
  const contract = CONTRACTS[payload.agent_type];
  if (!contract || !tpProject(ctx) || !payload.agent_id) return null;
  const message = String(payload.last_assistant_message || '');
  const spawn = spawnOf(payload.agent_transcript_path);
  const workdir = contract.workdir ? workdirIn(spawn.text, ctx) : null;

  // the error form says the job could not be done, and a checkpoint hand-off that it is not finished: neither owes the artifact yet, only its closing lines
  const form = formOf(message);
  const problems = [];
  const out = form === 'error' ? null : outputProblem(message);
  if (out) problems.push(out);
  if (form === 'done' && (!contract.workdir || workdir)) problems.push(...contract.problems(ctx, { message, workdir, since: spawn.at, prompt: spawn.text }).filter(Boolean));

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
