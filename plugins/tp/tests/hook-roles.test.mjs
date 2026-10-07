// The role agents (agents/*.md) are held to their jobs by the bash and write hooks, which read the payload's agent_type: a verifier reads the
// repositories and changes nothing in them, and writes the one file its job produces.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, tmp, rm, writeJson } from './helpers.mjs';
import { run } from '../hooks/run.mjs';
import { ROLES } from '../hooks/roles.mjs';

const LIB = join(PLUGIN_ROOT, 'lib');
function project(t) {
  const root = tmp(); t.after(() => rm(root));
  const claude = join(root, '.claude');
  const wd = join(claude, 'work', 'T-1'); const wt = join(wd, 'wt', 'shop');
  mkdirSync(wt, { recursive: true }); mkdirSync(join(claude, 'work', '_scratch'), { recursive: true });
  writeJson(claude, 'tiers.json', { ceiling: 'sonnet', ladder: ['haiku', 'sonnet', 'opus'], low: 'haiku', medium: 'sonnet', high: 'sonnet' });
  return { root, claude, work: join(claude, 'work'), wd, wt, env: { CLAUDE_PROJECT_DIR: root } };
}
const call = (handler, p, role, tool_name, tool_input, extra = {}) => run(handler, JSON.stringify({ session_id: 's', cwd: p.root, hook_event_name: 'PreToolUse', tool_name, tool_input, agent_id: 'a1', agent_type: role, ...extra }), p.env);
const bash = (p, role, command, extra) => call('bash', p, role, 'Bash', { command }, extra);
const write = (p, role, file, tool = 'Write') => call('write', p, role, tool, { file_path: file, content: 'x' });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const why = (out) => out?.hookSpecificOutput?.permissionDecisionReason || '';

describe('role policy — git is read-only for a verifier', () => {
  const READ = ['git status', 'git diff origin/main...HEAD', 'git -C /r log -3 --oneline', 'git show HEAD:src/a.ts', 'git rev-parse HEAD', 'git ls-files src', 'git blame -L1,5 a.ts', 'git grep -n foo', 'git merge-base HEAD main', 'git fetch origin',
    'git branch --show-current', 'git branch -a', 'git branch --contains abc123', 'git remote -v', 'git remote get-url origin', 'git config --get remote.origin.url', 'git stash list', 'git tag -l', 'git worktree list'];
  const WRITE = ['git commit -am x', 'git add .', 'git checkout main', 'git switch -c x', 'git reset --hard', 'git clean -fd', 'git stash', 'git branch newbranch', 'git branch -D x', 'git remote add up git@h:x/y.git', 'git config user.name x', 'git merge main', 'git rebase main', 'git cherry-pick abc', 'git apply p.diff', 'git push origin x', 'git rm a.ts', 'git tag v1', 'git worktree add /x HEAD'];
  for (const command of READ) it(`lets ${command} through`, async (t) => {
    const p = project(t);
    for (const role of Object.keys(ROLES)) assert.equal(denied(await bash(p, role, command)), false, `${role}: ${command}`);
  });
  for (const command of WRITE) {
    it(`refuses ${command} to the plan checker`, async (t) => {
      const out = await bash(project(t), 'tp:plan-checker', command);
      assert.equal(denied(out), true, command);
      assert.match(why(out), /the plan checker reads the repositories and changes nothing in them/);
    });
  }

  it('the reviewer, and only the reviewer, may keep a checkout of its own', async (t) => {
    const p = project(t);
    const add = `git worktree add ${p.work}/_scratch/wt/review-shop HEAD`;
    assert.equal(denied(await bash(p, 'tp:reviewer', add)), false);
    assert.equal(denied(await bash(p, 'tp:reviewer', `git worktree remove ${p.work}/_scratch/wt/review-shop`)), false);
    assert.equal(denied(await bash(p, 'tp:plan-checker', add)), true);
    assert.equal(denied(await bash(p, 'tp:diff-validator', add)), true);
    assert.equal(denied(await bash(p, 'tp:reviewer', 'git commit -am x')), true, 'but it commits nothing');
  });

  it('a git inside bash -c, behind an assignment or a pipe, is still git', async (t) => {
    const p = project(t);
    assert.equal(denied(await bash(p, 'tp:plan-checker', "bash -c 'git commit -am x'")), true);
    assert.equal(denied(await bash(p, 'tp:plan-checker', 'FOO=1 git add .')), true);
    assert.equal(denied(await bash(p, 'tp:plan-checker', 'git diff | head -3 && git add .')), true);
  });
});

