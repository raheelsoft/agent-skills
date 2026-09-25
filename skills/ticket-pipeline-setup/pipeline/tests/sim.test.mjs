// tests/sim/setup.mjs — the simulation bed builds an install the doctor passes and the fixture tracker serves.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR, rm } from './helpers.mjs';
import { setup } from './sim/setup.mjs';

describe('the simulation bed', () => {
  let bed;
  after(() => { if (bed) rm(bed.root); });

  it('builds an install whose doctor passes and whose tracker lists the fixture', () => {
    bed = setup();
    for (const p of ['skills/README.md', 'skills/_lib/state.mjs', 'workflows/tp-run-ticket-unattended.js', 'tests/helpers.mjs', 'office/serve.mjs', 'tiers.json', 'tracker.json', 'office.json', 'notify.json', 'settings.local.json']) assert.ok(existsSync(join(bed.claude, p)), p);
    assert.ok(!existsSync(join(bed.claude, 'office', 'electron', 'node_modules')), 'no node_modules copied');
    assert.ok(existsSync(join(bed.repos.api, 'CLAUDE.md')) && existsSync(join(bed.repos.web, 'src', 'app.js')));
    const doctor = spawnSync(process.execPath, [join(CLAUDE_DIR, 'skills', '_lib', 'doctor.mjs'), 'run', bed.claude, '--repos', `${bed.repos.api},${bed.repos.web}`], { encoding: 'utf8' });
    const d = JSON.parse(doctor.stdout);
    assert.equal(d.ok, true, JSON.stringify(d.checks.filter((c) => c.status === 'fail')));
    assert.match(d.checks.find((c) => c.name === 'repo api').detail, /base main/);
    const list = spawnSync(process.execPath, [join(bed.claude, 'skills', '_lib', 'tracker.mjs'), 'list', '--open', '--iteration', 'Sprint 4'], { encoding: 'utf8' });
    assert.equal(JSON.parse(list.stdout).length, 6, 'the copied fixture answers through the bed\'s own tracker.json');
    assert.equal(readFileSync(join(bed.claude, 'tracker.json'), 'utf8').includes('tracker.fixture.json'), true);
  });
});
