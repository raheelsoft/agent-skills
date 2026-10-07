// plan-lint: the mechanical half of the plan check — the template's structure, counts that agree, files and citations that exist.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { script, tmp, rm, writeJson, readJson } from './helpers.mjs';
import { parsePlan, lintPlan } from '../lib/contract/plan.mjs';

const LINT = script('plan-lint.mjs');

/** A plan that follows the template; each test breaks one thing in it. */
function plan(over = {}) {
  const o = {
    title: '# Plan — T-1: Show VAT on the invoice', status: 'ready', flags: 'public-contract', repos: '`/work/wt/shop` · `feat/t-1` · `main`',
    goal: 'The invoice shows VAT.\n\n1. The total includes VAT\n2. A zero-rated order shows 0%',
    current: 'The total is computed in `src/invoices/total.ts:3-9`; the formatter is `src/invoices/format.ts:1`.',
    steps: [
      { n: 1, files: '`src/invoices/total.ts` (edit), `src/invoices/vat.ts` (new)', pattern: '`src/invoices/format.ts:1`', commit: 'yes — `feat: add VAT`' },
      { n: 2, files: '`src/invoices/total.spec.ts` (new)', commit: 'no, folded into step 3' },
      { n: 3, files: '`src/invoices/format.ts` (edit)', commit: 'yes — `test: VAT`' },
    ],
    verification: '- Gates: the project\'s own.\n- Manual: 1. open an invoice.', risks: '- none → n/a', questions: 'none', scope: 'nothing else',
    ...over,
  };
  const step = (s) => `### Step ${s.n} — change ${s.n}\n- Files: ${s.files}\n- Change: do the thing\n${s.pattern ? `- Pattern: ${s.pattern}\n` : ''}- Checkpoint: \`tsc --noEmit\`\n- Commit: ${s.commit}\n`;
  return `${o.title}\n\nstatus: ${o.status}\nrisk flags: ${o.flags}\nrepos: ${o.repos}\n\n## Goal\n${o.goal}\n\n## Current behaviour\n${o.current}\n\n## Approach\nAdd it.\n\n## Steps\n${o.steps.map(step).join('\n')}\n## Verification\n${o.verification}\n\n## Risks and rollback\n${o.risks}\n\n## Open questions\n${o.questions}\n\n## Out of scope\n${o.scope}\n`;
}
const GOOD_JSON = { status: 'ready', flags: ['public-contract'], steps: 3, openQuestions: 0, complexity: 'medium' };
const TICKET = { id: 'T-1', acceptanceCriteria: ['a', 'b'] };

