// diffscan.mjs — the review's mechanical scan: candidates with file:line from the added lines of a diff.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmp, rm, script } from './helpers.mjs';
import { addedLines, scan, diffscan } from '../lib/diffscan.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (repo, rel, body) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), body); };
// built at run time so this file holds no secret-shaped literal for a scanner to flag
const AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const KEY = `-----BEGIN ${'RSA PRIVATE KEY'}-----`;

describe('diffscan', () => {
  it('addedLines numbers the new side of each hunk and skips deleted files', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3,0 +4,2 @@', '+one', '+two', '@@ -10 +12 @@', '-old', '+new', 'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye'].join('\n');
    const r = addedLines(diff);
    assert.deepEqual(r.lines, [{ file: 'a.ts', line: 4, text: 'one' }, { file: 'a.ts', line: 5, text: 'two' }, { file: 'a.ts', line: 12, text: 'new' }]);
    assert.deepEqual(r.files, ['a.ts']);
  });

  it('flags secrets, conflict markers, focused tests and debug leftovers, with a hint where to start', () => {
    const lines = [
      { file: 'src/a.ts', line: 1, text: `const k = '${AWS}';` },
      { file: 'src/a.ts', line: 2, text: '<<<<<<< HEAD' },
      { file: 'src/a.spec.ts', line: 3, text: "it.only('works', () => {});" },
      { file: 'src/a.ts', line: 4, text: '  console.log(user);' },
      { file: 'src/a.spec.ts', line: 5, text: '  console.log(user);' },
      { file: 'src/a.ts', line: 6, text: "const password = 'hunter2hunter2';" },
      { file: 'src/a.ts', line: 7, text: '// TODO: tidy' },
      { file: 'src/a.ts', line: 8, text: 'const password = process.env.PASSWORD;' },
      { file: 'src/k.txt', line: 9, text: KEY },
    ];
    const r = scan({ lines, files: [] });
    const at = (n) => r.hits.find((h) => h.line === n);
    assert.equal(at(1).rule, 'cloud-token'); assert.equal(at(1).hint, 'P0');
    assert.equal(at(2).rule, 'conflict-marker');
    assert.equal(at(3).rule, 'focused-test'); assert.equal(at(3).hint, 'P1');
    assert.equal(at(4).rule, 'debug-output');
    assert.equal(at(5), undefined, 'debug output in a test file is exempt');
    assert.equal(at(6).rule, 'hardcoded-secret');
    assert.equal(at(7).rule, 'todo-marker');
    assert.equal(at(8), undefined, 'reading a secret from the environment is the right way');
    assert.equal(at(9).rule, 'private-key');
    assert.equal(r.hits[0].hint, 'P0', 'worst first');
  });

  it('flags files that should not be committed, but not their example forms', () => {
    const r = scan({ lines: [], files: ['.env', '.env.example', 'cfg/server.pem', 'node_modules/x/index.js', 'src/ok.ts'] });
    assert.deepEqual(r.hits.map((h) => h.file).sort(), ['.env', 'cfg/server.pem', 'node_modules/x/index.js']);
  });

  it('reads a real range: only added lines, with their line numbers in the new file', (t) => {
    const root = tmp('diffscan-'); t.after(() => rm(root));
    const repo = join(root, 'r'); mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main'); put(repo, 'src/a.ts', 'export const a = 1;\nconsole.log("old");\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'checkout', '-q', '-b', 'feat');
    put(repo, 'src/a.ts', 'export const a = 1;\nconsole.log("old");\ndebugger;\nexport const b = 2; // FIXME\n'); put(repo, '.env', 'X=1\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'work');
    const r = diffscan({ repo, base: 'main' });
    assert.equal(r.range, 'main...HEAD');
    assert.deepEqual(r.hits.map((h) => `${h.rule}:${h.file}:${h.line}`), ['committed-env-file:.env:0', 'debugger:src/a.ts:3', 'todo-marker:src/a.ts:4']);
    const cli = spawnSync(process.execPath, [script('diffscan.mjs'), JSON.stringify({ repo, base: 'main' })], { encoding: 'utf8' });
    assert.equal(cli.status, 0); assert.equal(JSON.parse(cli.stdout).byRule.debugger, 1);
    assert.equal(spawnSync(process.execPath, [script('diffscan.mjs'), '{}'], { encoding: 'utf8' }).status, 2);
  });
});
