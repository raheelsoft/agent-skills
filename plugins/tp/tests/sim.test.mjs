// tests/sim/setup.mjs — the simulation bed builds a project the doctor passes and the fixture tracker serves; the plugin is not copied into it.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, rm, script } from './helpers.mjs';
import { setup } from './sim/setup.mjs';

describe('the simulation bed', () => {
  let bed;
  after(() => { if (bed) rm(bed.root); });

  it('builds a project whose doctor passes and whose tracker lists the fixture', () => {
    bed = setup();
    for (const p of ['tiers.json', 'tracker.json', 'tracker.fixture.json', 'hosting.json', 'hosting.fixture.json', 'office.json', 'notify.json', 'settings.local.json', 'work']) assert.ok(existsSync(join(bed.claude, p)), `${p} is in the bed's .claude`);
    for (const p of ['skills', 'lib', 'workflows', 'office', 'tests']) assert.ok(!existsSync(join(bed.claude, p)), `${p} is the plugin's: not copied into the project`);
    assert.equal(bed.plugin, PLUGIN_ROOT, 'the bed names the plugin it exercises');
    assert.ok(existsSync(join(bed.repos.api, 'CLAUDE.md')) && existsSync(join(bed.repos.web, 'src', 'app.js')));
    const doctor = spawnSync(process.execPath, [script('doctor.mjs'), 'run', bed.claude, '--repos', `${bed.repos.api},${bed.repos.web}`], { encoding: 'utf8' });
    const d = JSON.parse(doctor.stdout);
    assert.equal(d.ok, true, JSON.stringify(d.checks.filter((c) => c.status === 'fail')));
    assert.match(d.checks.find((c) => c.name === 'repo api').detail, /base main/);
    const list = spawnSync(process.execPath, [script('tracker.mjs'), 'list', '--open', '--iteration', 'Sprint 4', '--claude', bed.claude], { encoding: 'utf8' });
    assert.equal(JSON.parse(list.stdout).length, 6, 'the copied fixture answers through the bed\'s own tracker.json');
    assert.equal(readFileSync(join(bed.claude, 'tracker.json'), 'utf8').includes('tracker.fixture.json'), true);
    assert.equal(d.checks.find((c) => c.name === 'hosting CLI')?.status, 'ok', 'the hosting platform answers: the doctor\'s configured check is the fixture\'s `me`');
    assert.equal(d.checks.find((c) => c.name === 'tracker')?.status, 'ok');
    const hosting = spawnSync(process.execPath, [script('hosting.mjs'), 'pr', 'list', '--repo', 'api', '--claude', bed.claude], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(hosting.stdout), [], 'no pull request yet, over the bed\'s own remotes');
    for (const name of ['api', 'web']) assert.match(readFileSync(join(bed.repos[name], 'CLAUDE.md'), 'utf8'), /Hosting platform: the fixture in `\.claude\/hosting\.json`/, 'the conventions file says where the platform is');
  });
});
