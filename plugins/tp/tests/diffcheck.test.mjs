// diffcheck.mjs — the mechanical half of diff validation: each changed file sorted against the plan and its own name, the warning signs that need no
// reading, and the table written from it. A branch with nothing left over needs no validating agent; these tests are why that is safe to say.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmp, rm, script } from './helpers.mjs';
import { classify, diffcheck, renderDiff } from '../lib/diffcheck.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (repo, rel, body = 'x\n') => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), body); };

/** A repo on main with a few files, a branch off it, and a plan. `change(repo)` edits the working tree; everything is committed. */
function bed(t, change, plan = PLAN) {
  const root = tmp('diffcheck-'); t.after(() => rm(root));
  const repo = join(root, 'shop'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'src/invoices/total.ts', `export const total = 1;\n${'export const filler = 0;\n'.repeat(8)}`); put(repo, 'package.json', '{"name":"shop"}\n'); put(repo, 'package-lock.json', '{}\n'); put(repo, 'README.md', '# shop\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  change(repo);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'change');
  const workdir = join(root, 'work', 'T-1'); mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, 'plan.md'), plan);
  return { root, repo, workdir };
}
const PLAN = `# Plan — T-1: Show the total with VAT

status: ready
risk flags: none
repos: \`shop\`

## Goal
1. The total includes VAT

## Steps

### Step 1 — The total
- Files: \`src/invoices/total.ts\` (edit), \`src/invoices/vat.ts\` (new)
- Change: add VAT
- Commit: yes

### Step 2 — The docs folder
- Files: \`docs/\` (new)
- Change: describe it
- Commit: yes
`;
const by = (r) => Object.fromEntries(r.files.map((f) => [f.path, f]));