describe('role policy — what a verifier may write', () => {
  it('the plan checker writes plan-check.json (through put) and its checkpoint, temporary files, and nothing else', async (t) => {
    const p = project(t);
    const R = 'tp:plan-checker';
    for (const command of [`echo x > /tmp/out.txt`, `echo x > ${p.wd}/checkpoint.plan-check.md`, `node ${LIB}/state.mjs put ${p.wd} plan-check --from /tmp/x.json`, `cat ${p.wd}/plan.md`, `grep -n foo ${p.wd}/plan.md > /dev/null`, `cp ${p.wd}/plan.md /tmp/copy.md`]) assert.equal(denied(await bash(p, R, command)), false, command);
    for (const [command, shown] of [
      [`echo x > ${p.wt}/src/a.ts`, 'src/a.ts'], [`sed -i s/a/b/ ${p.wt}/src/a.ts`, 'src/a.ts'], [`echo x >> ${p.wd}/plan.md`, 'plan.md'], [`cat > ${p.wd}/answers.md`, 'answers.md'],
      [`rm ${p.wd}/plan.md`, 'plan.md'], [`mv /tmp/x ${p.wd}/plan.md`, 'plan.md'], [`mv ${p.wd}/plan.md /tmp/x`, 'plan.md'], [`tee /opt/elsewhere/notes.txt < /dev/null`, 'notes.txt'], [`echo x > "$HOME/x"`, '$HOME'],
    ]) {
      const out = await bash(p, R, command);
      assert.equal(denied(out), true, command);
      assert.match(why(out), /the plan checker writes only plan-check\.json \(through state\.mjs put\) and its checkpoint/);
      assert.ok(why(out).includes(shown), `names ${shown}`);
    }
  });

  it('a temporary file is fine outside a git checkout, and not inside one', async (t) => {
    const p = project(t);
    const scratch = join(p.root, 'tmp-out'); mkdirSync(scratch, { recursive: true });
    assert.equal(denied(await bash(p, 'tp:plan-checker', `echo x > ${scratch}/o.txt`)), false, 'tmp, no checkout');
    mkdirSync(join(scratch, 'co', '.git'), { recursive: true });
    assert.equal(denied(await bash(p, 'tp:plan-checker', `echo x > ${scratch}/co/src.ts`)), true, 'tmp, but inside a checkout');
  });

  it('the researcher writes research.json (through put) and its checkpoint, and nothing else', async (t) => {
    const p = project(t); const R = 'tp:researcher';
    assert.equal(denied(await bash(p, R, `node ${LIB}/state.mjs put ${p.wd} research --from /tmp/r.json`)), false);
    assert.equal(denied(await write(p, R, join(p.wd, 'checkpoint.research.md'))), false);
    assert.equal(denied(await write(p, R, join(p.wd, 'research.json'))), true, 'research.json is put, never written');
    for (const file of [join(p.wd, 'plan.md'), join(p.wd, 'triage.json'), join(p.wt, 'src', 'a.ts')]) assert.equal(denied(await write(p, R, file)), true, file);
    assert.match(why(await bash(p, R, `echo x > ${p.wt}/src/a.ts`)), /the researcher writes only research\.json/);
    assert.equal(denied(await bash(p, R, 'git commit -am x')), true);
  });

  it('the diff validator writes diff-validation.md and its checkpoint', async (t) => {
    const p = project(t); const R = 'tp:diff-validator';
    assert.equal(denied(await bash(p, R, `cat > ${p.wd}/diff-validation.md`)), false);
    assert.equal(denied(await bash(p, R, `cat > ${p.wd}/checkpoint.create-pr.shop.md`)), false);
    assert.equal(denied(await bash(p, R, `cat > ${p.wd}/plan-check.json`)), true);
    assert.equal(denied(await bash(p, R, `cat > ${p.wd}/diff-validation.json`)), true);
  });

  it('the reviewer writes under _scratch/ and nowhere else in the work directory', async (t) => {
    const p = project(t); const R = 'tp:reviewer';
    assert.equal(denied(await bash(p, R, `cat > ${p.work}/_scratch/review-shop--12.md`)), false);
    assert.equal(denied(await bash(p, R, `cat > ${p.wd}/report.md`)), true);
    assert.equal(denied(await bash(p, R, `cat > ${p.wt}/src/a.ts`)), true);
  });

  it('the file tools: the same rule for Write, Edit and MultiEdit, and a notebook is never theirs', async (t) => {
    const p = project(t);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      assert.equal(denied(await write(p, 'tp:plan-checker', join(p.wd, 'checkpoint.plan-check.md'), tool)), false, tool);
      const out = await write(p, 'tp:plan-checker', join(p.wd, 'plan.md'), tool);
      assert.equal(denied(out), true, tool);
      assert.match(why(out), /the plan checker writes only plan-check\.json/);
      assert.equal(denied(await write(p, 'tp:plan-checker', join(p.wt, 'src', 'a.ts'), tool)), true, tool);
    }
    assert.equal(denied(await write(p, 'tp:plan-checker', '/tmp/scratch.txt')), false);
    assert.equal(denied(await call('write', p, 'tp:plan-checker', 'NotebookEdit', { notebook_path: join(p.wt, 'n.ipynb'), new_source: 'x' })), true);
  });

  it('the raw-write guard still applies on top: plan-check.json is put, never written', async (t) => {
    const p = project(t);
    const out = await write(p, 'tp:plan-checker', join(p.wd, 'plan-check.json'));
    assert.equal(denied(out), true);
    assert.match(why(out), /state\.mjs put .* plan-check/);
  });
});

