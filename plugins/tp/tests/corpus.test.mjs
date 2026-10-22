// A real project's work directory against the contracts — the proof that the read mode still accepts everything the pipeline has ever produced.
// The corpus is private (tickets, paths, repo names), so it is never in this repository: point TP_CORPUS at a copy of a project's
// `.claude/work` and run   TP_CORPUS=<path> node --test tests/corpus.test.mjs   — without it the test is skipped.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkroot } from '../lib/contract/index.mjs';

const corpus = process.env.TP_CORPUS;

describe('a real work directory', { skip: corpus ? false : 'set TP_CORPUS to a copy of a project\'s .claude/work' }, () => {
  it('read mode accepts every artifact in it', () => {
    const r = checkWorkroot(corpus, { mode: 'read' });
    assert.ok(r.checked > 0, 'the corpus holds artifacts');
    assert.deepEqual(r.invalid, [], `${r.invalid.length} of ${r.checked} artifacts are refused`);
  });

  it('write mode shows how much of it the current contract would refuse (informational)', (t) => {
    const r = checkWorkroot(corpus, { mode: 'write' });
    t.diagnostic(`${r.invalid.length} of ${r.checked} artifacts do not meet the write contract`);
    assert.ok(r.invalid.length <= r.checked);
  });
});
