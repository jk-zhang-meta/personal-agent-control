import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { stageDependencies, renderManifest } from '../src/apm.mjs';
import { syncSkillCapabilities } from '../src/capabilities.mjs';

async function preplantOldTemporary(target, sentinel) {
  await fs.symlink(sentinel, `${target}.${process.pid}.tmp`);
}

test('source metadata replacements ignore preplanted predictable temporary symlinks', async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pac-atomic-source-')));
  const root = path.join(temporary, 'repo');
  const catalog = path.join(root, 'catalog');
  const manifestDir = path.join(root, 'packages/skills');
  const stateDir = path.join(temporary, 'state');
  const sentinel = path.join(temporary, 'external-sentinel');
  const overlay = path.join(catalog, 'capabilities.jsonl');
  const integrity = path.join(catalog, 'files.sha256');
  const manifest = path.join(manifestDir, 'apm.yml');
  const lock = path.join(manifestDir, 'apm.lock.yaml');
  const fakeApm = path.join(temporary, 'fake-apm');
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  await Promise.all([
    fs.mkdir(catalog, { recursive: true }),
    fs.mkdir(manifestDir, { recursive: true }),
    fs.mkdir(path.join(root, 'payload'), { recursive: true }),
    fs.mkdir(stateDir, { recursive: true }),
  ]);
  await fs.writeFile(sentinel, 'do not overwrite\n');
  await fs.writeFile(overlay, '');
  await fs.writeFile(integrity, `${'0'.repeat(64)}  catalog/capabilities.jsonl\n`);
  await fs.writeFile(manifest, renderManifest(['initial/example']));
  await fs.writeFile(lock, 'apm_version: 0.28.0\ndependencies:\n- repo_url: initial\n  name: initial\n');
  await fs.writeFile(fakeApm, `#!/bin/sh
set -eu
mkdir -p apm_modules/demo
cat > apm_modules/demo/SKILL.md <<'EOF'
---
name: demo
description: fixture
---
EOF
cat > apm.lock.yaml <<'EOF'
apm_version: 0.28.0
dependencies:
- repo_url: fixture
  name: demo
EOF
`, { mode: 0o755 });

  for (const target of [overlay, integrity, manifest, lock]) {
    await preplantOldTemporary(target, sentinel);
  }

  const context = { root, stateDir, manifestDir, manifestPath: manifest, lockPath: lock, apm: fakeApm };
  await syncSkillCapabilities(context, [], ['demo']);
  await stageDependencies(context, ['fixture/demo']);

  assert.equal(await fs.readFile(sentinel, 'utf8'), 'do not overwrite\n');
  assert.match(await fs.readFile(overlay, 'utf8'), /"id":"skill:demo"/u);
  assert.match(await fs.readFile(manifest, 'utf8'), /fixture\/demo/u);
  assert.match(await fs.readFile(lock, 'utf8'), /name: demo/u);
});
