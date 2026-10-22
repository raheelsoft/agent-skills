// state.mjs doc — the one writer of the work directory's documents — and the paths an agent may write instead. The runtime refuses an agent's
// file tool, redirect or mkdir under <.claude>/, so a document reaches the work directory through this script and an agent's own files
// (checkouts, command output, drafts) live under <.claude>/worktrees/.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmp, rm, state, STATE, pickedUp } from './helpers.mjs';
import { writeDoc } from '../lib/state/doc.mjs';
import { claudeOf, outDir, ticketWorktrees, worktreesOnDisk, worktreesRoot } from '../lib/state/paths.mjs';

/** `<root>/work` is a fake <.claude>/work. */
function bed(t) {
  const root = tmp(); t.after(() => rm(root));
  const work = join(root, 'work'); mkdirSync(work, { recursive: true });
  return { root, work, wd: join(work, 'T-1') };
}
const doc = (stdin, ...args) => {
  const r = spawnSync(process.execPath, [STATE, 'doc', ...args], { encoding: 'utf8', input: stdin });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* a refusal prints nothing parseable */ }
  return { code: r.status, stderr: r.stderr, json };
};

describe('state.mjs doc — writing a document', () => {
  it('a ticket\'s work directory begins with its ticket.md, and the text comes from stdin', (t) => {
    const { wd } = bed(t);
    const r = doc('# T-1\n\nthe ticket\n', wd, 'ticket.md');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { file: 'T-1/ticket.md', bytes: 18, mode: 'write' });
    assert.equal(readFileSync(join(wd, 'ticket.md'), 'utf8'), '# T-1\n\nthe ticket\n');
  });

  it('replaces by default, appends with --append, and puts a newline between a file that lacked one and what follows', (t) => {
    const { wd } = bed(t);
    doc('first', wd, 'ticket.md');
    doc('plan v1\n', wd, 'plan.md');
    doc('plan v2\n', wd, 'plan.md');
    assert.equal(readFileSync(join(wd, 'plan.md'), 'utf8'), 'plan v2\n');
    writeFileSync(join(wd, 'report.md'), 'no newline at the end');
    const r = doc('## Merged\n', wd, 'report.md', '--append');
    assert.equal(r.json.mode, 'append');
    assert.equal(readFileSync(join(wd, 'report.md'), 'utf8'), 'no newline at the end\n## Merged\n');
    doc('## Accepted\n', wd, 'report.md', '--append');
    assert.equal(readFileSync(join(wd, 'report.md'), 'utf8'), 'no newline at the end\n## Merged\n## Accepted\n');
  });

  it('takes the text from a file with --from, and leaves no temporary file behind', (t) => {
    const { root, wd } = bed(t);
    doc('x', wd, 'ticket.md');
    const draft = join(root, 'draft.md'); writeFileSync(draft, '# the plan\n');
    const r = doc('', wd, 'plan.md', '--from', draft);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(wd, 'plan.md'), 'utf8'), '# the plan\n');
    assert.deepEqual(readdirSync(wd).sort(), ['plan.md', 'ticket.md']);
    assert.equal(doc('', wd, 'plan.md', '--from', join(root, 'missing.md')).code, 2);
  });

  it('creates a ticket\'s directory for its ticket.md only, and _scratch and _day for anything', (t) => {
    const { work, wd } = bed(t);
    const r = doc('x', wd, 'plan.md');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /begins with its ticket\.md/);
    assert.equal(existsSync(wd), false, 'a typo does not make a ticket');
    assert.equal(doc('x', join(work, '_scratch'), 'review-x.md').code, 0);
    assert.equal(doc('x', join(work, '_day'), '2026-10-08.eod.md').code, 0);
  });

  it('takes JSON into _scratch and _day only, and only JSON that parses', (t) => {
    const { work, wd } = bed(t);
    doc('x', wd, 'ticket.md');
    assert.equal(doc('{"id":"eod:2026-10-08"}', join(work, '_scratch'), 'eod-2026-10-08.stop.json').code, 0);
    const bad = doc('{nope', join(work, '_scratch'), 'x.json');
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /not valid JSON/);
    const ticketJson = doc('{}', wd, 'triage.json');
    assert.equal(ticketJson.code, 2);
    assert.match(ticketJson.stderr, /state\.mjs put/);
    assert.match(doc('{}', join(work, '_scratch'), 'x.json', '--append').stderr, /written whole/);
  });

  it('refuses what a script owns: progress.md, the _office and _inbox folders, a folder that is not under work/', (t) => {
    const { root, work, wd } = bed(t);
    doc('x', wd, 'ticket.md');
    assert.match(doc('x', wd, 'progress.md').stderr, /state\.mjs log/);
    assert.match(doc('x', join(work, '_office'), 'a.md').stderr, /state script alone/);
    assert.match(doc('x', join(work, '_inbox'), 'a.md').stderr, /state script alone/);
    assert.match(doc('x', join(root, 'elsewhere'), 'a.md').stderr, /is not a ticket's work directory/);
    assert.equal(existsSync(join(root, 'elsewhere')), false);
  });

  it('a name with no extension is a markdown document', (t) => {
    const { wd } = bed(t);
    assert.equal(doc('x', wd, 'ticket').json.file, 'T-1/ticket.md');
    assert.equal(doc('x', wd, 'plan').json.file, 'T-1/plan.md');
    assert.equal(existsSync(join(wd, 'plan.md')), true);
  });

  it('refuses a name that is not a plain document name, empty text, and a lot of text', (t) => {
    const { wd } = bed(t);
    doc('x', wd, 'ticket.md');
    for (const name of ['../plan.md', 'a/b.md', 'plan.sh', '.hidden.md', 'plan.md.tmp', '']) assert.equal(doc('x', wd, name).code, 2, `"${name}"`);
    assert.match(doc('   \n', wd, 'plan.md').stderr, /empty/);
    assert.equal(doc('x'.repeat(2_000_001), wd, 'plan.md').code, 2);
    assert.equal(existsSync(join(wd, 'plan.md')), false, 'nothing was written');
  });

  it('a document written here is read by the rest of the state script as before', (t) => {
    const { root } = bed(t);
    const wd = pickedUp(root);
    assert.equal(doc('# plan\n', wd, 'plan.md').code, 0);
    assert.equal(state('state', wd).code, 0);
    assert.equal(writeDoc(wd, 'report.md', 'shipped').mode, 'write', 'and the library does the same without a process');
  });
});

