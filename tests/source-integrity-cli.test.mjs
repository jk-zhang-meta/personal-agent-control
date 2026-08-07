import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function snapshot(root) {
  const result = [];
  async function collect(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await collect(absolute, relative);
      else if (entry.isFile() && !entry.isSymbolicLink()) result.push([relative, await fs.readFile(absolute, 'base64')]);
      else if (entry.isSymbolicLink()) result.push([relative, `link:${await fs.readlink(absolute)}`]);
    }
  }
  await collect(root);
  return result;
}

async function fixture(t, redirected) {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pac-source-cli-')));
  const root = path.join(temporary, 'repo');
  const home = path.join(temporary, 'home');
  mkdirSync(home);
  await fs.cp(sourceRepo, root, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const relative = path.relative(sourceRepo, source);
      return relative !== '.git' && !relative.startsWith(`.git${path.sep}`);
    },
  });
  const target = redirected === 'catalog'
    ? path.join(root, 'catalog')
    : path.join(root, 'payload/skills');
  const external = path.join(temporary, `external-${redirected}`);
  renameSync(target, external);
  symlinkSync(external, target, 'dir');
  const fakeApm = path.join(temporary, 'apm');
  const fakeDoctor = path.join(temporary, 'doctor');
  writeFileSync(fakeApm, '#!/bin/sh\n[ "${1:-}" = --version ] && { echo "APM 0.28.0"; exit 0; }\nexit 99\n', { mode: 0o755 });
  writeFileSync(fakeDoctor, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  return { root, home, external, fakeApm, fakeDoctor };
}

function run(value, command) {
  const result = spawnSync(path.join(value.root, 'bin/pac'), ['--json', '--home', value.home, command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: value.home,
      PAC_NODE: process.execPath,
      PAC_APM: value.fakeApm,
      PAC_DOCTOR: value.fakeDoctor,
      PAC_NO_PLUGINS: '1',
    },
  });
  return { result, body: JSON.parse(result.stdout) };
}

for (const redirected of ['payload-skills', 'catalog']) {
  test(`apply, status, and doctor reject a symlinked canonical ${redirected} root`, async (t) => {
    const value = await fixture(t, redirected);
    const before = await snapshot(value.external);

    const status = run(value, 'status');
    assert.equal(status.result.status, 1, status.result.stderr);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.data.sourceIntegrity.valid, false);
    assert.equal(status.body.data.sourceIntegrity.code, 'SOURCE_INTEGRITY_INVALID');

    const apply = run(value, 'apply');
    assert.equal(apply.result.status, 1, apply.result.stderr);
    assert.equal(apply.body.error.code, 'SOURCE_INTEGRITY_INVALID');

    const doctor = run(value, 'doctor');
    assert.equal(doctor.result.status, 1, doctor.result.stderr);
    assert.equal(doctor.body.error.code, 'DOCTOR_FAILED');
    assert.equal(doctor.body.error.details.status.sourceIntegrity.code, 'SOURCE_INTEGRITY_INVALID');

    assert.deepEqual(await snapshot(value.external), before);
    assert.equal(existsSync(path.join(value.home, '.local/share/agent-skills')), false);
    assert.equal(existsSync(path.join(value.home, '.agents')), false);
    assert.equal(existsSync(path.join(value.home, '.claude')), false);
  });
}
