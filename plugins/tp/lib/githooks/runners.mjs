// runners.mjs — how a project states its own commands, per ecosystem: package scripts, Makefile/justfile/Taskfile targets, composer and poetry scripts, and the toolchains' own defaults.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { git, isFile, readJson } from './common.mjs';

// Each entry: the files that mark it, how to run one of its targets, the targets it defines (when they can be read),
// and the ecosystem's own command per gate for the tools the repo actually configures. Adding an ecosystem is one entry.
export const text = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

export const anyFile = (repo, names) => names.find((n) => isFile(join(repo, n))) || null;

export const globFile = (repo, re) => { try { return readdirSync(repo).find((n) => re.test(n)) || null; } catch { return null; } };

export function pkgScripts(repo) {
  const pkg = readJson(join(repo, 'package.json'));
  return pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
}

// `target: command` pairs from a Makefile / justfile: the recipe's first line is enough to classify it
export function makeTargets(file) {
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

export function justTargets(file) {
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

export function taskTargets(file) {
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

export function composerScripts(repo) {
  const j = readJson(join(repo, 'composer.json'));
  return j && j.scripts && typeof j.scripts === 'object' ? Object.fromEntries(Object.entries(j.scripts).map(([k, v]) => [k, [].concat(v).join(' && ')])) : {};
}

export function pythonDefaults(repo) {
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

export const gradleCmd = (repo) => (isFile(join(repo, 'gradlew')) ? './gradlew' : 'gradle');

// a lockfile git does not track is a stray file from another tool, not the project's package manager
export const tracked = (repo, file) => isFile(join(repo, file)) && git(repo, ['ls-files', '--error-unmatch', file]) !== null;

export const lock = (repo, files) => files.some((f) => tracked(repo, f)) || (files.some((f) => isFile(join(repo, f))) && !['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json', 'npm-shrinkwrap.json'].some((o) => !files.includes(o) && tracked(repo, o)));

export const RUNNERS = [
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
