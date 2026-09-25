#!/usr/bin/env node
// hooks.mjs — the repo's own git hooks as gate owners (skills/README.md § Verification rules, Gates the hooks own).
// A gate a commit or a push hook already runs costs the pipeline nothing: the hook fails the commit, the agent reads the
// exit code, and no agent, no baseline and no second pass are needed for that gate. This script finds the hooks, says
// which gates they cover and at which scope, and writes Husky-style hooks from the project's own commands.
//
//   node hooks.mjs detect '{ repo }'        -> { manager, hooksPath, hooks: [{ hook, file, commands: [{ raw, gate, scope, via }] }], lintStaged }
//   node hooks.mjs cover '{ repo }'         -> { covered: { <gate>: { hook, command, scope } }, gates: [names], hooks: [..], trust }
//        scope "repo": the hook runs that gate over the whole project (a whole-program check is covered);
//        scope "staged": only over the commit's files (lint and format are covered — they are file-scoped by rule 8 —
//        a type check or a build is not).
//   node hooks.mjs gates '{ repo, claudeDir }'  -> the project's own command per gate, whatever its ecosystem:
//        { types|lint|format|tests|build: { cmd, runner, source, scope, rewrites, check? }, runners, missing }
//        Precedence: tiers.json.hooks.commands (any command, any language) -> a target the project itself defines (a
//        package script, a Makefile/justfile/Taskfile target, a composer/poetry script) -> the ecosystem's own command
//        for the toolchain that is actually configured (cargo, go, ruff/black/mypy/pytest, rubocop/rspec, gradle, mvn,
//        dotnet, mix, swift…) -> nothing, and the gate is `missing`. `/tp-verify` resolves its gate commands the same way.
//   node hooks.mjs plan '{ repo, claudeDir }'   -> what install would write: { hooks: { "pre-commit": [cmd…], "pre-push": [cmd…] }, gates, missing, warnings }
//        from tiers.json.hooks.plan (defaults below) and `gates` above; a gate the project defines no command for is
//        listed in `missing` and never invented. `warnings` names a pre-commit command that REWRITES files (eslint
//        --fix, prettier --write, black, gofmt -w) with no staged-files runner (lint-staged, the pre-commit framework,
//        lefthook): the commit would not contain what it rewrote — the warning names the check-only command instead.
//   node hooks.mjs install '{ repo, claudeDir, dry?, force? }' -> writes .husky/<hook> (+x), sets core.hooksPath when
//        nothing else manages it, and reports { written: [], skipped: [], removed: [], hooksPath, note }. A hook THIS
//        script wrote that the plan no longer includes is removed, so shrinking the plan leaves nothing stale behind;
//        a hook the project wrote is never touched. `dry` returns the file bodies.
//        It never overwrites a hook this script did not write unless `force` (the marker line below).
//
// tiers.json.hooks (defaults): { trust: true, plan: { "pre-commit": ["lint", "format"], "pre-push": ["types", "tests"] },
//                                commands: { "<gate>": "<the project's own command>" } }
//   trust: false -> `cover` reports nothing as covered (an audit run: every gate runs in the pipeline)
//   commands     -> the escape hatch for any toolchain this file does not know: it wins over every detection
// Any OS: the hooks are `#!/bin/sh` with LF endings, which is what git runs on Linux, macOS and Windows (git for
// Windows ships that shell); the exec bit is set where the filesystem has one and skipped where it does not.
// No dependencies.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync, rmSync, statSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATES = ['types', 'lint', 'format', 'tests', 'build'];
const DEFAULTS = { trust: true, plan: { 'pre-commit': ['lint', 'format'], 'pre-push': ['types', 'tests'] } };
const HOOK_NAMES = ['pre-commit', 'pre-push', 'commit-msg', 'pre-merge-commit'];
const MARKER = '# written by the ticket pipeline (skills/_lib/hooks.mjs) — edit freely; it is yours';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function config(claudeDir) {
  const t = claudeDir ? readJson(join(resolve(String(claudeDir)), 'tiers.json')) || {} : {};
  const h = t.hooks && typeof t.hooks === 'object' ? t.hooks : {};
  const plan = {};
  for (const hook of Object.keys(DEFAULTS.plan)) {
    const given = h.plan && Array.isArray(h.plan[hook]) ? h.plan[hook].filter((g) => GATES.includes(g)) : null;
    plan[hook] = given || DEFAULTS.plan[hook];
  }
  if (h.plan && typeof h.plan === 'object') for (const [hook, list] of Object.entries(h.plan)) if (!plan[hook] && HOOK_NAMES.includes(hook) && Array.isArray(list)) plan[hook] = list.filter((g) => GATES.includes(g));
  const commands = h.commands && typeof h.commands === 'object' ? Object.fromEntries(Object.entries(h.commands).filter(([g, c]) => GATES.includes(g) && typeof c === 'string' && c.trim())) : {};
  return { trust: h.trust !== false, plan, commands };
}

