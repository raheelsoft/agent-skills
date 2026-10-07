// write — PreToolUse on Write, Edit and MultiEdit. A file in a ticket's work directory that a script owns (the stage JSON, progress.md,
// lock.json) is written through the state script, which checks it first; the same refusal as the Bash guard's, for the file tools. A role agent
// (roles.mjs) is also held to the one file its job writes.
import { tpProject, legacyCopy, protectedReason, deny } from '../shared.mjs';
import { ROLES, roleWriteReason } from '../roles.mjs';

export default function write(payload, ctx) {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(payload.tool_name)) return null;
  const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (typeof file !== 'string' || !tpProject(ctx)) return null;
  const role = ROLES[payload.agent_type]; // one of the plugin's role agents: held to what its job needs
  const why = (role && roleWriteReason(role, file, payload, ctx)) || (legacyCopy(ctx) ? null : protectedReason(file, payload, ctx));
  return why ? deny(why) : null;
}
