// off-skill — refuses a typed `/tp:<skill>` when this project turned that skill off (`<.claude>/pipeline.json`, set by /tp:setup). The deny rule
// /tp:setup also writes stops the model from invoking an off skill; it does not stop the person from typing one, so this hook does. Event:
// UserPromptExpansion, matcher `^tp:`. `setup` is never off, an unknown name is the runtime's to report, and a project with no pipeline.json has
// every skill on — so the hook is silent everywhere the pipeline is not configured.
import { readPipeline, slash } from '../../lib/setup.mjs';

export default function offSkill(payload, ctx) {
  if (payload.expansion_type && payload.expansion_type !== 'slash_command') return null;
  const m = /^tp:(.+)$/.exec(String(payload.command_name || ''));
  if (!m) return null;
  const pipeline = readPipeline(ctx.claudeDir);
  if (!pipeline || pipeline.skills[m[1]] !== false) return null;
  return { decision: 'block', reason: `${slash(m[1])} is off in this project (.claude/pipeline.json). /tp:setup turns it back on.` };
}
