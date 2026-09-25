// codegen.mjs — generated code the gates depend on (README § Toolchain). The case this exists for: a schema moves ahead
// of the generated client, and a type-aware gate reports the mismatch as errors in code nobody touched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, CLAUDE_DIR, writeJson } from './helpers.mjs';

const CODEGEN = join(CLAUDE_DIR, 'skills', '_lib', 'codegen.mjs');
const codegen = (...args) => { const r = spawnSync(process.execPath, [CODEGEN, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8' }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* an error */ } return { code: r.status, json, err: r.stderr }; };

/** A git repo plus a fake <.claude> beside it; `files` is a map of relative path -> contents. */
function repo(root, files = {}, tiers = null) {
  const dir = join(root, 'app');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  const claude = join(root, '.claude');
  mkdirSync(join(claude, 'work'), { recursive: true });
  if (tiers) writeJson(claude, 'tiers.json', tiers);
  return { dir, claude };
}
const prismaRepo = (root, extra = {}, tiers = null) => repo(root, {
  'package.json': JSON.stringify({ name: 'api', scripts: { 'prisma:generate': 'prisma generate', build: 'nest build' } }, null, 2),
  'prisma/schema.prisma': 'model Lead { id String @id }\n',
  ...extra,
}, tiers);

describe('codegen.mjs detect — the project\'s own generate command', () => {
  it('prefers the project\'s own target over the tool the config implies', (t) => {
    const root = tmp('codegen-'); t.after(() => rm(root));
    const { dir, claude } = prismaRepo(root);
    const d = codegen('detect', { repo: dir, claudeDir: claude }).json;
    assert.deepEqual([d.command, d.source, d.generator], ['npm run prisma:generate', 'npm target "prisma:generate"', 'prisma']);
    assert.deepEqual(d.inputs.map((p) => p.replace(dir + '/', '')), ['prisma/schema.prisma']);
    assert.deepEqual(d.outputs.map((p) => p.replace(dir + '/', '')), ['node_modules/.prisma/client']);
  });

  it('falls back to the tool the repo configures, run the way that ecosystem runs a local tool', (t) => {
    const root = tmp('codegen-'); t.after(() => rm(root));
    const noScript = repo(root, { 'package.json': JSON.stringify({ name: 'api' }), 'prisma/schema.prisma': 'model A { id String @id }\n' });
    assert.deepEqual(['npx prisma generate', 'prisma config in the repo'], [codegen('detect', { repo: noScript.dir, claudeDir: noScript.claude }).json.command, codegen('detect', { repo: noScript.dir, claudeDir: noScript.claude }).json.source]);
    const root2 = tmp('codegen-'); t.after(() => rm(root2));
    const go = repo(root2, { 'go.mod': 'module x\n', 'gen.go': '//go:generate stringer -type=Kind\npackage x\n' });
    assert.equal(codegen('detect', { repo: go.dir, claudeDir: go.claude }).json.command, 'go generate ./...');
    const root3 = tmp('codegen-'); t.after(() => rm(root3));
    const sqlc = repo(root3, { 'sqlc.yaml': 'version: "2"\n', 'query/a.sql': 'SELECT 1;\n' });
    const d = codegen('detect', { repo: sqlc.dir, claudeDir: sqlc.claude }).json;
    assert.deepEqual([d.command, d.inputs.length], ['sqlc generate', 2], 'the config and the queries are the inputs');
    const root4 = tmp('codegen-'); t.after(() => rm(root4));
    const buf = repo(root4, { 'buf.gen.yaml': 'version: v1\n', 'proto/a.proto': 'syntax = "proto3";\n' });
    assert.equal(codegen('detect', { repo: buf.dir, claudeDir: buf.claude }).json.command, 'buf generate');
  });

  it('says so plainly when a project generates nothing, and when the install turned the check off', (t) => {
    const root = tmp('codegen-'); t.after(() => rm(root));
    const plain = repo(root, { 'package.json': JSON.stringify({ name: 'web', scripts: { lint: 'eslint' } }) });
    const d = codegen('status', { repo: plain.dir, claudeDir: plain.claude });
    assert.deepEqual([d.code, d.json.command, d.json.stale, d.json.why], [0, null, false, 'nothing generated']);
    const root2 = tmp('codegen-'); t.after(() => rm(root2));
    const off = prismaRepo(root2, {}, { codegen: { enabled: false } });
    assert.equal(codegen('status', { repo: off.dir, claudeDir: off.claude }).json.command, null);
    const root3 = tmp('codegen-'); t.after(() => rm(root3));
    const custom = prismaRepo(root3, {}, { codegen: { command: 'make protos', inputs: ['prisma/schema.prisma'] } });
    const c = codegen('detect', { repo: custom.dir, claudeDir: custom.claude }).json;
    assert.deepEqual([c.command, c.source], ['make protos', 'tiers.json codegen.command'], 'the escape hatch wins over everything');
  });
});

describe('codegen.mjs status — behind, or current', () => {
  it('is stale while the output is missing, current after a run is marked, stale again when the schema changes', (t) => {
    const root = tmp('codegen-'); t.after(() => rm(root));
    const { dir, claude } = prismaRepo(root);
    const first = codegen('status', { repo: dir, claudeDir: claude });
    assert.equal(first.code, 1, 'exit 1: something must run');
    assert.match(first.json.why, /nothing generated yet: node_modules\/\.prisma\/client is missing/);

    // the generator ran: its output exists and the run is recorded
    mkdirSync(join(dir, 'node_modules', '.prisma', 'client'), { recursive: true });
    const marked = codegen('mark', { repo: dir, claudeDir: claude }).json;
    assert.equal(marked.marked, true);
    assert.ok(existsSync(join(claude, 'work', '_scratch', 'codegen', 'app.json')));
    const now = codegen('status', { repo: dir, claudeDir: claude });
    assert.deepEqual([now.code, now.json.stale], [0, false]);
    assert.match(now.json.why, /^current: generated from these inputs at /);

    // the schema moves ahead — the exact case that invented twenty-two lint errors
    writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'model Lead { id String @id }\nmodel Attendance { id String @id }\n');
    const stale = codegen('status', { repo: dir, claudeDir: claude });
    assert.deepEqual([stale.code, stale.json.stale], [1, true]);
    assert.match(stale.json.why, /the inputs changed since the last run \(1 file\(s\): prisma\/schema\.prisma\)/);
    codegen('mark', { repo: dir, claudeDir: claude });
    assert.equal(codegen('status', { repo: dir, claudeDir: claude }).code, 0);
  });

  it('judges by content, not mtimes: a fresh checkout of the same schema is current', (t) => {
    const root = tmp('codegen-'); t.after(() => rm(root));
    const { dir, claude } = prismaRepo(root);
    mkdirSync(join(dir, 'node_modules', '.prisma', 'client'), { recursive: true });
    codegen('mark', { repo: dir, claudeDir: claude });
    const body = readFileSync(join(dir, 'prisma', 'schema.prisma'), 'utf8');
    writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'model Lead { id String @id }\nmodel Tmp { id String @id }\n');
    writeFileSync(join(dir, 'prisma', 'schema.prisma'), body); // the file was rewritten: new mtime, same contents
    assert.equal(codegen('status', { repo: dir, claudeDir: claude }).code, 0, 'the same schema is the same schema');
  });

  it('a second repo has its own record — one marker per repo', (t) => {
    const root = tmp('codegen-'); t.after(() => rm(root));
    const a = prismaRepo(root);
    mkdirSync(join(a.dir, 'node_modules', '.prisma', 'client'), { recursive: true });
    codegen('mark', { repo: a.dir, claudeDir: a.claude });
    const b = join(root, 'other');
    mkdirSync(join(b, 'prisma'), { recursive: true });
    execFileSync('git', ['init', '-q', b]);
    writeFileSync(join(b, 'package.json'), JSON.stringify({ name: 'other', scripts: { generate: 'prisma generate' } }));
    writeFileSync(join(b, 'prisma', 'schema.prisma'), 'model B { id String @id }\n');
    assert.equal(codegen('status', { repo: b, claudeDir: a.claude }).code, 1, 'the other repo has no record of its own');
    assert.equal(codegen('status', { repo: a.dir, claudeDir: a.claude }).code, 0);
  });

  it('refuses a path that is not a checkout', () => {
    assert.equal(codegen('status', { repo: '/nope/nothing' }).code, 2);
    assert.equal(codegen('nonsense', { repo: '.' }).code, 2);
  });
});
