import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostAdapterStatus } from '../src/host-adapters.mjs';
import { reconcilePlugins } from '../src/plugins.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t, host) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `pac-${host}-path-`)));
  const home = path.join(root, 'home');
  const external = path.join(root, 'external');
  await fs.mkdir(home);
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'sentinel'), 'preserve\n');
  await fs.symlink(external, path.join(home, host === 'codex' ? '.codex' : '.claude'), 'dir');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    context: {
      root: repo,
      home,
      stateDir: path.join(home, '.local/state/personal-agent-control'),
    },
    external,
  };
}

function configFor(host) {
  return {
    hosts: {
      codex: { enabled: host === 'codex' },
      claude: { enabled: host === 'claude' },
    },
    plugins: { enabled: [] },
  };
}

for (const host of ['codex', 'claude']) {
  test(`active ${host} diagnostics reject redirected adapter and Plugin surfaces`, async (t) => {
    const { context, external } = await fixture(t, host);

    await assert.rejects(
      hostAdapterStatus(context, [host], [host]),
      (error) => error.code === 'PATH_UNSAFE',
    );
    await assert.rejects(
      reconcilePlugins(context, configFor(host), [host], 'check'),
      (error) => error.code === 'PATH_UNSAFE',
    );

    assert.equal(await fs.readFile(path.join(external, 'sentinel'), 'utf8'), 'preserve\n');
    assert.deepEqual(await hostAdapterStatus(context, [], []), []);
    assert.deepEqual(
      await reconcilePlugins(context, configFor(host), [], 'check'),
      { skipped: true, reason: 'no-enabled-hosts' },
    );
  });
}
