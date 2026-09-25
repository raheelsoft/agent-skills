// hooks.mjs — the repo's git hooks as gate owners (README § Verification rules, Gates the hooks own): what they run,
// which gates that covers and at what scope, and the Husky-style hooks written from the project's own commands.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, CLAUDE_DIR, writeJson } from './helpers.mjs';

const HOOKS = join(CLAUDE_DIR, 'skills', '_lib', 'hooks.mjs');
const hooks = (...args) => { const r = spawnSync(process.execPath, [HOOKS, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8' }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* an error */ } return { code: r.status, json, err: r.stderr }; };

/** A git repo with a package.json; `tiers` (optional) is written beside it as a fake <.claude>. */
function repo(root, pkg = {}, tiers = null) {
  const dir = join(root, 'app');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', ...pkg }, null, 2));
  const claude = join(root, '.claude');
  mkdirSync(claude, { recursive: true });
  if (tiers) writeJson(claude, 'tiers.json', tiers);
  return { dir, claude };
}
function hook(dir, name, text) {
  mkdirSync(join(dir, '.husky'), { recursive: true });
  writeFileSync(join(dir, '.husky', name), text);
  chmodSync(join(dir, '.husky', name), 0o755);
  execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);
}

describe('hooks.mjs detect — what the repo\'s hooks actually run', () => {
  it('resolves package scripts and lint-staged entries to gates, with the scope each covers', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir } = repo(root, {
      scripts: { lint: 'eslint "src/**/*.ts"', typecheck: 'tsc --noEmit', test: 'jest', build: 'nest build' },
      'lint-staged': { '*.ts': ['eslint --fix', 'prettier --write'] },
    });
    hook(dir, 'pre-commit', '#!/bin/sh\nnpx lint-staged\n');
    hook(dir, 'pre-push', '#!/bin/sh\n# comment\nnpm run typecheck\nnpm run test\n');
    const d = hooks('detect', { repo: dir });
    assert.equal(d.code, 0, d.err);
    assert.deepEqual(d.json.hooks.map((h) => h.hook), ['pre-commit', 'pre-push']);
    assert.equal(d.json.manager, 'husky-style');
    assert.equal(d.json.hooksPath, '.husky');
    const pc = d.json.hooks[0].commands;
    assert.deepEqual(pc.map((c) => [c.gate, c.scope]), [['lint', 'staged'], ['format', 'staged']]);
    assert.match(pc[0].via, /lint-staged \(\*\.ts\)/);
    const pp = d.json.hooks[1].commands;
    assert.deepEqual(pp.map((c) => [c.gate, c.scope, c.via]), [['types', 'repo', 'npm target "typecheck"'], ['tests', 'repo', 'npm target "test"']]);
  });

  it('reads plain .git/hooks too, ignores samples and husky\'s own wrapper, and reports no hooks when there are none', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir } = repo(root, { scripts: { lint: 'eslint .' } });
    assert.deepEqual(hooks('detect', { repo: dir }).json.hooks, []);
    assert.equal(hooks('detect', { repo: dir }).json.manager, 'git');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm run lint\n');
    const d = hooks('detect', { repo: dir }).json;
    assert.deepEqual(d.hooks.map((h) => [h.hook, h.commands[0].gate]), [['pre-commit', 'lint']]);
    // a .husky/_ wrapper is husky's, not the project's script
    mkdirSync(join(dir, '.husky', '_'), { recursive: true });
    writeFileSync(join(dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);
    assert.deepEqual(hooks('detect', { repo: dir }).json.hooks.map((h) => h.hook), ['pre-commit'], 'the .git/hooks script is still found');
    assert.ok(!hooks('detect', { repo: dir }).json.hooks.some((h) => h.file.includes('.husky/_')));
  });

  it('refuses a path that is not a checkout', () => {
    assert.equal(hooks('detect', { repo: '/nope/nothing' }).code, 1);
    assert.equal(hooks('nonsense', { repo: '.' }).code, 2);
  });
});