/** A worktree holding the files the good plan edits and cites. */
function tree(t, files = { 'src/invoices/total.ts': 12, 'src/invoices/format.ts': 5 }) {
  const root = tmp('lint-'); t.after(() => rm(root));
  const wt = join(root, 'wt', 'shop'); mkdirSync(join(wt, 'src', 'invoices'), { recursive: true });
  for (const [f, lines] of Object.entries(files)) writeFileSync(join(wt, f), Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'));
  return { root, wt, repos: [{ name: 'shop', worktree: wt, path: '/work/shop' }] };
}
const lint = (md, ctx = {}) => lintPlan(parsePlan(md), { ticket: TICKET, planJson: GOOD_JSON, fs: false, ...ctx });
const rules = (r, severity = 'blocking') => r.findings.filter((f) => f.severity === severity).map((f) => f.rule);
const says = (r, re) => assert.ok(r.findings.some((f) => re.test(f.text)), `${JSON.stringify(r.findings.map((f) => f.text))} should match ${re}`);

describe('plan-lint — a plan that follows the template', () => {
  it('passes, and reports what it counted', () => {
    const r = lint(plan());
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.deepEqual(r.stats, { steps: 3, openQuestions: 0, criteria: 2, citations: 3, files: 4 });
  });

  it('every finding is in plan-check.json\'s shape, marked as the script\'s', () => {
    const r = lint(plan({ status: 'draft' }));
    for (const f of r.findings) assert.deepEqual(Object.keys(f).sort(), ['rule', 'severity', 'source', 'step', 'text']);
    assert.ok(r.findings.every((f) => f.source === 'lint'));
  });

  it('never throws on something that is not a plan', () => {
    for (const text of ['', '# just a title', 'no markdown at all', '## Goal\n']) assert.equal(lintPlan(parsePlan(text), {}).ok, false);
  });
});

describe('plan-lint — structure', () => {
  it('the essential sections block, the others only advise', () => {
    const noGoal = plan().replace(/## Goal[\s\S]*?(?=## Current)/, '');
    assert.deepEqual(rules(lint(noGoal)).filter((r) => r === 'sections'), ['sections']);
    const noRisks = plan().replace(/## Risks and rollback[\s\S]*?(?=## Open)/, '');
    const r = lint(noRisks);
    assert.equal(r.ok, true);
    assert.deepEqual(rules(r, 'advisory'), ['sections']);
  });

  it('the header: title, ticket id, status, flags, repos', () => {
    says(lint(plan({ title: '# Some plan' })), /title line is not/);
    says(lint(plan({ title: '# Plan — T-9: other' })), /names T-9, the ticket is T-1/);
    says(lint(plan({ status: 'draft' }), {}), /"status:" is "draft"/);
    says(lint(plan({ flags: 'public-contract | danger' })), /risk flag "danger"/);
    says(lint(plan().replace(/risk flags:.*\n/, '')), /"risk flags:" is missing/);
    says(lint(plan().replace(/repos:.*\n/, '')), /"repos:" is missing/);
  });

  it('two repos need the cross-repo flag', () => {
    const two = plan({ repos: '\n- `/work/wt/shop` · `feat/t-1` · `main`\n- `/work/wt/api` · `feat/t-1` · `main`' });
    assert.ok(rules(lint(two)).includes('risk-flags'));
    assert.ok(!rules(lint(plan({ repos: two.match(/repos:[\s\S]*?\n\n/)[0].replace(/^repos:\s*/, '\n'), flags: 'public-contract, cross-repo' }))).includes('risk-flags'));
  });

  it('flags may be separated by | or , and carry a note in brackets', () => {
    assert.equal(lint(plan({ flags: 'data-model | access-control' }), { planJson: { ...GOOD_JSON, flags: ['data-model', 'access-control'] } }).ok, true);
    assert.equal(lint(plan({ flags: 'data-model (new table), public-contract' }), { planJson: { ...GOOD_JSON, flags: ['data-model', 'public-contract'] } }).ok, true);
    assert.equal(lint(plan({ flags: 'none' }), { planJson: { ...GOOD_JSON, flags: [] } }).ok, true);
  });
});

describe('plan-lint — steps and commits', () => {
  it('steps run 1, 2, 3 …; a leading Step 0 is a prerequisite outside the numbering and the counts', () => {
    const md = plan().replace('### Step 2 —', '### Step 5 —');
    says(lint(md), /steps are numbered 1, 5, 3/);
    const withZero = plan().replace('## Steps\n', '## Steps\n### Step 0 — prerequisite\nCreate the worktree first.\n\n');
    assert.equal(lint(withZero).ok, true, JSON.stringify(lint(withZero).findings));
    assert.equal(lint(withZero).stats.steps, 3);
  });

  it('a step needs Files, Change, Checkpoint and Commit', () => {
    const r = lint(plan().replace(/- Checkpoint: .*\n/, ''));
    says(r, /step 1 has no "Checkpoint:" line/);
    assert.equal(r.findings.find((f) => /Checkpoint/.test(f.text)).step, 1);
    says(lint(plan().replace(/- Files: .*\n/, '- Files:\n')), /"Files:" is empty/);
  });

  it('a commit says yes or no; a fold names a step that exists, not the step itself, and does not run in a circle', () => {
    says(lint(plan().replace('yes — `feat: add VAT`', 'maybe')), /starts with yes or no/);
    says(lint(plan().replace('folded into step 3', 'folded into step 9')), /folded into step 9, which does not exist/);
    says(lint(plan().replace('folded into step 3', 'folded into step 2')), /folded into itself/);
    const circle = plan().replace('yes — `test: VAT`', 'no, folded into step 2');
    says(lint(circle), /folded into each other in a circle/);
  });

  it('a fold into an earlier step is allowed, and a plain no (nothing to commit) is not a fold', () => {
    assert.equal(lint(plan().replace('folded into step 3', 'folded into step 1')).ok, true);
    assert.equal(lint(plan().replace('no, folded into step 3', 'no — outside any repo, nothing to commit')).ok, true);
  });
});

describe('plan-lint — counts, status, criteria', () => {
  it('plan.json agrees with plan.md: steps, open questions, status, flags', () => {
    says(lint(plan(), { planJson: { ...GOOD_JSON, steps: 4 } }), /plan\.json says 4 steps, plan\.md has 3/);
    says(lint(plan(), { planJson: { ...GOOD_JSON, openQuestions: 2 } }), /plan\.json says 2 open questions, plan\.md lists 0/);
    says(lint(plan(), { planJson: { ...GOOD_JSON, status: 'open-questions' } }), /plan\.json status is open-questions, plan\.md says ready/);
    says(lint(plan(), { planJson: { ...GOOD_JSON, flags: ['cross-repo'] } }), /plan\.json flags are \[cross-repo\]/);
  });

  it('a count written as a list is not compared (older plan.json)', () => {
    assert.equal(lint(plan(), { planJson: { ...GOOD_JSON, steps: [{}, {}, {}] } }).ok, true);
  });

  it('ready with open questions, and open-questions with none', () => {
    const q = '1. Zero-rated: show 0% or hide? Default: show 0%.\n2. Round per line?';
    const r = lint(plan({ questions: q }), { planJson: { ...GOOD_JSON, openQuestions: 2 } });
    says(r, /status is ready but § Open questions lists 2/);
    assert.equal(r.stats.openQuestions, 2);
    says(lint(plan({ status: 'open-questions' }), { planJson: { ...GOOD_JSON, status: 'open-questions' } }), /status is open-questions but § Open questions lists none/);
  });

  it('an open question without its default is an advisory', () => {
    const r = lint(plan({ status: 'open-questions', questions: '1. Zero-rated: show 0% or hide? Default: show 0%.\n2. Round per line?' }), { planJson: { ...GOOD_JSON, status: 'open-questions', openQuestions: 2 } });
    assert.deepEqual(r.findings.filter((f) => f.rule === 'questions' && f.severity === 'advisory').map((f) => f.text.match(/question (\d)/)[1]), ['2']);
  });

  it('§ Goal numbers the ticket\'s criteria', () => {
    says(lint(plan(), { ticket: { id: 'T-1', acceptanceCriteria: ['a', 'b', 'c'] } }), /§ Goal numbers 2 acceptance criteria, ticket\.json has 3/);
  });
});

describe('plan-lint — template leftovers and conversation', () => {
  it('a placeholder left in a heading, the header or a field blocks', () => {
    says(lint(plan({ title: '# Plan — <ticket id>: <title>' })), /placeholder/);
    says(lint(plan({ status: '<ready | open-questions>' })), /placeholder|"status:"/);
    says(lint(plan().replace('- Change: do the thing', '- Change: <what, precisely>')), /template placeholder left in/);
  });

  it('"as discussed", "as agreed", TBD block — outside backticks and code, and "as before" does not', () => {
    says(lint(plan({ current: 'Done as discussed with the team.' })), /"as discussed"/);
    says(lint(plan({ scope: 'The currency is TBD.' })), /"TBD"/);
    assert.equal(lint(plan({ current: 'Behaves as before for zero-rated orders. See `// TBD` in `src/invoices/total.ts:3`.' })).ok, true);
    assert.equal(lint(plan({ current: '```\n// as discussed\n```\nAll good.' })).ok, true);
  });
});

describe('plan-lint — the research a plan leans on', () => {
  const research = { questions: ['q'], findings: [{ id: 'RS1', claim: 'c', confidence: 'high', sources: [{ kind: 'code', ref: 'a.ts:1' }] }, { id: 'RS2', claim: 'c', confidence: 'low', sources: [{ kind: 'doc', ref: 'https://d/x' }] }], unknowns: [], confidence: 'medium' };

  it('a finding the plan cites must exist', () => {
    says(lint(plan({ current: 'The paging is offset-based (RS1) and cursors work on a composite key (RS3).' }), { research }), /cites RS3, but research\.json has RS1, RS2/);
    assert.equal(lint(plan({ current: 'The paging is offset-based (RS1) and cursors work on a composite key (RS2).' }), { research }).ok, true);
  });

  it('findings nobody cites are worth an advisory, not a block', () => {
    const r = lint(plan(), { research });
    assert.equal(r.ok, true);
    assert.ok(r.findings.some((f) => f.severity === 'advisory' && f.rule === 'research' && /2 finding\(s\) and the plan cites none/.test(f.text)));
  });

  it('a risk numbered R1 is not a citation, and a citation inside code is not counted', () => {
    assert.equal(lint(plan({ risks: '- R1: the rollout order → deploy the API first' }), { research: { ...research, findings: [] } }).findings.some((f) => f.rule === 'research'), false);
    assert.equal(lint(plan({ current: 'See `RS9` in the notes.\n```\nRS8\n```' }), { research }).findings.some((f) => f.severity === 'blocking' && f.rule === 'research'), false);
  });

  it('no research.json, no rule', () => {
    assert.equal(lint(plan({ current: 'See RS7.' })).findings.some((f) => f.rule === 'research'), false);
  });
});

describe('plan-lint — files and citations against the worktree', () => {
  it('passes when every edited file is there, new ones are not, and the citations are in range', (t) => {
    const { repos, root } = tree(t);
    const r = lint(plan(), { repos, projectRoot: root, fs: true });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.deepEqual(r.skipped, []);
  });

  it('an edit of a file that is not there blocks, with the step; a new file that exists blocks', (t) => {
    const { repos, root } = tree(t, { 'src/invoices/format.ts': 5 });
    const r = lint(plan(), { repos, projectRoot: root, fs: true });
    const f = r.findings.find((x) => x.rule === 'files');
    assert.equal(f.step, 1);
    assert.match(f.text, /step 1 edits `src\/invoices\/total\.ts`, which is in no worktree/);
    const { repos: r2, root: p2 } = tree(t, { 'src/invoices/total.ts': 12, 'src/invoices/format.ts': 5, 'src/invoices/vat.ts': 1 });
    says(lint(plan(), { repos: r2, projectRoot: p2, fs: true }), /step 1 creates `src\/invoices\/vat\.ts`, which already exists in shop/);
  });

  it('a template path (<timestamp>) or a glob is not one file, and is not checked', (t) => {
    const { repos, root } = tree(t);
    const md = plan({ steps: [{ n: 1, files: '`prisma/migrations/<timestamp>_x/migration.sql` (edit), `src/**/*.ts` (edit)', commit: 'yes — x' }, { n: 2, files: 'none', commit: 'yes — y' }, { n: 3, files: 'none', commit: 'yes — z' }] });
    assert.equal(lint(md, { repos, projectRoot: root, fs: true }).ok, true);
  });

  it('a cited line past the end of the file blocks, naming the file\'s length', (t) => {
    const { repos, root } = tree(t, { 'src/invoices/total.ts': 12, 'src/invoices/format.ts': 5 });
    const r = lint(plan({ current: 'See `src/invoices/total.ts:40-45`.' }), { repos, projectRoot: root, fs: true });
    says(r, /cites `src\/invoices\/total\.ts:40-45`, but the file has 12 lines/);
  });

  it('a cited file that is not there blocks when its folder is the repo\'s, advises once when it is outside the repos', (t) => {
    const { repos, root } = tree(t);
    const r = lint(plan({ current: 'See `src/invoices/gone.ts:3`, `design/screens.jsx:58` and `export/data.js:9`.' }), { repos, projectRoot: root, fs: true });
    assert.deepEqual(r.findings.filter((f) => f.rule === 'citations' && f.severity === 'blocking').map((f) => f.text.match(/`(.+?)`/)[1]), ['src/invoices/gone.ts:3']);
    const adv = r.findings.filter((f) => f.rule === 'citations' && f.severity === 'advisory');
    assert.equal(adv.length, 1);
    assert.match(adv[0].text, /2 cited path\(s\) are in no worktree and were not checked: design\/screens\.jsx:58, export\/data\.js:9/);
  });

  it('a path named by its tail resolves by suffix, and a bare name by name', (t) => {
    const { repos, root } = tree(t);
    assert.equal(lint(plan({ current: 'See `invoices/total.ts:3` and `format.ts:2`.' }), { repos, projectRoot: root, fs: true }).ok, true);
  });

  it('a citation inside a code block, or to a file the plan creates, is not checked', (t) => {
    const { repos, root } = tree(t);
    const md = plan({ current: 'Today:\n```ts\n// see `src/invoices/phantom.ts:99`\n```\nNew: `src/invoices/vat.ts:5` is written by step 1.' });
    assert.equal(lint(md, { repos, projectRoot: root, fs: true }).ok, true);
  });

  it('a repo-name prefix on a path is read as the repo\'s folder', (t) => {
    const { repos, root } = tree(t);
    const md = plan({ steps: [{ n: 1, files: '`shop/src/invoices/total.ts` (edit)', commit: 'yes — x' }, { n: 2, files: 'none', commit: 'yes — y' }, { n: 3, files: 'none', commit: 'yes — z' }] });
    assert.equal(lint(md, { repos, projectRoot: root, fs: true }).ok, true);
  });

  it('without a worktree the file rules are skipped, and the result says so', () => {
    const r = lint(plan(), { repos: [{ name: 'shop', worktree: '/nowhere', path: '/x' }], fs: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.skipped, ['files', 'citations']);
  });
});

describe('plan-lint — the command', () => {
  const run = (...args) => { const r = spawnSync(process.execPath, [LINT, ...args], { encoding: 'utf8' }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* usage */ } return { code: r.status, json, err: r.stderr }; };
  function workdir(t, md, planJson = GOOD_JSON) {
    const { root, wt } = tree(t);
    const dir = join(root, 'proj', '.claude', 'work', 'T-1'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.md'), md);
    writeJson(dir, 'plan.json', planJson);
    writeJson(dir, 'ticket.json', { ...TICKET, title: 't', round: 1, complexity: 'medium', repos: [{ name: 'shop', path: '/work/shop', worktree: wt, branch: 'b', base: 'main' }] });
    return dir;
  }

  it('exit 0 and one line of JSON for a good plan; exit 1 for a blocking finding', (t) => {
    assert.equal(run(workdir(t, plan())).code, 0);
    const bad = run(workdir(t, plan({ status: 'draft' })));
    assert.equal(bad.code, 1);
    assert.equal(bad.json.ok, false);
  });

  it('exit 2 for a work directory without a plan, or none at all', (t) => {
    const root = tmp(); t.after(() => rm(root));
    mkdirSync(join(root, 'T-1'));
    assert.equal(run(join(root, 'T-1')).code, 2);
    assert.equal(run().code, 2);
  });

  it('reads plan.json and ticket.json from the work directory, and the worktree from the ticket', (t) => {
    const dir = workdir(t, plan({ current: 'See `src/invoices/gone.ts:3`.' }));
    const r = run(dir);
    assert.ok(r.json.findings.some((f) => f.rule === 'citations' && f.severity === 'blocking'));
    assert.deepEqual(run(dir, '--no-fs').json.skipped, ['files', 'citations']);
  });

  it('--record writes plan-check.json as a revise round when something blocks, and counts the rounds', (t) => {
    const dir = workdir(t, plan({ status: 'draft' }));
    const first = run(dir, '--record');
    assert.equal(first.json.recorded, true);
    const check = readJson(dir, 'plan-check.json');
    assert.deepEqual([check.verdict, check.round, check.override], ['revise', 1, null]);
    assert.ok(check.findings.every((f) => f.source === 'lint' && f.severity));
    run(dir, '--record');
    assert.equal(readJson(dir, 'plan-check.json').round, 2);
  });

  it('--record writes nothing for a plan that passes', (t) => {
    const dir = workdir(t, plan());
    assert.equal(run(dir, '--record').code, 0);
    assert.equal(existsSync(join(dir, 'plan-check.json')), false);
  });
});
