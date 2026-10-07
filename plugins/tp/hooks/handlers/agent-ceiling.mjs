// agent-ceiling — PreToolUse on Agent. The person named the largest model this project may use (tiers.json, /tp:setup): a sub-agent asked for
// a bigger one runs on the ceiling instead, the way model.mjs pick and the unattended workflow already clamp theirs. A spawn that names no model
// inherits its parent's and is left alone.
import { ceilingStatus } from '../../lib/model.mjs';
import { tpProject, allow } from '../shared.mjs';

export default function agentCeiling(payload, ctx) {
  if (!['Agent', 'Task'].includes(payload.tool_name)) return null;
  const model = payload.tool_input?.model;
  if (typeof model !== 'string' || !model || !tpProject(ctx)) return null;
  const st = ceilingStatus({ claudeDir: ctx.claudeDir, session: model });
  if (!st.ceiling || !st.allowed || st.session?.within !== false) return null;
  return allow(`tp: ${model} is above this project's model ceiling (${st.ceiling}); the agent runs on ${st.ceiling}`, { updatedInput: { ...payload.tool_input, model: st.ceiling } });
}
