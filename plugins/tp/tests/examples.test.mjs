// The examples in skills/*/examples/*.md are documentation an agent copies from, so they are tested like code: every `good` block is valid as the
// contract stands, every `bad` block is refused and the refusal contains the words the example quotes. A block's info string says what it is:
//   ```json good <artifact>                      a document `state.mjs put <artifact>` accepts
//   ```json bad <artifact> <words the error has>  one it refuses
//   ```json good|bad review-findings [words]      a review pass against schemas/review-findings.schema.json
//   ```markdown good plan                         a plan.md plan-lint passes (structure only: no worktree)
//   ```markdown bad plan <rule>                   one plan-lint blocks, by that rule
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import { ARTIFACTS, checkArtifact, loadSchema, validate, parsePlan, lintPlan } from '../lib/contract/index.mjs';

const SKILLS = join(PLUGIN_ROOT, 'skills');
const files = readdirSync(SKILLS).flatMap((s) => (existsSync(join(SKILLS, s, 'examples')) ? readdirSync(join(SKILLS, s, 'examples')).filter((f) => f.endsWith('.md')).map((f) => ({ skill: s, file: f, path: join(SKILLS, s, 'examples', f) })) : []))
  .filter((f) => /^```(json|markdown) (good|bad) /m.test(readFileSync(f.path, 'utf8'))); // a prose example (a PR description) carries no block to run

/** The tagged blocks of a markdown file: [{ lang, verdict, kind, words, body }]. */
function blocks(text) {
  const out = [];
  for (const m of text.matchAll(/^```(json|markdown) (good|bad) (\S+)(?: (.+))?\n([\s\S]*?)^```$/gm)) out.push({ lang: m[1], verdict: m[2], kind: m[3], words: m[4] || '', body: m[5] });
  return out;
}

describe('the examples — every block is what it says it is', () => {
  it('there are examples, and every stage skill that writes a contract has some', () => {
    const have = new Set(files.map((f) => f.skill));
    for (const s of ['start-ticket', 'triage', 'plan', 'implement', 'create-pr', 'review', 'release', 'accept', 'retro']) assert.ok(have.has(s), `${s} has an examples/ folder`);
  });

  for (const f of files) {
    const text = readFileSync(f.path, 'utf8');
    const list = blocks(text);

    it(`${f.skill}/examples/${f.file}: has a good and a bad example, and every block is tagged`, () => {
      assert.ok(list.some((b) => b.verdict === 'good'), 'a good example');
      assert.ok(list.some((b) => b.verdict === 'bad'), 'a bad example');
      assert.equal((text.match(/^```(json|markdown)\b.*$/gm) || []).length, list.length, 'every json or markdown fence says good or bad, and of what');
    });

    list.forEach((b, i) => {
      const label = `${f.skill}/${f.file} #${i + 1} (${b.verdict} ${b.kind})`;
      if (b.lang === 'json' && b.kind === 'review-findings') {
        it(`${label} — ${b.verdict === 'good' ? 'valid' : 'refused'}`, () => {
          const errors = validate(loadSchema('review-findings'), JSON.parse(b.body), { load: loadSchema });
          if (b.verdict === 'good') assert.deepEqual(errors, []);
          else { assert.ok(errors.length, 'refused'); assert.ok(errors.some((e) => e.includes(b.words)), `${JSON.stringify(errors)} mentions "${b.words}"`); }
        });
      } else if (b.lang === 'json') {
        it(`${label} — ${b.verdict === 'good' ? 'put accepts it' : 'put refuses it, and says why'}`, () => {
          assert.ok(ARTIFACTS.includes(b.kind), `${b.kind} is an artifact`);
          const r = checkArtifact(b.kind, JSON.parse(b.body), { mode: 'write' });
          if (b.verdict === 'good') assert.deepEqual(r.errors, []);
          else { assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes(b.words)), `${JSON.stringify(r.errors)} mentions "${b.words}"`); }
        });
      } else {
        it(`${label} — ${b.verdict === 'good' ? 'plan-lint passes it' : 'plan-lint blocks it'}`, () => {
          assert.equal(b.kind, 'plan');
          const r = lintPlan(parsePlan(b.body), { fs: false });
          const blocking = r.findings.filter((x) => x.severity === 'blocking');
          if (b.verdict === 'good') assert.deepEqual(blocking.map((x) => x.text), []);
          else assert.ok(blocking.some((x) => x.rule === b.words), `blocks by ${b.words}: ${JSON.stringify(blocking.map((x) => x.rule))}`);
        });
      }
    });
  }
});

describe('the skills point at their examples', () => {
  it('each skill with an examples/ folder names every file in it', () => {
    for (const f of files) assert.match(readFileSync(join(SKILLS, f.skill, 'SKILL.md'), 'utf8'), new RegExp(`examples/${f.file.replace(/[.]/g, '\\.')}`), `${f.skill}/SKILL.md points at examples/${f.file}`);
  });
});
