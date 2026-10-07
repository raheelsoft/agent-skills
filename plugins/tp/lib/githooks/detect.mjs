// detect.mjs — the hooks a repo already has: which gates they own, at which scope — lint-staged, the pre-commit framework, Husky-style files, a hooks path.
import { readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { HOOK_NAMES, config, git, isDir, isFile, isOurs, readJson } from './common.mjs';
import { gateOf, scopeOf } from './classify.mjs';
import { anyFile, runnersOf, text } from './runners.mjs';

export function lintStagedConfig(repo) {
  const pkg = readJson(join(repo, 'package.json'));
  if (pkg && pkg['lint-staged'] && typeof pkg['lint-staged'] === 'object') return pkg['lint-staged'];
  for (const n of ['.lintstagedrc', '.lintstagedrc.json', '.lintstagedrc.yaml', '.lintstagedrc.yml']) {
    const f = join(repo, n);
    if (!isFile(f)) continue;
    const j = readJson(f);
    if (j) return j;
  }
  for (const n of ['lint-staged.config.js', 'lint-staged.config.mjs', 'lint-staged.config.cjs', '.lintstagedrc.js']) if (isFile(join(repo, n))) return { '<config file>': ['(not read: a JS config — its commands are the project\'s)'] };
  return null;
}

/** The staged-files runners: whatever they run, they run it on the commit's files and re-stage what they rewrite. */

export function stagedRunner(repo, raw) {
  if (/\blint-staged\b/.test(raw)) return { name: 'lint-staged', entries: lintStagedConfig(repo) };
  if (/\bpre-commit run\b/.test(raw)) return { name: 'pre-commit', entries: preCommitConfig(repo) };
  if (/\blefthook\b/.test(raw)) return { name: 'lefthook', entries: null };
  return null;
}
/** The hook ids a Python-style .pre-commit-config.yaml runs (naive on purpose: the ids are what classify the gates). */

export function preCommitConfig(repo) {
  const f = join(repo, '.pre-commit-config.yaml');
  if (!isFile(f)) return null;
  const ids = [...text(f).matchAll(/^\s*-\s*id:\s*([\w.-]+)/gm)].map((m) => m[1]);
  return ids.length ? { '<staged files>': ids } : null;
}

/** Every command a hook line stands for: a runner's target resolved to its own command, a staged runner to its entries. */

export function expand(repo, line, targetsByRunner) {
  const raw = line.trim();
  const out = [];
  const staged = stagedRunner(repo, raw);
  if (staged) {
    if (staged.entries) for (const [glob, cmds] of Object.entries(staged.entries)) for (const c of [].concat(cmds)) out.push({ raw: String(c), gate: gateOf(c), scope: 'staged', via: `${staged.name} (${glob})` });
    else out.push({ raw, gate: null, scope: 'staged', via: `${staged.name} (no config read)` });
    return out;
  }
  // `<runner> <target>` where the project defines that target: classify by the target's own command
  for (const [runner, pair] of Object.entries(targetsByRunner)) {
    const m = new RegExp(`(?:^|\\s)${pair.run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+([\\w:.\\/-]+)`).exec(raw);
    if (m && pair.targets[m[1]]) {
      const cmd = pair.targets[m[1]];
      out.push({ raw: `${m[1]}: ${cmd}`, gate: gateOf(cmd, m[1]), scope: scopeOf(cmd, false), via: `${runner} target "${m[1]}"` });
      return out;
    }
  }
  const gate = gateOf(raw);
  if (gate) out.push({ raw, gate, scope: scopeOf(raw, false), via: 'the hook itself' });
  return out;
}

export function detect(input) {
  const repo = resolve(String(input?.repo || ''));
  if (!repo || !isDir(repo)) throw new Error('repo must be an existing checkout');
  const hooksPath = git(repo, ['config', '--get', 'core.hooksPath']) || null;
  const targetsByRunner = Object.fromEntries(runnersOf(repo).filter((r) => r.targets && r.run).map((r) => [r.name, { run: r.run, targets: r.targets(repo) || {} }]));
  const pkg = readJson(join(repo, 'package.json')) || {};
  const dev = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  const manager = isFile(join(repo, '.pre-commit-config.yaml')) ? 'pre-commit' : dev.husky ? 'husky'
    : dev['simple-git-hooks'] ? 'simple-git-hooks' : dev.lefthook || dev['@evilmartians/lefthook'] || anyFile(repo, ['lefthook.yml', 'lefthook.yaml']) ? 'lefthook'
    : isDir(join(repo, '.husky')) ? 'husky-style' : hooksPath ? 'hooksPath' : isDir(join(repo, '.git', 'hooks')) ? 'git' : 'none';
  // where a hook file may live: the configured path, .husky (its own files), then .git/hooks
  const dirs = [];
  if (hooksPath) dirs.push(join(repo, hooksPath.replace(/^\.\//, '')));
  if (isDir(join(repo, '.husky'))) dirs.push(join(repo, '.husky'));
  dirs.push(join(repo, '.git', 'hooks'));
  const hooks = [];
  for (const hook of HOOK_NAMES) {
    for (const d of dirs) {
      const f = join(d, hook);
      if (!isFile(f) || f.endsWith('.sample')) continue;
      if (basename(d) === '_' ) continue; // husky's own wrapper, not the project's script
      const body = readFileSync(f, 'utf8');
      const commands = body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).flatMap((l) => expand(repo, l, targetsByRunner));
      hooks.push({ hook, file: f, ours: isOurs(body), commands });
      break;
    }
  }
  const ls = lintStagedConfig(repo);
  return { repo, manager, hooksPath, hooks, lintStaged: ls ? Object.keys(ls) : null, runners: Object.keys(targetsByRunner), stagedRunner: manager === 'pre-commit' ? 'pre-commit' : ls ? 'lint-staged' : manager === 'lefthook' ? 'lefthook' : null };
}

/** Which gates the hooks own: a `repo`-scope command covers its gate; a `staged` one covers lint and format only. */

export function cover(input) {
  const cfg = config(input?.claudeDir);
  const d = detect(input);
  const covered = {};
  if (cfg.trust) {
    for (const h of d.hooks) for (const c of h.commands) {
      if (!c.gate || covered[c.gate]) continue;
      const fileScoped = c.gate === 'lint' || c.gate === 'format';
      if (c.scope === 'repo' || fileScoped) covered[c.gate] = { hook: h.hook, command: c.raw, scope: c.scope, via: c.via };
    }
  }
  return { repo: d.repo, trust: cfg.trust, manager: d.manager, hooks: d.hooks.map((h) => h.hook), covered, gates: Object.keys(covered) };
}

/** What install would write: the project's own commands (any ecosystem) for the gates tiers.json.hooks.plan names. */