describe('where an agent may write', () => {
  it('names the exempt folder: worktrees, one folder per ticket, one for command output', () => {
    const claude = '/p/.claude';
    assert.equal(claudeOf('/p/.claude/work/T-1'), claude);
    assert.equal(worktreesRoot(claude), '/p/.claude/worktrees');
    assert.equal(ticketWorktrees(claude, 'T-1'), '/p/.claude/worktrees/T-1');
    assert.equal(outDir(claude), '/p/.claude/worktrees/_out');
  });

  it('lists a ticket\'s worktrees from the new folder and from the wt/ an earlier pickup made', (t) => {
    const { work, root } = bed(t);
    const wd = join(work, 'T-1'); mkdirSync(wd, { recursive: true });
    assert.deepEqual(worktreesOnDisk(wd), []);
    mkdirSync(join(root, 'worktrees', 'T-1', 'shop-web'), { recursive: true });
    mkdirSync(join(wd, 'wt', 'shop-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'T-2', 'other'), { recursive: true });
    mkdirSync(join(root, 'worktrees', '_out'), { recursive: true });
    assert.deepEqual(worktreesOnDisk(wd), ['shop-api', 'shop-web'], 'both layouts, this ticket\'s only, no _out');
  });

  it('shows in the state a ticket reports (status, the doctor and the office read it there)', (t) => {
    const { root } = bed(t);
    const wd = pickedUp(root);
    mkdirSync(join(root, 'worktrees', 'T-1', 'shop'), { recursive: true });
    assert.deepEqual(state('state', wd).json.worktrees, ['shop']);
  });
});
