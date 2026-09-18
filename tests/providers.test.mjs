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
  const previousVersion = process.env.PAC_PROVIDER_NO_VERSION_CHECK;
  process.env.PAC_PROVIDER_NO_UPGRADE = '1';
  process.env.PAC_PROVIDER_NO_VERSION_CHECK = '1';
  try {
    const applied = await reconcileProviders(context, profile, ['codex', 'claude'], ['codex', 'claude']);
    assert.equal(applied.valid, true);
    const status = await providerStatus(context, profile, ['codex', 'claude'], ['codex', 'claude']);
    assert.equal(status.every((entry) => entry.valid), true);
    const codex = await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8');
    assert.match(codex, /model = "test"/u);
    assert.match(codex, /\[mcp_servers\.codegraph\]/u);
    assert.match(codex, /codegraph.*serve.*--mcp/u);
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.theme, 'dark');
    assert.equal(claude.mcpServers.codegraph.command, 'mise');
    assert.deepEqual(claude.mcpServers.codegraph.args, ['--cd', root, 'exec', '--', 'codegraph', 'serve', '--mcp', '--no-watch']);
    const ownership = JSON.parse(await fs.readFile(path.join(stateDir, 'owned-providers.json'), 'utf8'));
    assert.deepEqual(Object.keys(ownership.providers.codegraph).sort(), ['claude', 'codex']);
  } finally {
    if (previous === undefined) delete process.env.PAC_PROVIDER_NO_UPGRADE;
    else process.env.PAC_PROVIDER_NO_UPGRADE = previous;
    if (previousVersion === undefined) delete process.env.PAC_PROVIDER_NO_VERSION_CHECK;
    else process.env.PAC_PROVIDER_NO_VERSION_CHECK = previousVersion;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CodeGraph version check uses the PAC mise launcher even when mise is absent from PATH', {
  skip: process.platform === 'win32',
}, async () => {
  const home = await temp('pac-provider-mise-home-');
  const root = process.cwd();
  const stateDir = path.join(home, '.local/state/personal-agent-control');
  const mise = path.join(home, '.local/bin/mise');
  await fs.mkdir(path.dirname(mise), { recursive: true });
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(mise, '#!/bin/sh\nprintf "1.6.0\\n"\n', { mode: 0o700 });
  await fs.writeFile(path.join(home, '.codex/config.toml'), '');
  await fs.writeFile(path.join(home, '.claude.json'), '{}\n');
  const context = { root, home, stateDir, mise };
  const profile = { manifest: { providers: { enabled: ['codegraph'] } } };
  const previousUpgrade = process.env.PAC_PROVIDER_NO_UPGRADE;
  const previousPath = process.env.PATH;
  process.env.PAC_PROVIDER_NO_UPGRADE = '1';
  process.env.PATH = '/usr/bin:/bin';
  try {
    const applied = await reconcileProviders(context, profile, ['codex', 'claude'], ['codex', 'claude']);
    assert.equal(applied.valid, true);
    assert.equal(applied.providers.every((entry) => entry.version.matches), true);
  } finally {
    if (previousUpgrade === undefined) delete process.env.PAC_PROVIDER_NO_UPGRADE;
    else process.env.PAC_PROVIDER_NO_UPGRADE = previousUpgrade;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CodeGraph provider retirement removes only the PAC-owned entries', async () => {
  const home = await temp('pac-provider-retire-');
  const root = process.cwd();
  const stateDir = path.join(home, '.local/state/personal-agent-control');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex/config.toml'), '[mcp_servers.codegraph]\ncommand = "mise"\nargs = ["--cd",' + JSON.stringify(root) + ',"exec","--","codegraph","serve","--mcp","--no-watch"]\n\n[projects."/tmp"]\ntrust_level = "trusted"\n');
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'mise', args: ['--cd', root, 'exec', '--', 'codegraph', 'serve', '--mcp', '--no-watch'] } }, other: true }));
  const context = { root, home, stateDir };
  const profile = { manifest: { providers: { enabled: ['codegraph'] } } };
  const previous = process.env.PAC_PROVIDER_NO_UPGRADE;
  const previousVersion = process.env.PAC_PROVIDER_NO_VERSION_CHECK;
  process.env.PAC_PROVIDER_NO_UPGRADE = '1';
  process.env.PAC_PROVIDER_NO_VERSION_CHECK = '1';
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
    if (previousVersion === undefined) delete process.env.PAC_PROVIDER_NO_VERSION_CHECK;
    else process.env.PAC_PROVIDER_NO_VERSION_CHECK = previousVersion;
    await fs.rm(home, { recursive: true, force: true });
  }
});
