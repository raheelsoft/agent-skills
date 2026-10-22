// model-switch — PreModelSwitch. Switching the session to a model above the project's ceiling asks the person first; while a run holds a lock it
// is refused (a run's agents are rated against the model the session started on). Claude Code cannot cap a session; this is where it can ask.
import { ceilingStatus } from '../../lib/model.mjs';
import { liveLocks } from '../../lib/state/lock.mjs';
import { tpProject, workRoot } from '../shared.mjs';

export default function modelSwitch(payload, ctx) {
  const to = payload.to_model || payload.requested_model;
  if (typeof to !== 'string' || !to || !tpProject(ctx)) return null;
  const st = ceilingStatus({ claudeDir: ctx.claudeDir, session: to });
  if (!st.allowed || st.session?.within !== false) return null;
  const live = liveLocks(workRoot(ctx));
  const reason = `${to} is above this project's model ceiling (${st.ceiling}; ${st.allowed.join(', ')} are allowed)`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreModelSwitch',
      permissionDecision: live.length ? 'deny' : 'ask',
      permissionDecisionReason: live.length ? `${reason}, and a run is live (${live.map((l) => l.id).join(', ')})` : reason,
    },
  };
}
