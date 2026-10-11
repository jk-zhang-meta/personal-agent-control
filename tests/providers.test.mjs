import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerStatus, reconcileProviders } from '../src/providers.mjs';
import { rebuildIndex, checkIndex } from '../payload/skills/capability-resolver/scripts/lib/index.mjs';

test('the actual Core provider catalog rebuilds the resolver index', async () => {
  const home = await temp('pac-provider-resolver-');
  const repo = process.cwd();
  const dbPath = path.join(home, '.cache/personal-agent-control/capabilities-v1.sqlite');
  try {
    for (const name of ['capability-resolver', 'graph-workflow']) {
      const target = path.join(home, '.local/share/agent-skills/.agents/skills', name);
      await fs.mkdir(target, { recursive: true });
      await fs.copyFile(path.join(repo, 'payload/skills', name, 'SKILL.md'), path.join(target, 'SKILL.md'));
    }
    assert.equal((await rebuildIndex({ repo, home, dbPath })).ok, true);
    assert.equal((await checkIndex({ repo, home, dbPath })).ok, true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('Playwright uses its pinned version probe and isolated host-local configuration without changing CodeGraph', async () => {
  const home = await temp('pac-playwright-home-');
  const root = process.cwd();
  const stateDir = path.join(home, '.local/state/personal-agent-control');
  const mise = path.join(home, 'mise');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  const unrelated = '[mcp_servers.other]\ncommand = "keep"\nargs = []\n';
  await fs.writeFile(path.join(home, '.codex/config.toml'), unrelated);
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'keep' } } }));
  await fs.writeFile(mise, '#!/bin/sh\ncase "$*" in\n "exec -- codegraph --version") echo 1.6.0 ;;\n "exec -- playwright-mcp --version") echo "Version 0.0.83" ;;\n *) exit 42 ;;\nesac\n', { mode: 0o700 });
  const context = { root, home, stateDir, mise, platform: 'darwin', isWsl: false };
  const both = { manifest: { providers: { enabled: ['codegraph', 'playwright'] } } };
  try {
    const applied = await reconcileProviders(context, both, ['codex', 'claude'], ['codex', 'claude']);
    assert.equal(applied.providers.length, 4);
    assert.equal(applied.providers.every((entry) => entry.version.matches), true);
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.theme, 'dark');
    assert.deepEqual(claude.mcpServers.other, { command: 'keep' });
    assert.equal(claude.mcpServers.playwright.command, mise);
    assert.equal(claude.mcpServers.codegraph.command, mise);
    assert.deepEqual(claude.mcpServers.playwright.args, ['--cd', root, 'exec', '--', 'playwright-mcp', '--browser', 'chrome', '--headless', '--isolated', '--output-dir', path.join(home, '.agent-work/browser-automation/mcp')]);
    assert.deepEqual(claude.mcpServers.codegraph.args, ['--cd', root, 'exec', '--', 'codegraph', 'serve', '--mcp', '--no-watch']);
    assert.ok((await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')).startsWith(unrelated));
    const codex = await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8');
    assert.equal(codex.split(`command = ${JSON.stringify(mise)}`).length - 1, 2);
    assert.equal((await providerStatus(context, both, ['codex', 'claude'], ['codex', 'claude'])).every((entry) => entry.valid), true);
    await fs.writeFile(mise, '#!/bin/sh\necho "Version 0.0.82"\n', { mode: 0o700 });
    await assert.rejects(reconcileProviders(context, { manifest: { providers: { enabled: ['playwright'] } } }, ['codex'], ['codex']), { code: 'PROVIDER_VERSION_INVALID' });
    await fs.writeFile(mise, '#!/bin/sh\necho 1.6.0\n', { mode: 0o700 });
    await reconcileProviders({ ...context, isWsl: true }, { manifest: { providers: { enabled: ['codegraph'] } } }, ['codex', 'claude'], ['codex', 'claude']);
    const retired = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(retired.mcpServers.playwright, undefined);
    assert.deepEqual(retired.mcpServers.codegraph, claude.mcpServers.codegraph);
    assert.deepEqual(retired.mcpServers.other, { command: 'keep' });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

async function temp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('unmanaged conflicting Playwright entries are preserved for both hosts before any projection', async () => {
  for (const host of ['codex', 'claude']) {
    const home = await temp('pac-playwright-conflict-');
    const stateDir = path.join(home, '.local/state/personal-agent-control');
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    const codex = host === 'codex' ? '[mcp_servers.playwright]\ncommand = "native"\nargs = ["keep"]\n' : 'model = "keep"\n';
    const claude = host === 'claude' ? '{"mcpServers":{"playwright":{"command":"native","args":["keep"]}}}\n' : '{}\n';
    await fs.writeFile(path.join(home, '.codex/config.toml'), codex);
    await fs.writeFile(path.join(home, '.claude.json'), claude);
    try {
      await assert.rejects(reconcileProviders({ root: process.cwd(), home, stateDir, platform: 'darwin', isWsl: false },
        { manifest: { providers: { enabled: ['playwright'] } } }, ['codex', 'claude'], ['codex', 'claude']), { code: 'PROVIDER_CONFLICT' });
      assert.equal(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8'), codex);
      assert.equal(await fs.readFile(path.join(home, '.claude.json'), 'utf8'), claude);
      await assert.rejects(fs.access(path.join(stateDir, 'owned-providers.json')), { code: 'ENOENT' });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
});

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
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.mcpServers.codegraph.command, mise);
    assert.ok((await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')).includes(`command = ${JSON.stringify(mise)}`));
    assert.equal((await providerStatus(context, profile, ['codex', 'claude'], ['codex', 'claude'])).every((entry) => entry.valid), true);
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
