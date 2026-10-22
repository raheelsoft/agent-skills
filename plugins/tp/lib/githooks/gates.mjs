// gates.mjs — the project's own command per gate, whatever its ecosystem (tiers.json first, then a target the project defines, then the ecosystem's own command) and its check-only form.
import { GATES, config } from './common.mjs';
import { gateOf, scopeOf } from './classify.mjs';
import { runnersOf } from './runners.mjs';

// a command that rewrites files, and the check-only form to use in a pre-commit hook instead
export const REWRITES = /(--fix\b|--write\b|--in-place\b|-w\b|\bgofmt -w|\bblack (?!--check)|\bisort (?!--check)|\brubocop -a|\bmix format(?! --check)|\bcargo fmt(?! --check| -- --check)|\bdotnet format(?! --verify)|\bruff format(?! --check)|\bprettier (?!--check)[^|]*--write)/;

export const CHECK_FORM = [
  [/\s--fix\b/, ''], [/\s--write\b/, ' --check'], [/\bgofmt -w/, 'gofmt -l'], [/\bblack\b(?! --check)/, 'black --check'],
  [/\bisort\b(?! --check)/, 'isort --check-only'], [/\brubocop -a\b/, 'rubocop'], [/\bmix format\b(?! --check)/, 'mix format --check-formatted'],
  [/\bcargo fmt\b(?! --check)/, 'cargo fmt --check'], [/\bdotnet format\b(?! --verify)/, 'dotnet format --verify-no-changes'],
  [/\bruff format\b(?! --check)/, 'ruff format --check'],
];

export const checkForm = (cmd) => { let out = String(cmd); for (const [re, to] of CHECK_FORM) if (re.test(out)) out = out.replace(re, to); return out === String(cmd) ? null : out; };

// tools the shell already has; anything else bare in a JS project lives in node_modules/.bin and needs the runner's exec
export const GLOBALS = new Set(['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'sh', 'bash', 'env', 'git', 'make', 'just', 'task',
  'cargo', 'go', 'gofmt', 'goimports', 'python', 'python3', 'pip', 'poetry', 'uv', 'tox', 'nox', 'mix', 'dotnet', 'mvn', 'gradle', './gradlew',
  'swift', 'bundle', 'rake', 'composer', 'php', 'ruby', 'docker', 'echo', 'test', 'cd']);
/** A command taken out of a package script runs through the project's exec, or its binaries are not on PATH. */

export function execify(cmd, exec) {
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
