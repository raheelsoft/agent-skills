// install.mjs — what the git hooks should run, from the plan and the project's own commands, and writing them (Husky-style, LF endings, never over a hook this script did not write).
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOOK_NAMES, MARKER, config, git, isDir, isFile, isOurs } from './common.mjs';
import { runnersOf, text } from './runners.mjs';
import { gatesOf } from './gates.mjs';
import { detect, stagedRunner } from './detect.mjs';

export function planHooks(input) {
  const cfg = config(input?.claudeDir);
  const repo = resolve(String(input?.repo || ''));
  const resolved = gatesOf(repo, input?.claudeDir);
  const d = detect({ repo });
  const staged = d.stagedRunner;
  const stagedCmd = staged === 'lint-staged' ? `${(runnersOf(repo).find((r) => r.exec) || {}).exec || 'npx'} lint-staged` : staged === 'pre-commit' ? 'pre-commit run' : staged === 'lefthook' ? 'lefthook run pre-commit' : null;
  const hooks = {}; const missing = []; const gates = {}; const warnings = [];
  for (const [hook, list] of Object.entries(cfg.plan)) {
    const cmds = [];
    for (const gate of list) {
      const found = resolved.gates[gate];
      if (!found) { if (!missing.includes(gate)) missing.push(gate); continue; }
      let cmd = found.cmd;
      // a command that rewrites files is wrong in a commit hook: prefer its check-only form, or the staged runner
      if (hook === 'pre-commit' && found.rewrites) {
        if (staged && stagedCmd && (gate === 'lint' || gate === 'format')) cmd = stagedCmd;
        else if (found.check) cmd = found.check;
        else warnings.push(`${found.cmd} rewrites files and has no check-only form — in a pre-commit hook its changes are not staged: use a staged-files runner (lint-staged, pre-commit, lefthook) for ${gate}, or move it to pre-push`);
      }
      if (cmds.some((c) => c.cmd === cmd)) continue;
      cmds.push({ cmd, gate, scope: cmd === stagedCmd ? 'staged' : found.scope, runner: found.runner, source: found.source });
      gates[gate] = { hook, command: cmd, scope: cmd === stagedCmd ? 'staged' : found.scope, source: found.source };
    }
    if (cmds.length) hooks[hook] = cmds;
  }
  return { repo, runners: resolved.runners, stagedRunner: staged, plan: cfg.plan, hooks, gates, missing, warnings };
}

// POSIX sh, LF endings, one command per line: what git runs on Linux, macOS and Windows (git for Windows ships sh).
// Every line ends in `|| exit 1`, and not because `set -e` would do: POSIX ignores -e for a failing command that is not
// the LAST of an AND-OR list, so a script's own `a && b` would swallow a's failure and let the commit through.
export function body(hook, cmds) {
  return `#!/bin/sh\n${MARKER}\n# ${hook}: the project's own gate commands, so a broken commit never reaches the pipeline or the PR.\n` +
    `# A failure here stops the commit or the push — never bypass it with --no-verify.\nset -e\n` +
    cmds.map((c) => `{ ${c.cmd}; } || exit 1${c.gate ? ` # ${c.gate}` : ''}`).join('\n') + '\n';
}

export function install(input) {
  const p = planHooks(input);
  if (p.warnings.length && !input?.force && !input?.dry) return { repo: p.repo, written: [], skipped: p.warnings.map((w) => ({ hook: 'pre-commit', why: w })), removed: [], missing: p.missing, gates: p.gates, warnings: p.warnings, hooksPath: null, note: 'nothing written: fix the warning (lint-staged, or move the gate to pre-push) or pass force' };
  const repo = p.repo;
  if (!isDir(join(repo, '.git')) && !isFile(join(repo, '.git'))) throw new Error(`${repo} is not a git checkout`);
  const dir = join(repo, '.husky');
  const written = []; const skipped = []; const removed = []; const bodies = {};
  // a hook we wrote that the plan dropped (a gate moved to CI, a command that no longer exists) goes with it
  for (const hook of HOOK_NAMES) {
    if (p.hooks[hook]) continue;
    const file = join(dir, hook);
    if (!isFile(file) || !isOurs(readFileSync(file, 'utf8'))) continue;
    removed.push({ hook, file, why: 'the plan no longer includes this hook' });
    if (!input?.dry) rmSync(file, { force: true });
  }
  for (const [hook, cmds] of Object.entries(p.hooks)) {
    const file = join(dir, hook);
    const text = body(hook, cmds);
    bodies[hook] = text;
    if (isFile(file) && !isOurs(readFileSync(file, 'utf8')) && !input?.force) { skipped.push({ hook, file, why: 'the project already has this hook — read it, then pass force to replace it' }); continue; }
    if (input?.dry) { written.push({ hook, file, dry: true }); continue; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, { encoding: 'utf8' }); // LF only: a CRLF sh script does not run, on any OS
    try { chmodSync(file, 0o755); } catch { /* a filesystem without an exec bit (Windows): git runs the hook anyway */ }
    written.push({ hook, file });
  }
  // make git use them when nothing else does: husky's own wrapper (.husky/_) and any configured path are left alone
  const current = git(repo, ['config', '--get', 'core.hooksPath']);
  let hooksPath = current;
  const notes = [];
  if (isDir(join(dir, '_'))) {
    notes.push(`husky manages core.hooksPath (${current || '.husky/_'}) — the files above are the scripts it runs`);
  } else if (!current) {
    if (!input?.dry) git(repo, ['config', 'core.hooksPath', '.husky']);
    hooksPath = '.husky';
    notes.push(`core.hooksPath ${input?.dry ? 'would be set' : 'set'} to .husky (per clone: a fresh clone needs it again — a "prepare": "husky" script, or husky installed, does it for everyone)`);
  } else {
    notes.push(`core.hooksPath is already ${current} — the files above only run if that path runs them`);
  }
  // a Windows clone must keep these files LF: git for Windows runs them through its own sh
  if (Object.keys(bodies).length || written.length) notes.push('keep them LF in a Windows clone (.gitattributes: ".husky/** text eol=lf")');
  return { repo, runners: p.runners, written, skipped, removed, missing: p.missing, gates: p.gates, warnings: p.warnings, hooksPath, note: notes.join('; '), ...(input?.dry ? { bodies } : {}) };
}