describe('hooks.mjs cover — which gates the pipeline may skip', () => {
  it('a repo-scope hook covers its gate; a staged hook covers lint and format only', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, {
      scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'jest', build: 'next build' },
      'lint-staged': { '*.ts': ['eslint --fix', 'prettier --write', 'tsc --noEmit'] },
    });
    hook(dir, 'pre-commit', '#!/bin/sh\nnpx lint-staged\n');
    const c = hooks('cover', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(c.gates.sort(), ['format', 'lint'], 'a staged type check covers nothing: the whole program is not checked');
    assert.deepEqual([c.covered.lint.hook, c.covered.lint.scope], ['pre-commit', 'staged']);
    assert.equal(c.covered.types, undefined);
    hook(dir, 'pre-push', '#!/bin/sh\nnpm run typecheck\nnpm run test\nnpm run build\n');
    const both = hooks('cover', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(both.gates.sort(), ['build', 'format', 'lint', 'tests', 'types']);
    assert.deepEqual([both.covered.types.hook, both.covered.types.scope], ['pre-push', 'repo']);
  });

  it('tiers.json hooks.trust false covers nothing — an audit run gates everything itself', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { lint: 'eslint .' } }, { hooks: { trust: false } });
    hook(dir, 'pre-commit', '#!/bin/sh\nnpm run lint\n');
    const c = hooks('cover', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual([c.trust, c.gates], [false, []]);
    assert.deepEqual(hooks('cover', { repo: dir }).json.gates, ['lint'], 'without the file the default is to trust them');
  });
});

