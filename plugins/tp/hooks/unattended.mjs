// unattended — what a Bash command may not look like when nobody can approve it. In don't-ask mode (an unattended or scheduled run, a plugin eval) the
// runtime allows a command only when its first word matches an allow rule (`Bash(node <lib>/*)`, `Bash(git status*)` …) and answers every other one with
// a bare "permission denied" that says nothing about how to get through. Four shapes that no such rule can match are the usual cause, and each has a plain
// rewrite — so the hook names the shape and the rewrite instead, and the agent's next call goes through:
//   a variable assignment in front   `W=/x node …`, `W=/x; node $W/…`   → write the path out in full
//   a directory change               `cd api && git status`             → `git -C api status`, absolute paths
//   a shell filler in a chain        `node a.mjs; echo "exit=$?"`       → the command's own exit status is reported; read it from the result
//   (nothing else is judged: the project's own allowlist decides every other command)
import { programIndex, programOf } from './shell.mjs';

const FILLERS = new Set(['echo', 'printf', 'pwd', 'true', 'false', ':']);
const CHANGERS = new Set(['cd', 'pushd', 'popd']);
const text = (c) => c.words.join(' ').slice(0, 80);

/** Why a command line is certain to be refused with nobody to ask — a sentence naming the part and its rewrite — or null. */
export function unattendedReason(commands) {
  const top = commands.filter((c) => !c.nested);
  for (const c of top) {
    if (!c.words.length) continue;
    if (/^[A-Za-z_]\w*=/.test(c.words[0])) {
      return `refused: \`${text(c)}\` starts with a variable assignment, and nobody can approve a command here — the runtime only runs one whose first word matches an allow rule (\`node …\`, \`git …\`). Write the value out in full in each command, and send each command as its own call.`;
    }
    const p = programOf(c);
    if (p && CHANGERS.has(p.name)) {
      return `refused: \`${text(c)}\` — \`${p.name}\` does not match an allow rule and nobody can approve it. Name the directory in the command instead: \`git -C <dir> …\`, \`node <absolute path>/…\`, absolute paths in arguments. Send each command as its own call.`;
    }
  }
  if (top.length > 1) {
    const filler = top.find((c) => { const p = programOf(c); return p && FILLERS.has(p.name); });
    if (filler) return `refused: \`${text(filler)}\` in a chain does not match an allow rule, and nobody can approve it. Drop it: each command's own result and exit status come back to you. Send commands as separate calls (several calls may go in one message).`;
  }
  return null;
}