describe('diffcheck.mjs — a file against the plan and its own name', () => {
  it('a branch that does what the plan says, with its test and its lockfile, is clean and needs no agent', (t) => {
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); put(r, 'src/invoices/vat.ts'); put(r, 'src/invoices/vat.test.ts'); put(r, 'package.json', '{"name":"shop","x":1}\n'); put(r, 'package-lock.json', '{"x":1}\n'); });
    const r = diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir });
    assert.equal(r.verdict, 'review', 'package.json is not in the plan, so the manifest is unexpected …');
    assert.deepEqual(r.files.filter((f) => f.class === 'unexpected').map((f) => f.path), ['package.json']);
    const c = by(r);
    assert.deepEqual([c['src/invoices/total.ts'].class, c['src/invoices/total.ts'].step, c['src/invoices/vat.ts'].class], ['expected', 1, 'expected']);
    assert.deepEqual([c['src/invoices/vat.test.ts'].class, c['src/invoices/vat.test.ts'].why], ['supporting', 'a test for src/invoices/vat.ts']);
    assert.match(c['package-lock.json'].why, /the lockfile of package\.json, which changed too/);
    const clean = bed(t, (r2) => { put(r2, 'src/invoices/total.ts', 'export const total = 2;\n'); put(r2, 'src/invoices/vat.ts'); put(r2, 'src/invoices/vat.test.ts'); put(r2, 'docs/vat.md'); });
    const ok = diffcheck({ repo: clean.repo, base: 'main', workdir: clean.workdir });
    assert.equal(ok.verdict, 'clean');
    assert.deepEqual(ok.counts, { expected: 3, supporting: 1, unexpected: 0 });
    assert.equal(by(ok)['docs/vat.md'].why, 'plan step 2 names it', 'a folder the plan names covers what is in it');
    assert.deepEqual(ok.warnings, []);
    assert.equal(ok.head, git(clean.repo, 'rev-parse', 'HEAD'));
  });

  it('a file the plan does not name is Unexpected, and the verdict is review', (t) => {
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); put(r, 'src/unrelated/helper.ts'); put(r, 'README.md', '# shop\nmore\n'); });
    const r = diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir });
    assert.equal(r.verdict, 'review');
    assert.deepEqual(r.files.filter((f) => f.class === 'unexpected').map((f) => [f.path, f.why]), [['README.md', 'not named by the plan'], ['src/unrelated/helper.ts', 'not named by the plan']]);
    assert.deepEqual(r.counts, { expected: 1, supporting: 0, unexpected: 2 });
  });

  it('a lockfile without its manifest, a test with nothing beside it, and a deletion are Unexpected, each saying why', (t) => {
    const b = bed(t, (r) => { put(r, 'package-lock.json', '{"y":2}\n'); put(r, 'test/orphan.test.ts'); execFileSync('git', ['rm', '-q', 'README.md'], { cwd: r }); });
    const c = by(diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir }));
    assert.equal(c['package-lock.json'].class, 'unexpected');
    assert.match(c['package-lock.json'].why, /changed without its manifest \(package\.json\)/);
    assert.match(c['test/orphan.test.ts'].why, /a test with no expected change beside it/);
    assert.deepEqual([c['README.md'].status, c['README.md'].why], ['D', 'deleted, and the plan does not name it']);
  });

  it('generated output is Supporting when something else changed, and a snapshot or a build folder counts as generated', (t) => {
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); put(r, 'src/__snapshots__/total.snap'); put(r, 'dist/total.js'); put(r, '.gitattributes', 'src/gen/*.ts linguist-generated\n'); put(r, 'src/gen/client.ts'); });
    const c = by(diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir }));
    for (const p of ['src/__snapshots__/total.snap', 'dist/total.js', 'src/gen/client.ts']) assert.equal(c[p].class, 'supporting', p);
    assert.equal(c['.gitattributes'].class, 'unexpected');
  });

  it('follows a rename and reports the line counts', (t) => {
    const b = bed(t, (r) => { execFileSync('git', ['mv', 'src/invoices/total.ts', 'src/invoices/vat.ts'], { cwd: r }); put(r, 'src/invoices/vat.ts', `export const total = 1;\n${'export const filler = 0;\n'.repeat(8)}export const vat = 0.2;\n`); });
    const r = diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir });
    const f = r.files.find((x) => x.path === 'src/invoices/vat.ts');
    assert.deepEqual([f.status, f.from, f.class], ['R', 'src/invoices/total.ts', 'expected']);
    assert.equal(f.additions, 1);
    assert.equal(r.changed.files, 1);
  });
});

describe('diffcheck.mjs — a plan that is notes, no plan, and a delta', () => {
  it('reads a plan written as notes by the paths it puts in backticks', (t) => {
    const notes = '# Plan — T-1\n\nFix it: change `src/invoices/total.ts`, and add `test/total.test.ts`. Run `npm test` to check; the setting `vat` stays.\n\n```\nsrc/never/read.ts\n```\n';
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); put(r, 'test/total.test.ts'); put(r, 'src/never/read.ts'); }, notes);
    const c = by(diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir }));
    assert.deepEqual([c['src/invoices/total.ts'].class, c['src/invoices/total.ts'].why], ['expected', 'the plan names it']);
    assert.equal(c['test/total.test.ts'].class, 'expected', 'named in the notes');
    assert.equal(c['src/never/read.ts'].class, 'unexpected', 'a path in a code fence is no mention');
  });

  it('with no plan every file but a lockfile, a test or a generated one is Unexpected, so a reading is needed', (t) => {
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); });
    const r = diffcheck({ repo: b.repo, base: 'main', workdir: join(b.root, 'nowhere') });
    assert.equal(r.verdict, 'review');
    assert.equal(r.files[0].why, 'there is no plan to compare with');
  });

  it('the delta of an update round is the commits since the sha it was validated through', (t) => {
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); });
    const validated = git(b.repo, 'rev-parse', 'HEAD');
    put(b.repo, 'src/invoices/vat.ts'); put(b.repo, 'oops.txt');
    git(b.repo, 'add', '-A'); git(b.repo, 'commit', '-q', '-m', 'fix round');
    const r = diffcheck({ repo: b.repo, since: validated, workdir: b.workdir });
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['oops.txt', 'src/invoices/vat.ts']);
    assert.equal(r.range, `${validated}..HEAD`);
    assert.equal(r.verdict, 'review');
  });
});