const git = (repo, args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || '').trim() : null; };

// ---- classifying a command into a gate ----
// the tool decides the gate; the package script's name is only a hint when no tool is recognised
const TOOLS = [
  [/\b(tsc|vue-tsc|svelte-check|mypy|pyright|pyre|flow check|cargo check|go vet|dialyzer|swift-format)\b/, 'types'],
  [/\b(eslint|biome (check|lint)|oxlint|ruff check|flake8|pylint|golangci-lint|staticcheck|clippy|rubocop|standard|phpstan|psalm|credo|detekt|ktlint|swiftlint)\b/, 'lint'],
  [/\b(prettier|biome format|ruff format|black|isort|gofmt|goimports|rustfmt|cargo fmt|mix format|dotnet format|php-cs-fixer|ktfmt|spotless)\b/, 'format'],
  [/\b(jest|vitest|mocha|ava|playwright test|cypress run|pytest|unittest|go test|cargo test|rspec|minitest|phpunit|pest|mix test|dotnet test|swift test|gradlew? (test|check)|mvn (test|verify)|node --test)\b/, 'tests'],
  [/\b(next build|nest build|tsup|vite build|rollup|webpack|esbuild|cargo build|go build|mix compile|dotnet build|swift build|gradlew? (assemble|build)|mvn (package|install))\b/, 'build'],
];
const NAMES = [[/^(typecheck|type-check|types|tsc)$/, 'types'], [/^lint(:.*)?$/, 'lint'], [/^(format|fmt|prettier)(:.*)?$/, 'format'], [/^test(s)?(:.*)?$/, 'tests'], [/^build(:.*)?$/, 'build']];

function gateOf(raw, scriptName = null) {
  const s = String(raw);
  for (const [re, gate] of TOOLS) if (re.test(s)) return gate;
  if (scriptName) for (const [re, gate] of NAMES) if (re.test(scriptName)) return gate;
  const run = /\b(?:npm run|pnpm run|yarn run|yarn|pnpm|bun run|make)\s+([\w:-]+)/.exec(s);
  if (run) for (const [re, gate] of NAMES) if (re.test(run[1])) return gate;
  return null;
}
// a command that names files (or is driven by lint-staged) only covers those files
function scopeOf(raw, viaLintStaged) {
  if (viaLintStaged) return 'staged';
  return /(\$\{?[@1*]|"\$@"|--staged\b|\bgit diff --name-only\b)/.test(String(raw)) ? 'staged' : 'repo';
}

// ---- the runners: how a project states its own commands, per ecosystem ----
// Each entry: the files that mark it, how to run one of its targets, the targets it defines (when they can be read),
// and the ecosystem's own command per gate for the tools the repo actually configures. Adding an ecosystem is one entry.
const text = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const anyFile = (repo, names) => names.find((n) => isFile(join(repo, n))) || null;
const globFile = (repo, re) => { try { return readdirSync(repo).find((n) => re.test(n)) || null; } catch { return null; } };

function pkgScripts(repo) {
  const pkg = readJson(join(repo, 'package.json'));
  return pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
}
// `target: command` pairs from a Makefile / justfile: the recipe's first line is enough to classify it
function makeTargets(file) {
  const out = {};
  const lines = text(file).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_.\/-]+)\s*:(?!=)\s*(.*)$/.exec(lines[i]);
    if (!m || /^\./.test(m[1])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && /^(\t| {4})/.test(lines[j]); j++) body.push(lines[j].trim());
    out[m[1]] = body.join(' && ') || m[1];
  }
  return out;
}
function justTargets(file) {
  const out = {};
  const lines = text(file).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-zA-Z0-9_-]+)\s*(?:[\w ]*)?:\s*$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && /^(\t| {2,})\S/.test(lines[j]); j++) body.push(lines[j].trim());
    out[m[1]] = body.join(' && ') || m[1];
  }
  return out;
}
function taskTargets(file) {
  const out = {};
  const lines = text(file).split(/\r?\n/);
  let inTasks = false;
  for (const l of lines) {
    if (/^tasks:\s*$/.test(l)) { inTasks = true; continue; }
    if (inTasks && /^\S/.test(l)) break;
    const m = inTasks && /^ {2}([a-zA-Z0-9_:-]+):\s*$/.exec(l);
    if (m) out[m[1]] = m[1];
  }
  return out;
}
function composerScripts(repo) {
  const j = readJson(join(repo, 'composer.json'));
  return j && j.scripts && typeof j.scripts === 'object' ? Object.fromEntries(Object.entries(j.scripts).map(([k, v]) => [k, [].concat(v).join(' && ')])) : {};
}
function pythonDefaults(repo) {
  const conf = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt', 'requirements-dev.txt', 'Pipfile', '.pre-commit-config.yaml'].map((n) => text(join(repo, n))).join('\n');
  const uses = (t) => new RegExp(`\\b${t}\\b`, 'i').test(conf);
  const run = isFile(join(repo, 'poetry.lock')) ? 'poetry run ' : isFile(join(repo, 'uv.lock')) ? 'uv run ' : '';
  const d = {};
  if (uses('ruff')) { d.lint = `${run}ruff check .`; d.format = `${run}ruff format --check .`; }
  else if (uses('flake8')) d.lint = `${run}flake8`;
  else if (uses('pylint')) d.lint = `${run}pylint .`;
  if (!d.format && uses('black')) d.format = `${run}black --check .`;
  if (uses('mypy')) d.types = `${run}mypy .`;
  else if (uses('pyright')) d.types = `${run}pyright`;
  if (uses('pytest')) d.tests = `${run}pytest -q`;
  return d;
}
const gradleCmd = (repo) => (isFile(join(repo, 'gradlew')) ? './gradlew' : 'gradle');

