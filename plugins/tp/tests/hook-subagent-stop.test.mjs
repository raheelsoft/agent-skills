// The SubagentStop gate for the role agents: a contract that must hold before the agent may stop, bounded to two sends back, reading files only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PLUGIN_ROOT, tmp, rm, writeJson, ticket, progress, gitRepoWithWorktree } from './helpers.mjs';
import { run } from '../hooks/run.mjs';
import { CONTRACTS, MAX_BLOCKS, outputProblem, spawnOf, workdirIn } from '../hooks/handlers/subagent-stop.mjs';
import { SCHEMA_DIR } from '../lib/contract/index.mjs';
import { parseProgress } from '../lib/state/index.mjs';

const fixture = (name) => JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'hooks', `${name}.json`), 'utf8'));
const example = (name) => JSON.parse(readFileSync(join(SCHEMA_DIR, 'examples', `${name}.json`), 'utf8'));
const CONTRACT_LINES = 'complexity: as rated\ncontinue: no';

/** A project with one ticket's work directory, and a function that stops an agent of `type` whose spawn prompt names it. */
function bed(t) {
  const root = tmp(); t.after(() => rm(root));
  const claude = join(root, '.claude'); const wd = join(claude, 'work', 'T-1');
  mkdirSync(wd, { recursive: true });
  writeJson(claude, 'tiers.json', { ceiling: 'sonnet', ladder: ['haiku', 'sonnet', 'opus'], low: 'haiku', medium: 'sonnet', high: 'sonnet' });
  ticket(wd, [{ name: 'shop' }], { id: 'T-1' });
  progress(wd, [['2026-01-01T10:00Z', 'start-ticket', 'started'], ['2026-01-01T10:05Z', 'start-ticket', 'done', 'x'], ['2026-01-01T10:06Z', 'plan-check', 'started']]);
  const started = Date.now() - 60000;
  let n = 0;
  const transcript = (prompt) => {
    const file = join(root, `agent-${++n}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: prompt }, timestamp: new Date(started).toISOString() }) + '\n{"type":"assistant"}\n');
    return file;
  };
  const stop = (type, message, { prompt = `Work directory: ${wd}. Check the plan.`, id = 'a1', extra = {} } = {}) => run('subagent-stop', JSON.stringify({ ...fixture('subagent-stop'), agent_id: id, agent_type: type, last_assistant_message: message, agent_transcript_path: transcript(prompt), ...extra }), { CLAUDE_PROJECT_DIR: root });
  const fresh = (file, ms = Date.now()) => utimesSync(file, new Date(ms), new Date(ms));
  return { root, claude, wd, started, stop, fresh, gates: () => (existsSync(join(claude, 'work', '_gates')) ? readdirSync(join(claude, 'work', '_gates')) : []) };
}
const good = (b) => writeFileSync(join(b.wd, 'plan-check.json'), JSON.stringify(example('plan-check')));

describe('outputProblem — the output contract', () => {
  it('a reply ends with the two lines, or opens with error:', () => {
    assert.equal(outputProblem(`Verdict: ok.\n${CONTRACT_LINES}`), null);
    assert.equal(outputProblem('complexity: higher — a second repo\ncontinue: .claude/work/T-1/checkpoint.plan-check.md'), null);
    assert.equal(outputProblem('error: the repo is not there\ntried: x\nneeds: none'), null);
    assert.equal(outputProblem('Error: the repo is not there'), null);
  });

  it('anything else is a problem that says what to add', () => {
    for (const reply of ['', '   \n  ', 'All done.', 'complexity: as rated', `continue: no\ncomplexity: as rated`, 'complexity: as rated\ncontinue:', 'the continue: no\nline']) assert.match(outputProblem(reply) || '', /must end with the two lines|empty/, JSON.stringify(reply));
  });
});

describe('the gate — a plan checker', () => {
  it('lets it stop when plan-check.json is valid and this pass wrote it, and the reply closes as the contract says', async (t) => {
    const b = bed(t); good(b);
    assert.equal(await b.stop('tp:plan-checker', `ok — 0 blocking.\n${CONTRACT_LINES}`), null);
    assert.deepEqual(b.gates(), []);
  });

  it('sends it back when the file is missing, naming the file and the command, in under 300 characters', async (t) => {
    const b = bed(t);
    const out = await b.stop('tp:plan-checker', `ok.\n${CONTRACT_LINES}`);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /^tp: before you stop — plan-check\.json is not in the work directory\. Write it with `state\.mjs put <workdir> plan-check …`, then finish\.$/);
    assert.ok(out.reason.length < 300);
  });

  it('sends it back when the file does not match its schema, with the first errors', async (t) => {
    const b = bed(t);
    writeFileSync(join(b.wd, 'plan-check.json'), JSON.stringify({ ...example('plan-check'), verdict: 'maybe' }));
    const out = await b.stop('tp:plan-checker', `x\n${CONTRACT_LINES}`);
    assert.match(out.reason, /plan-check\.json does not match its schema: \$\.verdict: expected one of "ok" \| "revise"/);
  });

  it('sends it back when the file is the one from before it started', async (t) => {
    const b = bed(t); good(b);
    b.fresh(join(b.wd, 'plan-check.json'), b.started - 3600000);
    assert.match((await b.stop('tp:plan-checker', `x\n${CONTRACT_LINES}`)).reason, /the one from before you started/);
  });

  it('sends it back when the reply does not close with the contract lines, and names both problems at once', async (t) => {
    const b = bed(t);
    const out = await b.stop('tp:plan-checker', 'All good, no findings.');
    assert.match(out.reason, /must end with the two lines/);
    assert.match(out.reason, /plan-check\.json is not in the work directory/);
  });

  it('the error form is a legitimate end, with the file or without: a failure that could not be resolved owes no artifact', async (t) => {
    const b = bed(t);
    assert.equal(await b.stop('tp:plan-checker', 'error: no worktree\nneeds: none'), null);
    good(b);
    assert.equal(await b.stop('tp:plan-checker', 'error: could not read two files\nneeds: none', { id: 'e2' }), null);
  });

  it('a checkpoint hand-off is not done either: it owes its closing lines, not the artifact', async (t) => {
    const b = bed(t);
    assert.equal(await b.stop('tp:plan-checker', 'Checkpointed after step 4.\ncomplexity: as rated\ncontinue: .claude/work/T-1/checkpoint.plan-check.md'), null);
    assert.match((await b.stop('tp:plan-checker', 'Checkpointed.\ncontinue: .claude/work/T-1/checkpoint.plan-check.md', { id: 'c2' })).reason, /must end with the two lines/);
  });
});

describe('the gate — bounded', () => {
  it('sends an agent back twice, then lets it stop and records an error stop on the ticket', async (t) => {
    const b = bed(t);
    for (let n = 1; n <= MAX_BLOCKS; n++) {
      assert.equal((await b.stop('tp:plan-checker', CONTRACT_LINES, { id: 'agent-x' })).decision, 'block', `send-back ${n}`);
      assert.equal(JSON.parse(readFileSync(join(b.claude, 'work', '_gates', 'agent-x.json'), 'utf8')).blocks, n);
    }
    assert.equal(await b.stop('tp:plan-checker', CONTRACT_LINES, { id: 'agent-x' }), null, 'past the bound it stops');
    assert.deepEqual(b.gates(), [], 'the counter is cleared');
    const rows = parseProgress(b.wd).rows ?? parseProgress(b.wd);
    const last = (Array.isArray(rows) ? rows : []).slice(-1)[0];
    assert.deepEqual([last?.stage, last?.event], ['plan-check', 'stopped']);
    assert.match(last.summary, /^error: contract violation — the plan-checker stopped without: plan-check\.json is not in the work directory/);
  });

  it('counts each agent on its own, and a pass that fixes the contract clears its count', async (t) => {
    const b = bed(t);
    await b.stop('tp:plan-checker', CONTRACT_LINES, { id: 'one' });
    await b.stop('tp:plan-checker', CONTRACT_LINES, { id: 'two' });
    assert.deepEqual(b.gates().sort(), ['one.json', 'two.json']);
    good(b);
    assert.equal(await b.stop('tp:plan-checker', CONTRACT_LINES, { id: 'one' }), null);
    assert.deepEqual(b.gates(), ['two.json']);
  });

  it('a hook that must not loop: stop_hook_active changes nothing, the counter is the bound', async (t) => {
    const b = bed(t);
    for (let n = 0; n < MAX_BLOCKS; n++) await b.stop('tp:plan-checker', CONTRACT_LINES, { id: 'y', extra: { stop_hook_active: true } });
    assert.equal(await b.stop('tp:plan-checker', CONTRACT_LINES, { id: 'y', extra: { stop_hook_active: true } }), null);
  });
});

describe('the gate — the other roles', () => {
  it('the diff validator owes diff-validation.md, non-empty', async (t) => {
    const b = bed(t);
    const prompt = `Repo /r. Intent: x. Write the table to ${b.wd}/diff-validation.md.`;
    assert.match((await b.stop('tp:diff-validator', `1 unexpected.\n${CONTRACT_LINES}`, { prompt })).reason, /diff-validation\.md is not in the work directory\. Write the per-file table to <workdir>\/diff-validation\.md/);
    writeFileSync(join(b.wd, 'diff-validation.md'), '');
    assert.match((await b.stop('tp:diff-validator', `1 unexpected.\n${CONTRACT_LINES}`, { prompt, id: 'a2' })).reason, /diff-validation\.md is empty/);
    writeFileSync(join(b.wd, 'diff-validation.md'), '| file | verdict |\n');
    assert.equal(await b.stop('tp:diff-validator', `1 unexpected.\n${CONTRACT_LINES}`, { prompt, id: 'a3' }), null);
  });

  const REVIEW = '## Review Summary\n\n**Verdict:** PASS WITH WARNINGS\n**Confidence:** 4/5\n\nReviewed: 3f9c2ab · round 1 · open: none · new: 1, 2\n';
  it('the reviewer owes the verdict line and the trailer', async (t) => {
    const b = bed(t);
    assert.equal(await b.stop('tp:reviewer', `${REVIEW}${CONTRACT_LINES}`), null);
    assert.match((await b.stop('tp:reviewer', `Looks fine.\n${CONTRACT_LINES}`, { id: 'r2' })).reason, /no `\*\*Verdict:\*\* PASS \| PASS WITH WARNINGS \| BLOCK` line/);
    assert.match((await b.stop('tp:reviewer', `**Verdict:** PASS\n${CONTRACT_LINES}`, { id: 'r3' })).reason, /no `Reviewed: <sha> · round <n> · open: … · new: …` trailer/);
  });

  it('the reviewer may hand off at a checkpoint or report an error without a verdict', async (t) => {
    const b = bed(t);
    assert.equal(await b.stop('tp:reviewer', 'Checkpointed at step 3.\ncomplexity: as rated\ncontinue: .claude/work/_scratch/review-x.md'), null);
    assert.equal(await b.stop('tp:reviewer', 'error: the PR is not reachable\nneeds: log in'), null);
  });
});

describe('the gate — the researcher', () => {
  const research = { schemaVersion: 1, questions: ['q'], precedent: null, findings: [{ id: 'RS1', claim: 'c', confidence: 'high', sources: [{ kind: 'code', ref: 'a.ts:1' }] }], unknowns: [], confidence: 'high' };
  it('owes a valid research.json written this pass', async (t) => {
    const b = bed(t);
    assert.match((await b.stop('tp:researcher', CONTRACT_LINES)).reason, /research\.json is not in the work directory\. Write it with `state\.mjs put <workdir> research …`, then finish\./);
    writeFileSync(join(b.wd, 'research.json'), JSON.stringify({ ...research, findings: [{ ...research.findings[0], sources: [] }] }));
    assert.match((await b.stop('tp:researcher', CONTRACT_LINES, { id: 'r2' })).reason, /research\.json does not match its schema: \$\.findings\[0\]\.sources: needs at least 1 item/);
    writeFileSync(join(b.wd, 'research.json'), JSON.stringify(research));
    assert.equal(await b.stop('tp:researcher', CONTRACT_LINES, { id: 'r3' }), null);
  });
});

describe('the gate — what it leaves alone', () => {
  it('other agent types, a project that never ran /tp:setup, an agent with no id', async (t) => {
    const b = bed(t);
    for (const type of ['general-purpose', 'tp:lead', 'tp:unknown', undefined]) assert.equal(await b.stop(type, 'no contract lines'), null, String(type));
    assert.equal(await b.stop('tp:plan-checker', 'no contract lines', { extra: { agent_id: undefined } }), null);
    rm(join(b.claude, 'tiers.json'));
    assert.equal(await b.stop('tp:plan-checker', 'no contract lines'), null);
  });

  it('a spawn prompt that names no work directory: the reply is still checked, the file cannot be', async (t) => {
    const b = bed(t);
    assert.equal(await b.stop('tp:plan-checker', CONTRACT_LINES, { prompt: 'Check the plan.' }), null, 'no directory to look in: fail open');
    assert.match((await b.stop('tp:plan-checker', 'nothing', { prompt: 'Check the plan.', id: 'b2' })).reason, /must end with the two lines/);
  });

  it('a transcript that is not there or not readable', async (t) => {
    const b = bed(t);
    const out = await run('subagent-stop', JSON.stringify({ ...fixture('subagent-stop'), agent_id: 'z', agent_type: 'tp:plan-checker', last_assistant_message: CONTRACT_LINES, agent_transcript_path: join(b.root, 'nowhere.jsonl') }), { CLAUDE_PROJECT_DIR: b.root });
    assert.equal(out, null);
  });
});

describe('finding the work directory in a spawn prompt', () => {
  it('reads the one directory the prompt names, past punctuation, and ignores the pipeline\'s own folders', (t) => {
    const b = bed(t);
    const ctx = { claudeDir: b.claude };
    mkdirSync(join(b.claude, 'work', '_scratch'), { recursive: true });
    assert.equal(workdirIn(`Work directory: ${b.wd}.`, ctx), b.wd);
    assert.equal(workdirIn(`dirs: "${b.wd}/plan.md" and ${b.wd}/ticket.md`, ctx), b.wd);
    assert.equal(workdirIn(`see ${join(b.claude, 'work', '_scratch')}`, ctx), null);
    assert.equal(workdirIn('no path here', ctx), null);
    assert.equal(workdirIn(`${b.wd}-nope`, ctx), null);
  });

  it('two tickets named is no answer; the one inside this project wins over one outside it', (t) => {
    const b = bed(t);
    const other = join(b.claude, 'work', 'T-2'); mkdirSync(other, { recursive: true }); ticket(other, [{ name: 's' }], { id: 'T-2' });
    assert.equal(workdirIn(`${b.wd} and ${other}`, { claudeDir: b.claude }), null);
    const foreign = join(b.root, 'elsewhere', 'work', 'T-9'); mkdirSync(foreign, { recursive: true }); ticket(foreign, [{ name: 's' }], { id: 'T-9' });
    assert.equal(workdirIn(`${b.wd} then ${foreign}`, { claudeDir: b.claude }), b.wd);
  });

  it('spawnOf reads the first transcript line: the prompt and the start time, as text or as blocks', (t) => {
    const b = bed(t);
    const file = join(b.root, 'blocks.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }, timestamp: '2026-01-01T10:00:00.000Z' }) + '\n');
    assert.deepEqual(spawnOf(file), { text: 'first\nsecond', at: Date.parse('2026-01-01T10:00:00.000Z') });
    assert.deepEqual(spawnOf(join(b.root, 'nope')), { text: '', at: 0 });
    writeFileSync(file, 'not json\n');
    assert.deepEqual(spawnOf(file), { text: '', at: 0 });
  });
});

describe('the contracts table', () => {
  it('names exactly the plugin\'s role agents', () => {
    assert.deepEqual(Object.keys(CONTRACTS).sort(), ['tp:diff-validator', 'tp:implementer', 'tp:plan-checker', 'tp:researcher', 'tp:reviewer']);
  });
});

describe('the gate — the implementer', () => {
  /** A ticket whose worktree is a real git checkout with a commit, an implement.json and (optionally) a recorded gate result for HEAD. */
  function implBed(t, { implement = {}, dirty = false, record = null, repoArg = false } = {}) {
    const b = bed(t);
    const { repo, worktree, git } = gitRepoWithWorktree(b.root, 'shop', 'feat/t');
    writeJson(b.wd, 'ticket.json', { id: 'T-1', title: 't', link: null, round: 1, stackedOn: null, acceptanceCriteria: ['a'], complexity: 'low', repos: [{ name: 'shop', path: repo, worktree, branch: 'feat/t', base: 'main' }] });
    const head = git(['rev-parse', 'HEAD'], worktree).trim();
    if (dirty) writeFileSync(join(worktree, 'wip.txt'), 'uncommitted');
    writeJson(b.wd, 'implement.json', { schemaVersion: 1, repo: 'shop', done: 2, total: 2, commits: [head], gates: { lint: 'PASS' }, deviations: 0, stopped: null, complexity: 'low', ...implement });
    if (record) {
      const dir = join(b.claude, 'work', '_scratch', 'gates', basename(repo), 'results'); mkdirSync(dir, { recursive: true }); // gates.mjs keys a repo by the folder name of its path
      writeJson(dir, `${head}.${'b'.repeat(40)}.json`, { repo: 'shop', head, base: 'b'.repeat(40), table: '|', ...record });
    }
    const stop = (message = CONTRACT_LINES, id = 'i1') => b.stop('tp:implementer', message, { id, prompt: `Dedicated agent for /tp:implement. Work directory ${b.wd}. Invoke the skill: T-1${repoArg ? ' repo=shop' : ''} inline=true` });
    return { ...b, worktree, head, stop };
  }

  it('lets a finished implementer go: implement.json valid, everything committed, no gate result that says FAIL', async (t) => {
    const b = implBed(t);
    assert.equal(await b.stop(), null);
    const withRecord = implBed(t, { record: { verdict: 'ALL GATES PASSED', gates: { lint: 'PASS', types: 'PASS' } } });
    assert.equal(await withRecord.stop(), null);
  });

  it('sends it back when implement.json is missing, or from before it started', async (t) => {
    const b = implBed(t);
    rm(join(b.wd, 'implement.json'));
    assert.match((await b.stop()).reason, /implement\.json is not in the work directory\. Record it with `state\.mjs put <workdir> implement …`, commit, and run \/tp:verify/);
    const stale = implBed(t); stale.fresh(join(stale.wd, 'implement.json'), stale.started - 3600000);
    assert.match((await stale.stop()).reason, /implement\.json is the one from before you started/);
  });

  it('reads implement.<repo>.json when the prompt names the repo', async (t) => {
    const b = implBed(t, { repoArg: true });
    assert.match((await b.stop()).reason, /implement\.shop\.json is not in the work directory/);
    writeJson(b.wd, 'implement.shop.json', { schemaVersion: 1, repo: 'shop', done: 2, total: 2, commits: [b.head], gates: { lint: 'HOOK' }, deviations: [], stopped: null, complexity: 'medium' });
    assert.equal(await b.stop(CONTRACT_LINES, 'i2'), null);
  });

  it('sends it back when the work is not committed', async (t) => {
    const out = await implBed(t, { dirty: true }).stop();
    assert.match(out.reason, /the worktree has uncommitted changes \(\?\? wip\.txt\) — commit them, a PR is made from commits/);
  });

  it('sends it back when the plan is not fully implemented: a step\'s file untouched, a criterion\'s test absent', async (t) => {
    const b = implBed(t);
    const plan = `# Plan — T-1: t\n\nstatus: ready\nrisk flags: none\nrepos: \`shop\`\n\n## Goal\nx\n\n1. a works\n\n## Current behaviour\nx\n\n## Approach\nx\n\n## Steps\n\n### Step 1 — change\n- Files: \`src/never.js\` (edit)\n- Change: x\n- Checkpoint: x\n- Commit: yes — \`x\`\n\n## Verification\n- Criteria checks:\n  1 → test \`test/never.test.js\` "a works"\n\n## Risks and rollback\nnone\n\n## Open questions\nnone\n\n## Out of scope\nnone\n`;
    writeFileSync(join(b.wd, 'plan.md'), plan);
    const out = await b.stop();
    assert.match(out.reason, /the plan is not fully implemented — step 1 \(change\): src\/never\.js not changed; criterion 1: test\/never\.test\.js is not in the worktree/);
    assert.ok(out.reason.length < 400);
  });

  it('sends it back when the gate result recorded for HEAD says FAIL, by its table or by its verdict', async (t) => {
    assert.match((await implBed(t, { record: { verdict: 'FAILED', gates: { lint: 'FAIL', types: 'PASS' } } }).stop()).reason, /the gate result recorded for [0-9a-f]{7} says FAIL/);
    assert.match((await implBed(t, { record: { verdict: '2 GATES FAILED' } }).stop()).reason, /says FAIL/);
  });

  it('with no recorded result, the gates it reported must exist and not fail — a repo whose hooks own the gates records none', async (t) => {
    assert.equal(await implBed(t, { implement: { gates: { lint: 'HOOK', build: 'HOOK' } } }).stop(), null);
    assert.match((await implBed(t, { implement: { gates: {} } }).stop()).reason, /no gate result is recorded for [0-9a-f]{7} and implement\.json lists no gates — run \/tp:verify/);
    assert.match((await implBed(t, { implement: { gates: { lint: 'FAIL' } } }).stop()).reason, /implement\.json reports a failing gate/);
  });

  it('a stop for the person, or fewer steps done than planned, is a legitimate end: no commit or gate is demanded', async (t) => {
    const stopped = implBed(t, { dirty: true, implement: { done: 1, stopped: { step: 2, question: 'Which of the two?' }, gates: {} } });
    assert.equal(await stopped.stop('Which of the two?\ncomplexity: as rated\ncontinue: no'), null);
    const partial = implBed(t, { dirty: true, implement: { done: 1, gates: {} } });
    assert.equal(await partial.stop(), null);
  });

  it('a worktree the hook cannot find or read is not a reason to hold the agent', async (t) => {
    const b = implBed(t);
    writeJson(b.wd, 'ticket.json', { id: 'T-1', title: 't', link: null, round: 1, stackedOn: null, acceptanceCriteria: ['a'], complexity: 'low', repos: [{ name: 'shop', path: '/x/shop', worktree: '/nowhere', branch: 'b', base: 'main' }] });
    assert.equal(await b.stop(), null);
  });

  it('still needs the closing lines', async (t) => {
    assert.match((await implBed(t).stop('Implemented.')).reason, /must end with the two lines/);
  });
});
