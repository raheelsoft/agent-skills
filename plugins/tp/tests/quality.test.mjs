// The score of a reviewed change and the record of the passes: counts per priority, compared P0 first, and written through the validated writer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { script, tmp, rm, writeJson, readJson } from './helpers.mjs';
import { SCHEMA_DIR, checkArtifact } from '../lib/contract/index.mjs';
import { scoreOf, compareOpen, aggregate, WEIGHTS } from '../lib/contract/quality.mjs';
import { recordReview, CliError } from '../lib/state/index.mjs';

const example = (name) => JSON.parse(readFileSync(join(SCHEMA_DIR, 'examples', `${name}.json`), 'utf8'));
const finding = (id, priority, extra = {}) => ({ id, priority, file: 'a.ts', line: id, text: `f${id}`, ...extra });
const review = (findings, extra = {}) => ({ round: 1, sha: 'abc1234', mode: 'full', confidence: 4, findings, ...extra });
const counts = (o = {}) => ({ P0: 0, P1: 0, P2: 0, P3: 0, P4: 0, ...o });

describe('scoreOf', () => {
  it('counts what is open per priority, what was fixed, and the pre-existing, and weighs them', () => {
    const s = scoreOf(review([finding(1, 'P0'), finding(2, 'P1'), finding(3, 'P1'), finding(4, 'P3'), finding(5, 'P1', { status: 'resolved' }), finding(6, 'P2', { scope: 'pre-existing' }), finding(7, 'P4', { status: 'noted' })]));
    assert.deepEqual(s.open, counts({ P0: 1, P1: 2, P3: 1 }));
    assert.deepEqual(s.resolved, counts({ P1: 1 }));
    assert.equal(s.preexisting, 1);
    assert.equal(s.score, 1000 + 200 + 3);
  });

  it('a noted item is neither open nor fixed, and a clean pass scores 0', () => {
    assert.equal(scoreOf(review([finding(1, 'P4', { status: 'noted' })])).score, 0);
    assert.equal(scoreOf(review([])).score, 0);
  });

  it('the weights put each priority above any pile of the next', () => {
    assert.ok(WEIGHTS.P0 > 9 * WEIGHTS.P1 && WEIGHTS.P1 > 9 * WEIGHTS.P2 && WEIGHTS.P2 > 3 * WEIGHTS.P3 && WEIGHTS.P3 > WEIGHTS.P4);
  });
});

describe('compareOpen', () => {
  it('is lexicographic, P0 first: one P0 outweighs any number of lesser findings', () => {
    assert.equal(compareOpen(counts({ P0: 1 }), counts({ P1: 50, P2: 50 })), 1);
    assert.equal(compareOpen(counts({ P1: 1 }), counts({ P2: 99 })), 1);
    assert.equal(compareOpen(counts({ P2: 2 }), counts({ P2: 3 })), -1);
    assert.equal(compareOpen(counts({ P3: 1 }), counts({ P3: 1 })), 0);
  });
});

describe('aggregate', () => {
  const round = (repo, n, open, verdict) => ({ repo, round: n, sha: 's', mode: 'full', verdict, open: counts(open), resolved: counts(), preexisting: 0, score: 0 });
  it('sums the latest pass of each repo and takes the worst verdict', () => {
    const a = aggregate([round('api', 1, { P1: 2 }, 'BLOCK'), round('api', 2, { P3: 1 }, 'PASS WITH WARNINGS'), round('web', 1, { P2: 1 }, 'PASS WITH WARNINGS')]);
    assert.deepEqual(a.open, counts({ P2: 1, P3: 1 }));
    assert.equal(a.score, 13);
    assert.equal(a.verdict, 'PASS WITH WARNINGS');
    assert.equal(aggregate([round('api', 1, {}, 'PASS'), round('web', 1, { P1: 1 }, 'BLOCK')]).verdict, 'BLOCK');
  });

  it('no passes: nothing open, no verdict', () => {
    assert.deepEqual(aggregate([]), { open: counts(), score: 0, verdict: null });
  });
});

