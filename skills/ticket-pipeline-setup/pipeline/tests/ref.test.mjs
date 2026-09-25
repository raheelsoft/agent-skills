// ref.mjs — the README by reference (skills/README.md § Context management, rule 10): an agent gets the sections and
// items a skill names, never the whole file. These run against the real README, so a renamed heading fails here first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, CLAUDE_DIR } from './helpers.mjs';

const REF = join(CLAUDE_DIR, 'skills', '_lib', 'ref.mjs');
const ref = (...args) => { const r = spawnSync(process.execPath, [REF, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };

describe('ref.mjs — sections and items of the README', () => {
  it('prints one section by its heading text before the dash, and stops at the next heading', () => {
    const r = ref(CLAUDE_DIR, 'Worktrees');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^## § Worktrees\n\n### Worktrees/);
    assert.match(r.out, /one\*\* `git worktree` per repo/);
    assert.doesNotMatch(r.out, /### Concurrency/);
    assert.ok(r.out.length < 4000, `a section, not the file (${r.out.length} bytes)`);
  });

  it('prints a § Definitions bullet whole and nothing of its neighbours', () => {
    const r = ref(CLAUDE_DIR, 'Definitions, Resume');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^## § Definitions, Resume\n\n- \*\*Resume\*\* — one rule for every stage skill/);
    assert.match(r.out, /answers=retry/);
    assert.doesNotMatch(r.out, /\*\*Review verdicts\*\*/);
    assert.doesNotMatch(r.out, /\*\*Entry points\*\* —/);
    const several = ref(CLAUDE_DIR, 'Definitions, Dedicated agent, Output contract');
    assert.match(several.out, /## § Definitions, Dedicated agent[\s\S]*## § Definitions, Output contract/);
    assert.match(several.out, /at most ~15 lines/);
  });

  it('prints a numbered rule by "rule n" or "n"', () => {
    const r = ref(CLAUDE_DIR, 'Context management, rule 8');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^## § Context management, rule 8\n\n8\. \*\*Scope by stage/);
    assert.doesNotMatch(r.out, /9\. \*\*One job per agent/);
    assert.equal(ref(CLAUDE_DIR, 'Context management, 8').out, r.out);
  });

  it('prints a bold paragraph item with what follows it up to the next item', () => {
    const r = ref(CLAUDE_DIR, 'Models and budget, Estimates');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^## § Models and budget, Estimates\n\n\*\*Estimates — a person's hours/);
    assert.match(r.out, /minSamples/);
    assert.doesNotMatch(r.out, /\*\*Cost — what a ticket spent/);
    const table = ref(CLAUDE_DIR, 'Models and budget, Rating a task');
    assert.match(table.out, /\| Signal \| low \| medium \| high \|/, 'the table under the paragraph comes with it');
    const sched = ref(CLAUDE_DIR, 'Unattended runs, Scheduled runs');
    assert.match(sched.out, /\*\*Scheduled runs\.\*\* `\/tp-schedule on`/);
  });

  it('reaches sub-headings as items and as sections', () => {
    const a = ref(CLAUDE_DIR, 'Using it, Preflight');
    assert.match(a.out, /^## § Using it, Preflight\n\n### Preflight/);
    assert.doesNotMatch(a.out, /### End of day/);
    const b = ref(CLAUDE_DIR, 'Commits');
    assert.match(b.out, /^## § Commits\n\n#### Commits/);
    assert.equal(ref(CLAUDE_DIR, 'Shared procedures, Commits').out.split('\n').slice(2).join('\n'), b.out.split('\n').slice(2).join('\n'));
    const c = ref(CLAUDE_DIR, 'Review scope and rounds');
    assert.match(c.out, /judges \*\*the diff and nothing else\*\*/);
    assert.doesNotMatch(c.out, /#### Personal data/);
  });

  it('answers several queries in order, ignores a § prefix, and matches case-insensitively', () => {
    const r = ref(CLAUDE_DIR, '§ Stops and notifications', 'definitions, asking the user');
    assert.equal(r.code, 0, r.err);
    const i = r.out.indexOf('## § Stops and notifications'), j = r.out.indexOf('## § Definitions, asking the user');
    assert.ok(i >= 0 && j > i);
  });

  it('lists the contents, and prints them with exit 1 when a name matches nothing', () => {
    const list = ref(CLAUDE_DIR, 'list');
    assert.equal(list.code, 0);
    assert.match(list.out, /^The problem it solves( — .*)?\n/);
    assert.match(list.out, /\n  Definitions — conventions file · tracker/);
    assert.match(list.out, /\n  Context management — rule 1 · rule 2/);
    const miss = ref(CLAUDE_DIR, 'Worktrees', 'Nothing like this');
    assert.equal(miss.code, 1);
    assert.match(miss.out, /## § Worktrees/);
    assert.match(miss.out, /\(no section matches "Nothing like this"\)/);
    assert.match(miss.out, /## contents/);
    const missItem = ref(CLAUDE_DIR, 'Definitions, Nothing');
    assert.equal(missItem.code, 1);
    assert.match(missItem.out, /no item "Nothing" in § Definitions/);
    assert.equal(ref(CLAUDE_DIR).code, 2, 'usage');
  });

  it('reads any markdown file given directly', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const f = join(root, 'doc.md');
    writeFileSync(f, '# T\n\n## A — first\n\n- **One** — x\n  more\n- **Two** — y\n\n1. **Rule** text\n\n## B\n\n**Para.** body\n\ncontinues\n');
    assert.equal(ref(f, 'A, One').out, '## § A, One\n\n- **One** — x\n  more\n');
    assert.match(ref(f, 'A, rule 1').out, /1\. \*\*Rule\*\* text/);
    assert.match(ref(f, 'B, Para').out, /\*\*Para\.\*\* body\n\ncontinues/);
  });
});
