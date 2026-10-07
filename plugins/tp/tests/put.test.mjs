// `state.mjs put`: the one validated writer of a work directory's JSON — through the library and through the command.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, tmp, rm, readJson } from './helpers.mjs';
import { CliError, putArtifact, payloadText } from '../lib/state/index.mjs';
import { SCHEMA_DIR } from '../lib/contract/index.mjs';

const example = (name) => JSON.parse(readFileSync(join(SCHEMA_DIR, 'examples', `${name}.json`), 'utf8'));
const workdir = (t) => { const root = tmp(); t.after(() => rm(root)); const dir = join(root, 'work', 'T-1'); mkdirSync(dir, { recursive: true }); return dir; };
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const cli = (args, input) => { const r = spawnSync(process.execPath, [STATE, 'put', ...args], { encoding: 'utf8', input }); return { code: r.status, out: r.stdout, err: r.stderr }; };

describe('put — the library', () => {
  it('writes a valid document and stamps the schema version', (t) => {
    const dir = workdir(t);
    const { schemaVersion, ...doc } = example('plan');
    assert.deepEqual(putArtifact(dir, 'plan', doc), { file: 'plan.json', artifact: 'plan' });
    assert.equal(readJson(dir, 'plan.json').schemaVersion, 1);
    assert.equal(readJson(dir, 'plan.json').steps, doc.steps);
  });

  it('takes the JSON as text too, and the file name with its extension', (t) => {
    const dir = workdir(t);
    putArtifact(dir, 'triage.json', JSON.stringify(example('triage')));
    assert.equal(readJson(dir, 'triage.json').decision, 'plan');
  });

  it('a per-repo artifact takes the repo as a suffix', (t) => {
    const dir = workdir(t);
    assert.equal(putArtifact(dir, 'implement.shop-web', example('implement')).file, 'implement.shop-web.json');
    assert.ok(existsSync(join(dir, 'implement.shop-web.json')));
  });

  it('refuses a document that does not conform, with each error on a line, and writes nothing', (t) => {
    const dir = workdir(t);
    const e = refusal(() => putArtifact(dir, 'plan', { ...example('plan'), steps: [{ n: 1 }], complexity: 'epic' }));
    assert.ok(e instanceof CliError);
    assert.equal(e.code, 2);
    assert.match(e.message, /refused plan\.json: it does not match schemas\/plan\.schema\.json/);
    assert.match(e.message, /\n {2}\$\.steps: expected integer, got array/);
    assert.match(e.message, /\n {2}\$\.complexity: expected one of/);
    assert.match(e.message, /nothing was written/);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('a refused document leaves the one already there untouched', (t) => {
    const dir = workdir(t);
    putArtifact(dir, 'plan', example('plan'));
    const before = readFileSync(join(dir, 'plan.json'), 'utf8');
    assert.ok(refusal(() => putArtifact(dir, 'plan', { ...example('plan'), status: 'draft' })));
    assert.equal(readFileSync(join(dir, 'plan.json'), 'utf8'), before);
  });

  it('refuses a cross-field mistake the schema cannot see', (t) => {
    const dir = workdir(t);
    const e = refusal(() => putArtifact(dir, 'accept', { ...example('accept'), failed: 1 }));
    assert.match(e.message, /\$\.failed: 1 but 0 criteria have result "fail"/);
  });

  it('caps a long list of errors and says how many more there are', (t) => {
    const dir = workdir(t);
    const doc = example('accept');
    doc.criteria = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, text: 't', result: 'nope', evidence: 'e' }));
    const e = refusal(() => putArtifact(dir, 'accept', doc));
    assert.match(e.message, /… and \d+ more/);
  });

  it('refuses a name that is not an artifact, and a name that tries to leave the directory', (t) => {
    const dir = workdir(t);
    for (const name of ['notes', 'progress', '../plan', 'plan/x', 'pr-create', '', undefined]) {
      const e = refusal(() => putArtifact(dir, name, {}));
      assert.ok(e instanceof CliError && e.code === 2, `${name}`);
      assert.match(e.message, /is not an artifact/);
    }
    assert.deepEqual(readdirSync(dir), []);
  });

  it('refuses a folder that is not a ticket\'s work directory — the project root, a worktree, the work root itself', (t) => {
    const root = tmp(); t.after(() => rm(root));
    for (const dir of [root, join(root, 'work'), join(root, 'work', 'T-1', 'wt')]) {
      mkdirSync(dir, { recursive: true });
      const e = refusal(() => putArtifact(dir, 'plan', example('plan')));
      assert.match(e.message, /is not a ticket's work directory \(<\.claude>\/work\/<id>\)/, dir);
      assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')), [], 'nothing written there');
    }
  });

  it('refuses a folder that is not there, JSON that does not parse, and JSON that is not an object', (t) => {
    const dir = workdir(t);
    assert.match(refusal(() => putArtifact(join(dir, 'nowhere'), 'plan', {})).message, /is not a work directory/);
    assert.match(refusal(() => putArtifact(dir, 'plan', '{ nope')).message, /does not parse/);
    assert.match(refusal(() => putArtifact(dir, 'plan', '[1]')).message, /is a JSON object/);
    assert.match(refusal(() => putArtifact(dir, 'plan', 'null')).message, /is a JSON object/);
  });

  it('--merge lays the keys over the document that is there, then validates the whole', (t) => {
    const dir = workdir(t);
    putArtifact(dir, 'plan', example('plan'));
    putArtifact(dir, 'plan', { complexity: 'high' }, { merge: true });
    const plan = readJson(dir, 'plan.json');
    assert.deepEqual([plan.complexity, plan.steps, plan.schemaVersion], ['high', 3, 1]);
    assert.ok(refusal(() => putArtifact(dir, 'plan', { complexity: 'epic' }, { merge: true })));
    assert.equal(readJson(dir, 'plan.json').complexity, 'high');
  });

  it('--merge without a document to merge into says to put it whole first', (t) => {
    const dir = workdir(t);
    assert.match(refusal(() => putArtifact(dir, 'plan', { complexity: 'high' }, { merge: true })).message, /put it whole first/);
  });
});