// a lockfile git does not track is a stray file from another tool, not the project's package manager
const tracked = (repo, file) => isFile(join(repo, file)) && git(repo, ['ls-files', '--error-unmatch', file]) !== null;
const lock = (repo, files) => files.some((f) => tracked(repo, f)) || (files.some((f) => isFile(join(repo, f))) && !['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json', 'npm-shrinkwrap.json'].some((o) => !files.includes(o) && tracked(repo, o)));

const RUNNERS = [
  { name: 'pnpm', when: (r) => lock(r, ['pnpm-lock.yaml']), run: 'pnpm run', exec: 'pnpm exec', targets: pkgScripts },
  { name: 'yarn', when: (r) => lock(r, ['yarn.lock']), run: 'yarn', exec: 'yarn', targets: pkgScripts },
  { name: 'bun', when: (r) => lock(r, ['bun.lockb', 'bun.lock']), run: 'bun run', exec: 'bunx', targets: pkgScripts },
  { name: 'npm', when: (r) => isFile(join(r, 'package.json')), run: 'npm run', exec: 'npx', targets: pkgScripts },
  { name: 'make', when: (r) => !!anyFile(r, ['Makefile', 'makefile', 'GNUmakefile']), run: 'make', targets: (r) => makeTargets(join(r, anyFile(r, ['Makefile', 'makefile', 'GNUmakefile']))) },
  { name: 'just', when: (r) => !!anyFile(r, ['justfile', 'Justfile', '.justfile']), run: 'just', targets: (r) => justTargets(join(r, anyFile(r, ['justfile', 'Justfile', '.justfile']))) },
  { name: 'task', when: (r) => !!anyFile(r, ['Taskfile.yml', 'Taskfile.yaml']), run: 'task', targets: (r) => taskTargets(join(r, anyFile(r, ['Taskfile.yml', 'Taskfile.yaml']))) },
  { name: 'composer', when: (r) => isFile(join(r, 'composer.json')), run: 'composer run', targets: composerScripts,
    defaults: (r) => ({ ...(text(join(r, 'composer.json')).includes('phpstan') ? { lint: 'vendor/bin/phpstan analyse' } : {}), ...(text(join(r, 'composer.json')).includes('phpunit') ? { tests: 'vendor/bin/phpunit' } : {}) }) },
  { name: 'cargo', when: (r) => isFile(join(r, 'Cargo.toml')), defaults: () => ({ format: 'cargo fmt --check', lint: 'cargo clippy --all-targets -- -D warnings', types: 'cargo check --all-targets', tests: 'cargo test', build: 'cargo build' }) },
  { name: 'go', when: (r) => isFile(join(r, 'go.mod')), defaults: (r) => ({ format: 'gofmt -l .', lint: isFile(join(r, '.golangci.yml')) || isFile(join(r, '.golangci.yaml')) ? 'golangci-lint run' : 'go vet ./...', types: 'go build ./...', tests: 'go test ./...', build: 'go build ./...' }) },
  { name: 'python', when: (r) => !!anyFile(r, ['pyproject.toml', 'setup.cfg', 'setup.py', 'requirements.txt', 'Pipfile', 'tox.ini']), defaults: pythonDefaults },
  { name: 'bundler', when: (r) => isFile(join(r, 'Gemfile')), defaults: (r) => ({ ...(text(join(r, 'Gemfile')).includes('rubocop') ? { lint: 'bundle exec rubocop' } : {}), ...(text(join(r, 'Gemfile')).includes('rspec') ? { tests: 'bundle exec rspec' } : text(join(r, 'Gemfile')).includes('minitest') ? { tests: 'bundle exec rake test' } : {}) }) },
  { name: 'gradle', when: (r) => !!anyFile(r, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']), defaults: (r) => ({ lint: `${gradleCmd(r)} check -x test`, tests: `${gradleCmd(r)} test`, build: `${gradleCmd(r)} assemble` }) },
  { name: 'maven', when: (r) => isFile(join(r, 'pom.xml')), defaults: () => ({ tests: 'mvn -q test', build: 'mvn -q -DskipTests package' }) },
  { name: 'dotnet', when: (r) => !!globFile(r, /\.(sln|csproj|fsproj)$/), defaults: () => ({ format: 'dotnet format --verify-no-changes', tests: 'dotnet test', build: 'dotnet build' }) },
  { name: 'mix', when: (r) => isFile(join(r, 'mix.exs')), defaults: (r) => ({ format: 'mix format --check-formatted', ...(text(join(r, 'mix.exs')).includes('credo') ? { lint: 'mix credo' } : {}), tests: 'mix test', build: 'mix compile --warnings-as-errors' }) },
  { name: 'swift', when: (r) => isFile(join(r, 'Package.swift')), defaults: () => ({ tests: 'swift test', build: 'swift build' }) },
];

/** The runners this repo uses, most specific first (a lockfile beats package.json, a task runner stands beside them). */
export function runnersOf(repo) {
  const found = [];
  for (const r of RUNNERS) {
    if (!r.when(repo)) continue;
    // one JS package manager only: the lockfile decides
    if (['pnpm', 'yarn', 'bun', 'npm'].includes(r.name) && found.some((f) => ['pnpm', 'yarn', 'bun', 'npm'].includes(f.name))) continue;
    found.push(r);
  }
  return found;
}

// a command that rewrites files, and the check-only form to use in a pre-commit hook instead
const REWRITES = /(--fix\b|--write\b|--in-place\b|-w\b|\bgofmt -w|\bblack (?!--check)|\bisort (?!--check)|\brubocop -a|\bmix format(?! --check)|\bcargo fmt(?! --check| -- --check)|\bdotnet format(?! --verify)|\bruff format(?! --check)|\bprettier (?!--check)[^|]*--write)/;
const CHECK_FORM = [
  [/\s--fix\b/, ''], [/\s--write\b/, ' --check'], [/\bgofmt -w/, 'gofmt -l'], [/\bblack\b(?! --check)/, 'black --check'],
  [/\bisort\b(?! --check)/, 'isort --check-only'], [/\brubocop -a\b/, 'rubocop'], [/\bmix format\b(?! --check)/, 'mix format --check-formatted'],
  [/\bcargo fmt\b(?! --check)/, 'cargo fmt --check'], [/\bdotnet format\b(?! --verify)/, 'dotnet format --verify-no-changes'],
  [/\bruff format\b(?! --check)/, 'ruff format --check'],
];
const checkForm = (cmd) => { let out = String(cmd); for (const [re, to] of CHECK_FORM) if (re.test(out)) out = out.replace(re, to); return out === String(cmd) ? null : out; };
// tools the shell already has; anything else bare in a JS project lives in node_modules/.bin and needs the runner's exec
const GLOBALS = new Set(['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'sh', 'bash', 'env', 'git', 'make', 'just', 'task',
  'cargo', 'go', 'gofmt', 'goimports', 'python', 'python3', 'pip', 'poetry', 'uv', 'tox', 'nox', 'mix', 'dotnet', 'mvn', 'gradle', './gradlew',
  'swift', 'bundle', 'rake', 'composer', 'php', 'ruby', 'docker', 'echo', 'test', 'cd']);
/** A command taken out of a package script runs through the project's exec, or its binaries are not on PATH. */
function execify(cmd, exec) {
  if (!exec) return cmd;
  return String(cmd).split(/(\s*(?:&&|\|\||;)\s*)/).map((part) => {
    if (/^\s*(?:&&|\|\||;)\s*$/.test(part) || !part.trim()) return part;
    const first = part.trim().split(/\s+/)[0];
    if (GLOBALS.has(first) || first.includes('/') || first.startsWith('$')) return part;
    return part.replace(first, `${exec} ${first}`);
  }).join('');
}

/** The project's own command per gate, whatever the ecosystem (the header's precedence). */
export function gatesOf(repo, claudeDir) {
  const cfg = config(claudeDir);
  const runners = runnersOf(repo);
  const out = {};
  const put = (gate, cmd, runner, source, extra = {}) => {
    if (out[gate] || !cmd) return;
    const raw = String(cmd);
    // what actually runs decides: a `npm run lint` that wraps `eslint --fix` rewrites files, and its check-only form is
    // the tool's own command (a flag cannot be passed through the runner)
    const actual = String(extra.body || raw);
    const check = checkForm(actual);
    out[gate] = { cmd: raw, runner, source, scope: scopeOf(actual, false), rewrites: REWRITES.test(actual),
      // a check form lifted out of a target runs through that runner's exec (npx, pnpm exec…), or its tools are not on PATH
      check: check ? execify(check, extra.body ? extra.exec : null) : null, ...extra };
  };
  // 1. what the project stated for this install
  for (const [gate, cmd] of Object.entries(cfg.commands)) if (GATES.includes(gate)) put(gate, cmd, 'tiers.json', 'tiers.json hooks.commands');
  // 2. a target the project itself defines (a script, a Make/just/Task target, a composer script)
  for (const r of runners) {
    if (!r.targets) continue;
    const targets = r.targets(repo) || {};
    for (const gate of GATES) {
      if (out[gate]) continue;
      const hit = Object.entries(targets).find(([name, cmd]) => gateOf(cmd, name) === gate);
      if (hit) put(gate, `${r.run} ${hit[0]}`, r.name, `${r.name} target "${hit[0]}"`, { target: hit[0], body: targets[hit[0]], exec: r.exec || null });
    }
  }
  // 3. the ecosystem's own command for the toolchain this repo configures
  for (const r of runners) {
    const d = r.defaults ? r.defaults(repo) || {} : {};
    for (const [gate, cmd] of Object.entries(d)) put(gate, cmd, r.name, `${r.name} default`);
  }
  return { repo, runners: runners.map((r) => r.name), gates: out, missing: GATES.filter((g) => !out[g]) };
}
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
function stagedRunner(repo, raw) {
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
function expand(repo, line, targetsByRunner) {
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
      hooks.push({ hook, file: f, ours: body.includes(MARKER), commands });
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
function body(hook, cmds) {
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
    if (!isFile(file) || !readFileSync(file, 'utf8').includes(MARKER)) continue;
    removed.push({ hook, file, why: 'the plan no longer includes this hook' });
    if (!input?.dry) rmSync(file, { force: true });
  }
  for (const [hook, cmds] of Object.entries(p.hooks)) {
    const file = join(dir, hook);
    const text = body(hook, cmds);
    bodies[hook] = text;
    if (isFile(file) && !readFileSync(file, 'utf8').includes(MARKER) && !input?.force) { skipped.push({ hook, file, why: 'the project already has this hook — read it, then pass force to replace it' }); continue; }
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

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = () => { if (!rest[0]) throw new Error('missing JSON argument'); return JSON.parse(rest[0]); };
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    if (cmd === 'detect') out(detect(arg()));
    else if (cmd === 'gates') { const a = arg(); out(gatesOf(resolve(String(a.repo || '')), a.claudeDir)); }
    else if (cmd === 'cover') out(cover(arg()));
    else if (cmd === 'plan') out(planHooks(arg()));
    else if (cmd === 'install') out(install(arg()));
    else { console.error("usage: hooks.mjs detect|gates|cover|plan|install '{ repo, claudeDir? }'"); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
