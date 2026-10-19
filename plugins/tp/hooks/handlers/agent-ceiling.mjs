// agent-ceiling — PreToolUse on Agent, two rules on every spawn the pipeline makes.
// 1. The person named the largest model this project may use (tiers.json, /tp:setup): a sub-agent asked for a bigger one runs on the ceiling instead,
//    the way model.mjs pick and the unattended workflow already clamp theirs. A spawn that names no model inherits its parent's and is left alone.
// 2. Only the session spawns in the background (reference/definitions.md § Definitions, Runtime notes): the runtime wakes it when the agent finishes. An agent
//    that spawns a checker, a reviewer or a validator in the background ends its turn without the result and is not reliably woken — its stage then
//    reports "done" with the check still running. A spawn made by a sub-agent (the payload carries `agent_id`) is run in the foreground instead.
import { ceilingStatus } from '../../lib/model.mjs';
import { tpProject, allow } from '../shared.mjs';

export default function agentCeiling(payload, ctx) {
  if (!['Agent', 'Task'].includes(payload.tool_name) || !tpProject(ctx)) return null;
  const input = payload.tool_input || {};
  const patch = {}; const why = [];
  const model = input.model;
  if (typeof model === 'string' && model) {
    const st = ceilingStatus({ claudeDir: ctx.claudeDir, session: model });
    if (st.ceiling && st.allowed && st.session?.within === false) { patch.model = st.ceiling; why.push(`${model} is above this project's model ceiling (${st.ceiling}); the agent runs on ${st.ceiling}`); }
  }
  if (payload.agent_id && input.run_in_background === true) { patch.run_in_background = false; why.push('an agent waits for the agents it spawns, so this one runs in the foreground — only the session spawns in the background'); }
  if (!why.length) return null;
  return allow(`tp: ${why.join('; ')}`, { updatedInput: { ...input, ...patch } });
}