describe('hooks.mjs plan and install — the project\'s own commands, never invented', () => {
  it('plans from tiers.json.hooks.plan, names the gates the project defines no command for, and writes the hooks', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { lint: 'eslint .', test: 'jest' } }, { hooks: { plan: { 'pre-commit': ['lint'], 'pre-push': ['types', 'tests'] } } });
    const p = hooks('plan', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(p.missing, ['types'], 'no type-check command in the project: named, not invented');
    assert.deepEqual(Object.keys(p.hooks), ['pre-commit', 'pre-push']);
    assert.deepEqual(p.hooks['pre-push'].map((c) => c.cmd), ['npm run test']);
    const dry = hooks('install', { repo: dir, claudeDir: claude, dry: true }).json;
    assert.deepEqual(dry.written.map((w) => w.hook), ['pre-commit', 'pre-push']);
    assert.ok(!existsSync(join(dir, '.husky', 'pre-commit')), 'dry writes nothing');
    assert.match(dry.bodies['pre-commit'], /^#!\/bin\/sh\n# written by the ticket pipeline[\s\S]*never bypass it with --no-verify\.\nset -e\n\{ npm run lint; \} \|\| exit 1 # lint\n$/);
    assert.ok(!/\r/.test(dry.bodies['pre-commit']), 'LF only: a CRLF sh script does not run on any OS');
    const r = hooks('install', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(r.written.map((w) => w.hook), ['pre-commit', 'pre-push']);
    assert.equal(r.hooksPath, '.husky');
    assert.match(r.note, /core\.hooksPath set to \.husky/);
    assert.match(r.note, /keep them LF in a Windows clone/, 'the note carries the one OS caveat');
    assert.match(dry.note, /would be set/, 'a dry run says what it would do, and does not do it');
    assert.equal(execFileSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim(), '.husky');
    assert.ok(statSync(join(dir, '.husky', 'pre-commit')).mode & 0o111, 'executable');
    // the gates it now owns are exactly what cover reports
    assert.deepEqual(hooks('cover', { repo: dir, claudeDir: claude }).json.gates.sort(), ['lint', 'tests']);
    // a second install is idempotent (its own marker), and it refuses to overwrite someone else's hook
    assert.deepEqual(hooks('install', { repo: dir, claudeDir: claude }).json.written.map((w) => w.hook), ['pre-commit', 'pre-push']);
    writeFileSync(join(dir, '.husky', 'pre-commit'), '#!/bin/sh\necho mine\n');
    const keep = hooks('install', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(keep.skipped.map((s) => s.hook), ['pre-commit']);
    assert.match(keep.skipped[0].why, /already has this hook/);
    assert.equal(readFileSync(join(dir, '.husky', 'pre-commit'), 'utf8'), '#!/bin/sh\necho mine\n');
    assert.deepEqual(hooks('install', { repo: dir, claudeDir: claude, force: true }).json.written.map((w) => w.hook), ['pre-commit', 'pre-push']);
  });

  it('a pre-commit command that rewrites files becomes its check-only form, or the staged runner, or a warning', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    // a target whose body rewrites: the hook gets the tool's own check-only command (a flag cannot pass through npm run)
    const { dir, claude } = repo(root, { scripts: { lint: 'eslint . --fix', format: 'prettier --write .' } }, { hooks: { plan: { 'pre-commit': ['lint', 'format'] } } });
    const p = hooks('plan', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual([p.warnings, p.hooks['pre-commit'].map((c) => c.cmd)], [[], ['npx eslint .', 'npx prettier --check .']], 'the check-only form of a package script runs through npx');
    assert.deepEqual([p.gates.lint.scope, p.gates.format.scope], ['repo', 'repo']);
    // with a staged-files runner, lint and format go through it instead — it re-stages what it rewrote
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, 'lint-staged': { '*.ts': ['eslint --fix', 'prettier --write'] } }, null, 2));
    const staged = hooks('plan', { repo: dir, claudeDir: claude }).json;
    assert.equal(staged.stagedRunner, 'lint-staged');
    assert.deepEqual(staged.hooks['pre-commit'].map((c) => c.cmd), ['npx lint-staged']);
    assert.equal(staged.gates.lint.scope, 'staged');
    // a rewriting command with no check-only form and no staged runner: warned about, nothing written
    const r2 = tmp('hooks-'); t.after(() => rm(r2));
    const other = repo(r2, { scripts: { format: 'my-formatter --in-place' } }, { hooks: { plan: { 'pre-commit': ['format'] } } });
    // it is a formatter by its script name; its body rewrites and has no known check flag
    const bad = hooks('plan', { repo: other.dir, claudeDir: other.claude }).json;
    assert.equal(bad.warnings.length, 1, JSON.stringify(bad));
    assert.match(bad.warnings[0], /rewrites files and has no check-only form/);
    const w = hooks('install', { repo: other.dir, claudeDir: other.claude }).json;
    assert.deepEqual(w.written, [], 'nothing written while a fix would be left out of the commit');
    assert.match(w.note, /nothing written/);
    assert.ok(!existsSync(join(other.dir, '.husky', 'pre-commit')));
  });

  it('a check-only form lifted out of a package script runs through the project\'s exec — a bare binary is not on PATH', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { lint: 'eslint "src/**/*.ts" --fix && node scripts/extra.mjs', format: 'prettier --write .' } }, { hooks: { plan: { 'pre-commit': ['lint', 'format'] } } });
    const g = hooks('gates', { repo: dir, claudeDir: claude }).json;
    assert.equal(g.gates.lint.check, 'npx eslint "src/**/*.ts" && node scripts/extra.mjs', 'the local tool gets npx; node does not');
    assert.equal(g.gates.format.check, 'npx prettier --check .');
    const body = hooks('install', { repo: dir, claudeDir: claude, dry: true }).json.bodies['pre-commit'];
    assert.match(body, /\{ npx eslint "src\/\*\*\/\*\.ts" && node scripts\/extra\.mjs; \} \|\| exit 1 # lint/);
    // a pnpm project gets pnpm exec, and an ecosystem whose tools are global gets no prefix
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
    assert.match(hooks('gates', { repo: dir, claudeDir: claude }).json.gates.format.check, /^pnpm exec prettier --check/);
    const go = join(root, 'go'); mkdirSync(go, { recursive: true }); execFileSync('git', ['init', '-q', go]);
    writeFileSync(join(go, 'go.mod'), 'module x\n');
    writeFileSync(join(go, 'Makefile'), 'fmt:\n\tgofmt -w .\n');
    assert.equal(hooks('gates', { repo: go, claudeDir: claude }).json.gates.format.check, 'gofmt -l .', 'a global tool needs no exec prefix');
  });

  it('resolves gates in any ecosystem: the project\'s own target first, then the toolchain it configures', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const claude = join(root, '.claude'); mkdirSync(claude, { recursive: true });
    const eco = (name, files) => {
      const dir = join(root, name); mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q', dir]);
      for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
      return hooks('gates', { repo: dir, claudeDir: claude }).json;
    };
    const go = eco('go', { 'go.mod': 'module x\ngo 1.22\n' });
    assert.deepEqual([go.runners, go.missing], [['go'], []]);
    assert.deepEqual([go.gates.lint.cmd, go.gates.format.cmd, go.gates.tests.cmd], ['go vet ./...', 'gofmt -l .', 'go test ./...']);
    const py = eco('py', { 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n' });
    assert.deepEqual([py.gates.lint.cmd, py.gates.types.cmd, py.gates.tests.cmd], ['ruff check .', 'mypy .', 'pytest -q']);
    const poetry = eco('poetry', { 'pyproject.toml': '[tool.black]\n[tool.pytest]\n', 'poetry.lock': '' });
    assert.deepEqual([poetry.gates.format.cmd, poetry.gates.tests.cmd], ['poetry run black --check .', 'poetry run pytest -q']);
    const rust = eco('rust', { 'Cargo.toml': '[package]\nname = "x"\n' });
    assert.deepEqual([rust.gates.format.cmd, rust.gates.lint.cmd, rust.gates.types.cmd], ['cargo fmt --check', 'cargo clippy --all-targets -- -D warnings', 'cargo check --all-targets']);
    const mk = eco('mk', { Makefile: 'lint:\n\tgolangci-lint run\n\ntest:\n\tgo test ./...\n', 'go.mod': 'module x\n' });
    assert.deepEqual([mk.gates.lint.cmd, mk.gates.tests.cmd], ['make lint', 'make test'], "the project's own target wins over the ecosystem default");
    assert.equal(mk.gates.format.cmd, 'gofmt -l .', 'and the gates it defines no target for fall back to the toolchain');
    const just = eco('just', { justfile: 'check:\n  mix format --check-formatted\n', 'mix.exs': 'defmodule X do\nend\n' });
    assert.equal(just.gates.format.cmd, 'just check');
    const gradle = eco('gradle', { 'build.gradle': '', gradlew: '' });
    assert.deepEqual([gradle.gates.tests.cmd, gradle.missing.sort()], ['./gradlew test', ['format', 'types']]);
    const dotnet = eco('dotnet', { 'App.csproj': '<Project/>' });
    assert.deepEqual([dotnet.gates.format.cmd, dotnet.gates.tests.cmd], ['dotnet format --verify-no-changes', 'dotnet test']);
    const ruby = eco('ruby', { Gemfile: "gem 'rubocop'\ngem 'rspec'\n" });
    assert.deepEqual([ruby.gates.lint.cmd, ruby.gates.tests.cmd], ['bundle exec rubocop', 'bundle exec rspec']);
  });

  it('tiers.json hooks.commands wins over every detection — the escape hatch for a toolchain it does not know', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { test: 'jest' } }, { hooks: { commands: { tests: 'bazel test //...', types: 'buck2 build //...' } } });
    const g = hooks('gates', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual([g.gates.tests.cmd, g.gates.tests.source, g.gates.types.cmd], ['bazel test //...', 'tiers.json hooks.commands', 'buck2 build //...']);
    assert.deepEqual(hooks('plan', { repo: dir, claudeDir: claude }).json.hooks['pre-push'].map((c) => c.cmd), ['buck2 build //...', 'bazel test //...']);
  });

  it('a lockfile git does not track is not the project\'s package manager', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { lint: 'eslint .' } });
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    execFileSync('git', ['-C', dir, 'add', 'package.json', 'package-lock.json']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
    const g = hooks('gates', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(g.runners, ['npm'], 'the untracked pnpm-lock.yaml is a stray file');
    assert.equal(g.gates.lint.cmd, 'npm run lint');
  });

  it('removes a hook it wrote once the plan drops it, and never one the project wrote', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { lint: 'eslint .', test: 'jest' } }, { hooks: { plan: { 'pre-commit': ['lint'], 'pre-push': ['tests'] } } });
    hooks('install', { repo: dir, claudeDir: claude });
    assert.ok(existsSync(join(dir, '.husky', 'pre-push')));
    // the install moves the test gate to CI: the plan shrinks, and the hook it wrote goes with it
    writeJson(claude, 'tiers.json', { hooks: { plan: { 'pre-commit': ['lint'], 'pre-push': [] } } });
    const dry = hooks('install', { repo: dir, claudeDir: claude, dry: true }).json;
    assert.deepEqual(dry.removed.map((r) => r.hook), ['pre-push']);
    assert.ok(existsSync(join(dir, '.husky', 'pre-push')), 'a dry run removes nothing');
    const r = hooks('install', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(r.removed.map((r2) => r2.hook), ['pre-push']);
    assert.ok(!existsSync(join(dir, '.husky', 'pre-push')));
    assert.ok(existsSync(join(dir, '.husky', 'pre-commit')), 'the planned hook stays');
    assert.deepEqual(hooks('cover', { repo: dir, claudeDir: claude }).json.gates, ['lint']);
    // a hook the project wrote is not ours to remove
    writeFileSync(join(dir, '.husky', 'pre-push'), '#!/bin/sh\necho theirs\n');
    const again = hooks('install', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual(again.removed, []);
    assert.equal(readFileSync(join(dir, '.husky', 'pre-push'), 'utf8'), '#!/bin/sh\necho theirs\n');
  });

  it('leaves an existing hooks path alone and says so', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { lint: 'eslint .' }, devDependencies: { husky: '^9' } });
    mkdirSync(join(dir, '.husky', '_'), { recursive: true });
    execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);
    const r = hooks('install', { repo: dir, claudeDir: claude }).json;
    assert.equal(r.hooksPath, '.husky/_');
    assert.match(r.note, /husky manages core\.hooksPath/);
    assert.equal(execFileSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim(), '.husky/_');
    assert.equal(hooks('detect', { repo: dir }).json.manager, 'husky');
  });

  it('a failing command inside an && chain still blocks the commit (POSIX set -e would not)', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    // the project's own script chains two commands: the FIRST one fails
    const { dir, claude } = repo(root, { scripts: { lint: 'sh -c "exit 3" && echo second' } }, { hooks: { plan: { 'pre-commit': ['lint'] } } });
    hooks('install', { repo: dir, claudeDir: claude });
    const body = readFileSync(join(dir, '.husky', 'pre-commit'), 'utf8');
    assert.match(body, /\|\| exit 1/, 'each line carries its own exit');
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'blocked'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'the chain\'s first failure blocks the commit');
    assert.equal(spawnSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim(), '');
  });

  it('the written pre-commit hook really fails a commit that breaks a gate', (t) => {
    const root = tmp('hooks-'); t.after(() => rm(root));
    const { dir, claude } = repo(root, { scripts: { lint: 'sh -c "grep -q OK marker.txt"' } }, { hooks: { plan: { 'pre-commit': ['lint'] } } });
    // the script name decides the gate when no tool is recognised
    hooks('install', { repo: dir, claudeDir: claude });
    const commit = (msg) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], { encoding: 'utf8' });
    writeFileSync(join(dir, 'marker.txt'), 'FAILING\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    const bad = commit('breaks the gate');
    assert.notEqual(bad.status, 0, `the hook stopped the commit: ${bad.stderr}`);
    assert.equal(spawnSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim(), '', 'nothing was committed');
    writeFileSync(join(dir, 'marker.txt'), 'OK\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    assert.equal(commit('passes the gate').status, 0, `${commit.stderr || ''}`);
  });
});
