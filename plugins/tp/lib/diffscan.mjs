#!/usr/bin/env node
// diffscan.mjs — the part of a review that needs no judgment: the lines a diff adds that match a known bad pattern (a secret, a conflict marker, a focused
// test, a leftover debug statement), and the files that should never be committed. It runs on the developer's machine from `git diff`, so the reviewer
// reads candidates with their file:line instead of hunting for them through every hunk, and a pattern is never missed because the hunk was long.
// A hit is a candidate: the reviewer confirms or dismisses it (a `console.log` in a CLI is the product), and the `hint` is only where to start.
//
//   node diffscan.mjs '{ "repo": "<checkout>", "range": "origin/main...HEAD" }'      -> the JSON below
//   node diffscan.mjs '{ "repo", "base": "origin/main" }'                             -> the same, the range being <base>...HEAD
//   { repo, range, files: <changed>, hits: [{ file, line, rule, hint: "P0"…"P3", text }], byRule: { <rule>: <count> } }
// Only added lines are scanned, and a test file is exempt from the debug-statement rules. No dependencies beyond git.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i;
const CODE = /\.(m?[jt]sx?|vue|svelte|py|rb|go|java|kt|cs|php|swift)$/i;

/** Rules over an added line: [rule, hint, pattern, applies(file)]. */
const LINE_RULES = [
  ['conflict-marker', 'P0', /^(<{7}|>{7})(\s|$)|^={7}$/, () => true],
  ['private-key', 'P0', /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/, () => true],
  ['cloud-token', 'P0', /\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{35})\b/, () => true],
  ['hardcoded-secret', 'P0', /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["'`][^"'`\s${}]{10,}["'`]/i, (f) => !TEST_FILE.test(f) && !/\.(md|example|sample|lock)$|\.env\.(example|sample)$/i.test(f)],
  ['focused-test', 'P1', /\b(describe|it|test|context)\.only\s*\(|\b(fdescribe|fit)\s*\(|\bt\.only\s*\(/, () => true],
  ['skipped-test', 'P2', /\b(describe|it|test|context)\.skip\s*\(|\b(xdescribe|xit)\s*\(|@pytest\.mark\.skip|@Disabled\b|\bt\.Skip\(/, () => true],
  ['debugger', 'P2', /^\s*debugger\s*;?\s*$|\bbreakpoint\(\)|\bimport pdb\b|\bbinding\.pry\b|\bpdb\.set_trace\(/, (f) => CODE.test(f)],
  ['debug-output', 'P3', /\bconsole\.(log|debug|trace)\s*\(|^\s*print\(|\bvar_dump\(|\bdd\(|\bSystem\.out\.print/, (f) => CODE.test(f) && !TEST_FILE.test(f)],
  ['todo-marker', 'P3', /\b(TODO|FIXME|XXX|HACK)\b/, () => true],
];

/** Files that should not be in a repository at all. */
const FILE_RULES = [
  ['committed-env-file', 'P0', /(^|\/)\.env(\.[\w.-]+)?$/, (p) => !/\.(example|sample|template|dist)$/.test(p)],
  ['committed-key-file', 'P0', /\.(pem|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|ed25519|ecdsa)$/, () => true],
  ['vendored-or-built', 'P2', /(^|\/)(node_modules|\.idea|\.gradle|__pycache__)\/|(^|\/)\.DS_Store$|\.(log|pyc|class)$/, () => true],
];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The added lines of a diff as { file, line, text }, and the paths added or modified (not deleted). */
export function addedLines(diffText) {
  const lines = []; const files = new Set();
  let file = null; let n = 0;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw === '+++ /dev/null' ? null : raw.slice(6); if (file) files.add(file); continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff ')) { if (raw.startsWith('diff ')) file = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { n = Number(h[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { lines.push({ file, line: n, text: raw.slice(1) }); n++; } else if (!raw.startsWith('-') && !raw.startsWith('\\')) n++;
  }
  return { lines, files: [...files] };
}

/** The hits of added lines and added files — pure, so it is testable without git. */
export function scan({ lines, files }) {
  const hits = [];
  for (const p of files) for (const [rule, hint, re, applies] of FILE_RULES) if (re.test(p) && applies(p)) hits.push({ file: p, line: 0, rule, hint, text: 'the file itself' });
  for (const l of lines) {
    for (const [rule, hint, re, applies] of LINE_RULES) {
      if (applies(l.file) && re.test(l.text)) { hits.push({ file: l.file, line: l.line, rule, hint, text: l.text.trim().slice(0, 160) }); break; }
    }
  }
  const byRule = {};
  for (const h of hits) byRule[h.rule] = (byRule[h.rule] || 0) + 1;
  return { hits: hits.sort((a, b) => a.hint.localeCompare(b.hint) || a.file.localeCompare(b.file) || a.line - b.line), byRule };
}

export function diffscan({ repo, range, base }) {
  const r = range || (base ? `${base}...HEAD` : null);
  if (!repo || !r) throw new Error('usage: diffscan.mjs \'{ "repo": "<checkout>", "range": "<a>...<b>" | "base": "<ref>" }\'');
  const added = addedLines(git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=d', r]));
  return { repo, range: r, files: added.files.length, ...scan(added) };
}

function isMain(url) { try { return realpathSync(process.argv[1]) === fileURLToPath(url); } catch { return false; } }
if (process.argv[1] && isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(diffscan(JSON.parse(process.argv.slice(2).find((a) => a.trim().startsWith('{')) || '{}')), null, 2));
  } catch (e) {
    console.error(String(e.message || e).split('\n')[0]);
    process.exit(2);
  }
}
