// bash — PreToolUse on Bash. Refuses what a pipeline run must never do (skip a repo's hooks, force-push, change a remote's URL, touch the
// shell's, ssh's or git's own configuration, write a work-directory file the state script owns) and waves through, without a permission
// prompt, a single call of the plugin's own scripts — so no allowlist rule has to name the plugin's versioned folder.
// The guard rails on a run (--no-verify … ) apply to a tool call made in a run: by a sub-agent, in a ticket's work directory, or while a
// run lock is live. A write to a file the state script owns is refused wherever it is made — the file's path says whose it is.
import { homedir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { parseShell, programOf, gitOf } from '../shell.mjs';
import { tpProject, inRun, legacyCopy, protectedReason, real, allow, deny } from '../shared.mjs';

const VERIFY_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'am', 'revert', 'pull']);
const READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope']);
const SENSITIVE = ['.ssh', '.netrc', '.npmrc', '.aws', '.gitconfig', '.config/git', '.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile'];

/** Why a git command is refused, or null. */
function gitReason(command) {
  const g = gitOf(command);
  if (!g) return null;
  if (VERIFY_SUBS.has(g.sub)) {
    if (g.args.includes('--no-verify')) return 'refused: --no-verify skips the repository\'s hooks, which are the gates. Fix what the hook reports, in the change (reference/README.md § Verification rules).';
    if (g.sub === 'commit' && g.args.some((a) => /^-[A-Za-z]*n[A-Za-z]*$/.test(a))) return 'refused: `git commit -n` is --no-verify. Fix what the hook reports, in the change (reference/README.md § Verification rules).';
  }
  if (g.sub === 'push' && g.args.some((a) => a === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(a) || (a.startsWith('+') && a.length > 1))) {
    return 'refused: a plain force-push can overwrite someone else\'s commits. After a rebase use --force-with-lease (skills/create-pr/instructions/sync.md).';
  }
  if (g.sub === 'remote' && g.args[0] === 'set-url') return 'refused: a run does not change a remote\'s URL — the remotes are pinned (to SSH) on purpose. Ask the person.';
  if (g.sub === 'config' && !g.args.some((a) => READ_FLAGS.has(a))) {
    if (g.args.some((a) => /^remote\..+\.(push)?url$/i.test(a) || /^url\..+\.insteadof$/i.test(a))) return 'refused: a run does not change a remote\'s URL — the remotes are pinned (to SSH) on purpose. Ask the person.';
    if (g.args.some((a) => a === '--global' || a === '--system')) return 'refused: a run does not change git\'s own configuration. Ask the person.';
  }
  return null;
}

/** The files a command writes: redirections, tee, cp/mv's destination, sed -i, dd of=. */
function writeTargets(command) {
  const out = command.redirects.filter((r) => ['>', '>>', '>|', '&>', '&>>'].includes(r.op)).map((r) => r.target);
  const p = programOf(command);
  if (!p) return out;
  const files = p.args.filter((a) => !a.startsWith('-'));
  if (p.name === 'tee' || p.name === 'truncate') out.push(...files);
  else if ((p.name === 'cp' || p.name === 'mv' || p.name === 'install') && files.length >= 2) out.push(files[files.length - 1]);
  else if ((p.name === 'sed' || p.name === 'perl') && p.args.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place')) out.push(...files);
  else if (p.name === 'dd') out.push(...p.args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  return out;
}

/** A write under the user's own shell, ssh, git or cloud configuration. */
function sensitive(target) {
  const home = real(homedir());
  const abs = target.startsWith('~/') ? join(home, target.slice(2)) : target.startsWith('/') ? target : null;
  if (!abs) return false;
  const path = abs.startsWith(real(homedir()) + sep) ? abs : abs.replace(homedir(), home);
  return SENSITIVE.some((s) => path === join(home, s) || path.startsWith(join(home, s) + sep));
}

/** A call of one of the plugin's own scripts and nothing else: `node <plugin>/lib|office|hooks/<script>` with its arguments — no second command, no substitution. */
function pluginScript(commands, ctx) {
  if (commands.length !== 1) return false;
  const [c] = commands;
  if (c.opaque) return false;
  // `node <script> …` and nothing in front of it (an env assignment or a wrapper could change what runs) or between (a node option could load other code)
  if (c.words[0].split('/').pop() !== 'node') return false;
  const script = c.words[1];
  if (!script || script.startsWith('-') || !/\.(mjs|js)$/.test(script) || /\$/.test(script)) return false;
  const root = real(ctx.pluginRoot);
  const abs = real(resolve(script));
  if (!['lib', 'office', 'hooks'].some((d) => abs.startsWith(join(root, d) + sep))) return false;
  return c.redirects.every((r) => r.heredoc || (['>', '>>'].includes(r.op) && r.target === '/dev/null'));
}

export default function bash(payload, ctx) {
  if (payload.tool_name !== 'Bash' || typeof payload.tool_input?.command !== 'string') return null;
  if (!tpProject(ctx)) return null;
  const commands = parseShell(payload.tool_input.command);
  let memo; const running = () => (memo ??= inRun(payload, ctx)); // looks at the run locks: only when a command needs to know
  const guardFiles = !legacyCopy(ctx);

  for (const c of commands) {
    if (gitOf(c)) {
      const why = gitReason(c);
      if (why && running()) return deny(why);
    }
    for (const target of writeTargets(c)) {
      if (sensitive(target) && running()) return deny(`refused: a run does not write ${target} — shell, ssh, git and cloud configuration are the person's. Ask the person.`);
      const why = guardFiles ? protectedReason(target, payload, ctx) : null;
      if (why) return deny(why);
    }
  }
  if (pluginScript(commands, ctx)) return allow('tp: a call of the plugin\'s own script');
  return null;
}
