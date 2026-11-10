import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeStalePluginCatalogs } from '../src/plugins.mjs';

test('only day-old filtered-catalog directories left by a killed run are removed', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pac-catalog-sweep-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
  const stale = path.join(stateDir, 'plugin-catalog-AbC123');
  const recent = path.join(stateDir, 'plugin-catalog-xyZ789');
  const unrelated = path.join(stateDir, 'plugin-catalog-notes-kept');
  const file = path.join(stateDir, 'plugin-catalog-fIle00');
  for (const directory of [stale, recent, unrelated]) await fs.mkdir(directory);
  await fs.writeFile(path.join(stale, 'plugins.tsv'), '# header\n');
  await fs.writeFile(file, 'not a directory\n');
  for (const old of [stale, unrelated, file]) await fs.utimes(old, twoDaysAgo, twoDaysAgo);

  assert.deepEqual(await removeStalePluginCatalogs({ stateDir }, now), [stale]);
  assert.deepEqual((await fs.readdir(stateDir)).sort(), [
    'plugin-catalog-fIle00', 'plugin-catalog-notes-kept', 'plugin-catalog-xyZ789',
  ]);
  assert.deepEqual(await removeStalePluginCatalogs({ stateDir: path.join(stateDir, 'absent') }, now), []);
});
