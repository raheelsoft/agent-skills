// ticketlint.mjs — the mechanical checks of a ticket draft, before the tracker call.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm, script } from './helpers.mjs';
import { lintTicket } from '../lib/ticketlint.mjs';

const GOOD = `## Problem
The orders list shows an error banner instead of an empty state when the request fails.

**Steps to reproduce**
1. Open Orders as a customer with no orders.
**Current:** a red banner   **Expected:** the empty state
**Environment:** stage, build 4.2, 2026-10-16

## Acceptance criteria
- [ ] An empty list shows the empty state
- [ ] A failed request still shows the error banner

## Implementation brief
- Entry points: \`src/orders.ts:3\`
- Involves: data model no · access control no · public contract no · second repo no

## Out of scope
Pagination.
`;
const rules = (r) => r.findings.map((f) => `${f.severity}:${f.rule}`);

describe('lintTicket', () => {
  it('a draft that follows the template, with its citations real, passes', (t) => {
    const root = tmp('ticketlint-'); t.after(() => rm(root));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'orders.ts'), 'a\nb\nc\nd\n');
    const r = lintTicket(GOOD, { repos: [root] });
    assert.equal(r.ok, true, JSON.stringify(r.findings)); assert.deepEqual(r.findings, []);
  });

  it('missing sections, a criteria list that is not a checklist, and a defect without Current/Expected block', () => {
    const r = lintTicket('## Problem\nx\n\n## Acceptance criteria\n1. it works\n\n**Steps to reproduce**\n1. go\n');
    assert.ok(rules(r).includes('blocking:sections')); assert.ok(rules(r).includes('blocking:criteria')); assert.ok(rules(r).includes('blocking:defect'));
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => /## Implementation brief is missing/.test(f.text)));
  });

  it('a citation to a file that is not there, or past its end, blocks; without a repo it is an advisory', (t) => {
    const root = tmp('ticketlint-'); t.after(() => rm(root));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'orders.ts'), 'a\n');
    const r = lintTicket(GOOD.replace('`src/orders.ts:3`', '`src/orders.ts:3`, `src/gone.ts:1`'), { repos: [root] });
    assert.deepEqual(r.findings.filter((f) => f.rule === 'citations').map((f) => f.text), ['`src/orders.ts:3`: the file is shorter than that', '`src/gone.ts:1` is not in the repo']);
    assert.deepEqual(rules(lintTicket(GOOD)), ['advisory:citations']);
  });

  it('personal data — an email, a phone number — blocks', () => {
    assert.ok(rules(lintTicket(`${GOOD}\nReported by ann@example.com`)).includes('blocking:personal-data'));
    assert.ok(rules(lintTicket(`${GOOD}\nCall +971 50 123 4567`)).includes('blocking:personal-data'));
    assert.ok(!rules(lintTicket(GOOD)).includes('blocking:personal-data'), 'a date and a build number are not a phone number');
  });

  it('the command exits 1 on a blocking finding and 2 without a draft', (t) => {
    const root = tmp('ticketlint-'); t.after(() => rm(root));
    const f = join(root, 'draft.md'); writeFileSync(f, '## Problem\nx\n');
    assert.equal(spawnSync(process.execPath, [script('ticketlint.mjs'), f], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [script('ticketlint.mjs')], { encoding: 'utf8' }).status, 2);
  });
});