describe('diffcheck.mjs — the warning signs that need no reading', () => {
  it('flags many files for a focused fix, a schema without its migration and the other way round, a big change and a binary file', (t) => {
    const b = bed(t, (r) => {
      for (let i = 0; i < 11; i++) put(r, `docs/note-${i}.md`);
      put(r, 'prisma/schema.prisma', 'model A {}\n'); put(r, 'src/big.ts', 'x\n'.repeat(500));
      writeFileSync(join(r, 'logo.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
    });
    const r = diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir });
    assert.ok(r.warnings.some((w) => /more than ~10 files for a focused fix: 14 files, 2 plan steps/.test(w)), r.warnings.join(' | '));
    assert.ok(r.warnings.includes('a schema change without its migration'));
    assert.ok(r.warnings.some((w) => /a large change in src\/big\.ts \(500 lines\)/.test(w)));
    assert.ok(r.warnings.includes('a binary file: logo.png'));
    const m = bed(t, (r2) => { put(r2, 'db/migrations/001_a.sql'); });
    assert.ok(diffcheck({ repo: m.repo, base: 'main', workdir: m.workdir }).warnings.includes('a migration without a schema change'));
  });
});

describe('diffcheck.mjs — the table and the command', () => {
  it('renders the diff-validation.md table with its starting point for the next round', (t) => {
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); put(r, 'src/invoices/vat.ts'); put(r, 'src/invoices/vat.test.ts'); });
    const r = diffcheck({ repo: b.repo, base: 'main', workdir: b.workdir });
    const md = renderDiff(r, { title: 'Diff validation — creation round' });
    assert.match(md, /^## Diff validation — creation round\n\n3 files, \+\d+ −\d+\. Expected 2 · Supporting 1 · Unexpected 0\./);
    assert.match(md, /\| src\/invoices\/total\.ts \| Expected \| plan step 1 names it \|/);
    assert.match(md, /\| src\/invoices\/vat\.test\.ts \| Supporting \| a test for src\/invoices\/vat\.ts \|/);
    assert.ok(md.trimEnd().endsWith(`Validated through: ${r.head}`));
  });

  it('is a command: JSON by default, the table with --render, exit 2 on a bad call', (t) => {
    const b = bed(t, (r) => { put(r, 'src/invoices/total.ts', 'export const total = 2;\n'); });
    const input = JSON.stringify({ repo: b.repo, base: 'main', workdir: b.workdir });
    const j = spawnSync(process.execPath, [script('diffcheck.mjs'), input], { encoding: 'utf8' });
    assert.equal(j.status, 0, j.stderr);
    assert.equal(JSON.parse(j.stdout).counts.expected, 1);
    const md = spawnSync(process.execPath, [script('diffcheck.mjs'), input, '--render'], { encoding: 'utf8' });
    assert.match(md.stdout, /^## Diff validation — main\.\.\.HEAD/);
    const bad = spawnSync(process.execPath, [script('diffcheck.mjs'), '{}'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage: diffcheck\.mjs/);
  });
});

it('a migration is supporting when its schema changed too, unexpected when nothing explains it', () => {
  const f = (path) => ({ path, status: 'A', additions: 5, deletions: 0 });
  const plan = '1. Add the table: `prisma/schema.prisma`';
  const withSchema = classify([f('prisma/schema.prisma'), f('prisma/migrations/20260920_add_x/migration.sql')], plan);
  assert.equal(withSchema.files.find((x) => /migration\.sql/.test(x.path)).class, 'supporting');
  assert.equal(withSchema.verdict, 'clean');
  const alone = classify([f('src/a.ts'), f('prisma/migrations/20260920_add_x/migration.sql')], '1. Edit `src/a.ts`');
  assert.equal(alone.files.find((x) => /migration\.sql/.test(x.path)).class, 'unexpected');
});
