import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  profileBootstrapStatus, reconcileProfileBootstrap,
} from '../src/profile-bootstrap.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const profileRoot = path.join(root, 'profile');
  await fs.mkdir(home);
  await fs.mkdir(profileRoot);
  const bootstrap = path.join(profileRoot, 'bootstrap.md');
  await fs.writeFile(bootstrap, '# Private bootstrap\n');
  return {
    context: {
      home,
      stateDir: path.join(home, '.local/state/personal-agent-control'),
    },
    profile: { bootstrap },
  };
}

test('Profile bootstrap is installed, checked, updated, and removed with ownership', async (t) => {
  const { context, profile } = await fixture(t);
  const installed = await reconcileProfileBootstrap(context, profile);
  assert.equal(installed.action, 'installed');
  assert.equal((await profileBootstrapStatus(context, profile)).valid, true);

  await fs.writeFile(profile.bootstrap, '# Updated private bootstrap\n');
  const updated = await reconcileProfileBootstrap(context, profile);
  assert.equal(updated.action, 'updated');
  assert.match(await fs.readFile(updated.target, 'utf8'), /Updated/);

  const removed = await reconcileProfileBootstrap(context, null);
  assert.equal(removed.action, 'removed');
  assert.equal((await profileBootstrapStatus(context, null)).valid, true);
});

test('Profile bootstrap refuses unmanaged collisions and managed drift', async (t) => {
  const { context, profile } = await fixture(t);
  const target = path.join(context.home, '.config/personal-agent-control/profile-bootstrap.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'unmanaged\n');
  await assert.rejects(
    reconcileProfileBootstrap(context, profile),
    (error) => error.code === 'PROFILE_BOOTSTRAP_COLLISION',
  );

  await fs.rm(target);
  await reconcileProfileBootstrap(context, profile);
  await fs.writeFile(target, 'drifted\n');
  await assert.rejects(
    reconcileProfileBootstrap(context, profile),
    (error) => error.code === 'PROFILE_BOOTSTRAP_DRIFT',
  );
});