describe('put — the payload\'s source', () => {
  it('an argument, a file, or nothing that can be read', (t) => {
    const dir = workdir(t);
    assert.equal(payloadText({ arg: '{"a":1}' }), '{"a":1}');
    const f = join(dir, 'in.json'); writeFileSync(f, '{"b":2}');
    assert.equal(payloadText({ from: f }), '{"b":2}');
    assert.match(refusal(() => payloadText({ from: join(dir, 'nope.json') })).message, /no such file/);
  });
});

describe('put — the command', () => {
  it('writes from an argument and prints one compact line', (t) => {
    const dir = workdir(t);
    const r = cli([dir, 'plan', JSON.stringify(example('plan'))]);
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), '{"file":"plan.json","artifact":"plan"}');
  });

  it('writes from standard input, so a document with quotes and line breaks needs no escaping', (t) => {
    const dir = workdir(t);
    const doc = { ...example('release'), followUps: [{ name: 'say "hi"\nthen go', status: 'done' }] };
    const r = cli([dir, 'release'], JSON.stringify(doc, null, 2));
    assert.equal(r.code, 0, r.err);
    assert.equal(readJson(dir, 'release.json').followUps[0].name, 'say "hi"\nthen go');
  });

  it('writes from a file with --from', (t) => {
    const dir = workdir(t);
    const f = join(dir, '..', 'draft.json'); writeFileSync(f, JSON.stringify(example('retro')));
    assert.equal(cli([dir, 'retro', '--from', f]).code, 0);
    assert.equal(readJson(dir, 'retro.json').proposals.length, 1);
  });

  it('--merge after the JSON, and --merge with the JSON on stdin', (t) => {
    const dir = workdir(t);
    assert.equal(cli([dir, 'plan', JSON.stringify(example('plan'))]).code, 0);
    assert.equal(cli([dir, 'plan', '{"complexity":"low"}', '--merge']).code, 0);
    assert.equal(readJson(dir, 'plan.json').complexity, 'low');
    assert.equal(cli([dir, 'plan', '--merge'], '{"complexity":"high"}').code, 0);
    assert.equal(readJson(dir, 'plan.json').complexity, 'high');
  });

  it('a refusal is exit 2 with the errors on stderr and nothing on stdout', (t) => {
    const dir = workdir(t);
    const r = cli([dir, 'plan', JSON.stringify({ ...example('plan'), steps: 'many' })]);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /\$\.steps: expected integer, got string/);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('is in the usage line', () => {
    const r = spawnSync(process.execPath, [STATE, 'nonsense'], { encoding: 'utf8' });
    assert.match(r.stderr, /\bput\b/);
  });
});
