import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  installProfileApm,
  profileApmProvisionalEntries,
  profileApmStatus,
} from '../src/profile-apm.mjs';

const EMPTY_STATUS = {
  configured: false,
  valid: true,
  skills: [],
  runtimeStore: null,
};

test('no Profile or empty Profile APM dependencies is valid without touching APM context', async () => {
  const unusedContext = new Proxy({}, {
    get(_target, property) {
      throw new Error(`unexpected context access: ${String(property)}`);
    },
  });
  const emptyProfile = { apm: { dependencies: [] } };

  assert.deepEqual(await installProfileApm(unusedContext, null), EMPTY_STATUS);
  assert.deepEqual(await profileApmStatus(unusedContext, null), EMPTY_STATUS);
  assert.deepEqual(await installProfileApm(unusedContext, emptyProfile), EMPTY_STATUS);
  assert.deepEqual(await profileApmStatus(unusedContext, emptyProfile), EMPTY_STATUS);
});

test('profileApmProvisionalEntries derives profile-apm identities from the lock', () => {
  const profile = {
    apm: {
      lock: {
        dependencies: [
          { name: 'research', virtualPath: 'skills/research-private' },
          { name: 'drawio', virtualPath: null },
        ],
      },
    },
  };

  assert.deepEqual(profileApmProvisionalEntries(profile), [
    {
      id: 'research',
      physicalName: 'research-private',
      engine: 'profile-apm',
      targets: ['codex', 'claude'],
    },
    {
      id: 'drawio',
      physicalName: 'drawio',
      engine: 'profile-apm',
      targets: ['codex', 'claude'],
    },
  ]);
  assert.deepEqual(profileApmProvisionalEntries(null), []);
});

test('configured Profile APM status fails closed when its runtime is missing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pac-profile-apm-status-'));
  const home = join(root, 'home');
  const runtimeBase = join(home, '.local', 'share', 'profile-apm-runtimes');
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const profile = {
    root: join(root, 'profile'),
    lockedCommit: 'a'.repeat(40),
    descriptor: { repository: 'ssh://example.invalid/private-profile.git' },
    apm: {
      dependencies: ['example/managed-skill'],
      lock: {
        dependencies: [
          { name: 'managed-skill', virtualPath: 'skills/managed-skill' },
        ],
      },
    },
  };

  const status = await profileApmStatus({ home, profileRuntimeStoreDir: runtimeBase }, profile);

  assert.equal(status.configured, true);
  assert.equal(status.valid, false);
  assert.equal(status.state, 'missing');
  assert.equal(status.dependencies, 1);
  assert.deepEqual(status.skills, []);
  assert.equal(status.code, undefined);
  assert.equal(status.error, undefined);
  assert.equal(status.runtimeStore.startsWith(`${runtimeBase}/`), true);
  assert.equal(existsSync(status.runtimeStore), false);
});