describe('role policy — pull requests are reported on, not acted on', () => {
  it('no verifier merges, closes, edits, readies, reopens or reviews a PR; commenting and reading are theirs', async (t) => {
    const p = project(t);
    for (const sub of ['merge', 'close', 'edit', 'ready', 'reopen', 'review']) {
      const out = await bash(p, 'tp:reviewer', `gh pr ${sub} 12`);
      assert.equal(denied(out), true, sub);
      assert.match(why(out), /reports, it does not act on a pull request/);
    }
    for (const command of ['gh pr view 12 --json title', 'gh pr diff 12', 'gh pr checks 12', 'gh pr comment 12 --body-file /tmp/r.md', 'gh api repos/x/y/pulls/12/comments']) assert.equal(denied(await bash(p, 'tp:reviewer', command)), false, command);
  });
});

describe('role policy — who it applies to', () => {
  it('only the plugin\'s role agents: the main session and any other agent type are unaffected', async (t) => {
    const p = project(t);
    const command = `git commit -am x && echo x > ${p.wt}/src/a.ts`;
    assert.equal(denied(await bash(p, 'tp:plan-checker', command)), true);
    assert.equal(denied(await bash(p, 'general-purpose', command)), false);
    assert.equal(denied(await bash(p, 'tp:lead', command)), false);
    assert.equal(denied(await run('bash', JSON.stringify({ session_id: 's', cwd: p.root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), p.env)), false, 'the main session');
  });

  it('only in a project that ran /tp:setup', async (t) => {
    const p = project(t);
    rm(join(p.claude, 'tiers.json'));
    assert.equal(denied(await bash(p, 'tp:plan-checker', 'git commit -am x')), false);
  });

  it('every role has a definition in agents/', async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(join(PLUGIN_ROOT, 'agents')).map((f) => `tp:${f.replace(/\.md$/, '')}`).sort();
    assert.deepEqual(Object.keys(ROLES).sort(), files.filter((f) => f !== 'tp:implementer'), 'the verifiers: held to their jobs; the implementer writes the change');
  });
});