describe('recordReview — a pass into pr.json and quality.json', () => {
  const bed = (t, pr = {}) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = join(root, 'work', 'T-1'); mkdirSync(dir, { recursive: true });
    writeJson(dir, 'pr.json', { repo: 'shop-web', url: 'https://h/pr/1', number: 1, round: 1, reviewRounds: 0, reviews: [], verdict: null, merged: null, ...pr });
    return dir;
  };

  it('appends the row, counts the rounds, sets the verdict, and writes quality.json — all valid', (t) => {
    const dir = bed(t);
    const r1 = review([finding(1, 'P1'), finding(2, 'P3')]);
    const out = recordReview(dir, r1);
    assert.deepEqual(out.row, { round: 1, sha: 'abc1234', verdict: 'BLOCK', open: [1], new: [1, 2] });
    const pr = readJson(dir, 'pr.json');
    assert.deepEqual([pr.reviewRounds, pr.verdict, pr.reviews.length], [1, 'BLOCK', 1]);
    assert.equal(checkArtifact('pr', pr, { mode: 'write' }).ok, true);
    const q = readJson(dir, 'quality.json');
    assert.equal(checkArtifact('quality', q, { mode: 'write' }).ok, true);
    assert.deepEqual([q.open, q.score, q.verdict], [counts({ P1: 1, P3: 1 }), 103, 'BLOCK']);

    recordReview(dir, review([finding(1, 'P1', { status: 'resolved' }), finding(2, 'P3')], { round: 2, sha: 'def5678', mode: 'delta' }));
    const after = readJson(dir, 'pr.json');
    assert.deepEqual([after.reviewRounds, after.verdict, after.reviews.map((x) => x.round)], [2, 'PASS WITH WARNINGS', [1, 2]]);
    assert.deepEqual(readJson(dir, 'quality.json').open, counts({ P3: 1 }));
    assert.equal(readJson(dir, 'quality.json').rounds.length, 2);
  });

  it('recording the same round again replaces it instead of adding a second', (t) => {
    const dir = bed(t);
    recordReview(dir, review([finding(1, 'P1')]));
    recordReview(dir, review([finding(1, 'P1', { status: 'resolved' })]));
    assert.equal(readJson(dir, 'pr.json').reviews.length, 1);
    assert.equal(readJson(dir, 'pr.json').verdict, 'PASS');
    assert.equal(readJson(dir, 'quality.json').rounds.length, 1);
  });

  it('a cross-repo ticket keeps one pr.<repo>.json per repo and one quality.json for the ticket', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = join(root, 'work', 'T-1'); mkdirSync(dir, { recursive: true });
    for (const repo of ['api', 'web']) writeJson(dir, `pr.${repo}.json`, { repo, url: `https://h/${repo}/1`, number: 1, round: 1, reviewRounds: 0, reviews: [], verdict: null, merged: null });
    recordReview(dir, review([finding(1, 'P1')]), { repo: 'api' });
    recordReview(dir, review([finding(1, 'P2')], { sha: 'zzz9999' }), { repo: 'web' });
    assert.equal(readJson(dir, 'pr.api.json').verdict, 'BLOCK');
    assert.equal(readJson(dir, 'pr.web.json').verdict, 'PASS WITH WARNINGS');
    const q = readJson(dir, 'quality.json');
    assert.deepEqual([q.rounds.map((r) => r.repo), q.verdict, q.open], [['api', 'web'], 'BLOCK', counts({ P1: 1, P2: 1 })]);
  });

  it('refuses a review for a PR that is not recorded, and a PR file that is not JSON', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = join(root, 'work', 'T-1'); mkdirSync(dir, { recursive: true });
    assert.throws(() => recordReview(dir, review([])), (e) => e instanceof CliError && /pr\.json is not in/.test(e.message));
    writeFileSync(join(dir, 'pr.json'), '{ nope');
    assert.throws(() => recordReview(dir, review([])), (e) => e instanceof CliError && /not valid JSON/.test(e.message));
  });
});

describe('findings.mjs score and record — the command', () => {
  const FINDINGS = script('findings.mjs');
  const run = (...args) => { const r = spawnSync(process.execPath, [FINDINGS, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };

  it('score prints the counts; record writes the files and prints the row and the ticket\'s quality', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = join(root, 'work', 'T-1'); mkdirSync(dir, { recursive: true });
    writeJson(dir, 'pr.json', { repo: 'shop-web', url: 'https://h/pr/218', number: 218, round: 1, reviewRounds: 0, reviews: [], verdict: null, merged: null });
    const file = join(root, 'review.json'); writeFileSync(file, JSON.stringify(example('review-findings')));
    assert.deepEqual(JSON.parse(run('score', file).out).open, counts({ P1: 1, P3: 1 }));
    const r = run('record', file, dir);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.deepEqual([out.row.verdict, out.quality.verdict, out.quality.score], ['BLOCK', 'BLOCK', 103]);
    assert.equal(readJson(dir, 'pr.json').reviews.length, 1);
  });

  it('record refuses a ticket with no pr.json, naming it, exit 2', (t) => {
    const root = tmp(); t.after(() => rm(root));
    const dir = join(root, 'work', 'T-1'); mkdirSync(dir, { recursive: true });
    const file = join(root, 'review.json'); writeFileSync(file, JSON.stringify(example('review-findings')));
    const r = run('record', file, dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /pr\.json is not in/);
  });
});
