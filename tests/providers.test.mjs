import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerStatus, reconcileProviders } from '../src/providers.mjs';

async function temp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('CodeGraph provider is projected to Codex and Claude and preserves surrounding config', async () => {
  const home = await temp('pac-provider-home-');
  const root = process.cwd();
  const stateDir = path.join(home, '.local/state/personal-agent-control');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex/config.toml'), 'model = "test"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n');
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ theme: 'dark' }, null, 2));
  const context = { root, home, stateDir };
  const profile = { manifest: { providers: { enabled: ['codegraph'] } } };
  const previous = process.env.PAC_PROVIDER_NO_UPGRADE;
  process.env.PAC_PROVIDER_NO_UPGRADE = '1';
  try {
    const applied = await reconcileProviders(context, profile, ['codex', 'claude'], ['codex', 'claude']);
    assert.equal(applied.valid, true);
    const status = await providerStatus(context, profile, ['codex', 'claude'], ['codex', 'claude']);
    assert.equal(status.every((entry) => entry.valid), true);
    const codex = await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8');
    assert.match(codex, /model = "test"/u);
    assert.match(codex, /\[mcp_servers\.codegraph\]/u);
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.theme, 'dark');
    assert.equal(claude.mcpServers.codegraph.command, 'mise');
    const ownership = JSON.parse(await fs.readFile(path.join(stateDir, 'owned-providers.json'), 'utf8'));
    assert.deepEqual(Object.keys(ownership.providers.codegraph).sort(), ['claude', 'codex']);
  } finally {
    if (previous === undefined) delete process.env.PAC_PROVIDER_NO_UPGRADE;
    else process.env.PAC_PROVIDER_NO_UPGRADE = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CodeGraph provider retirement removes only the PAC-owned entries', async () => {
  const home = await temp('pac-provider-retire-');
  const root = process.cwd();
  const stateDir = path.join(home, '.local/state/personal-agent-control');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex/config.toml'), '[mcp_servers.codegraph]\ncommand = "mise"\nargs = ["exec","--","/usr/local/bin/mw","codegraph-mcp"]\n\n[projects."/tmp"]\ntrust_level = "trusted"\n');
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'mise', args: ['exec', '--', '/usr/local/bin/mw', 'codegraph-mcp'] } }, other: true }));
  const context = { root, home, stateDir };
  const profile = { manifest: { providers: { enabled: ['codegraph'] } } };
  const previous = process.env.PAC_PROVIDER_NO_UPGRADE;
  process.env.PAC_PROVIDER_NO_UPGRADE = '1';
  try {
    await reconcileProviders(context, profile, ['codex', 'claude'], ['codex', 'claude']);
    await reconcileProviders(context, { manifest: { providers: { enabled: [] } } }, [], ['codex', 'claude']);
    assert.doesNotMatch(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8'), /mcp_servers\.codegraph/u);
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.mcpServers.codegraph, undefined);
    assert.equal(claude.other, true);
  } finally {
    if (previous === undefined) delete process.env.PAC_PROVIDER_NO_UPGRADE;
    else process.env.PAC_PROVIDER_NO_UPGRADE = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});
