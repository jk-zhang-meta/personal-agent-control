import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerDeploymentStatus, synchronizeProvider } from '../src/provider-deployment.mjs';
import { PROVIDER_CLIENTS, reconcileProviders } from '../src/providers.mjs';
import { HOSTS } from '../src/config.mjs';

const paths = { codex: '.codex/config.toml', claude: '.claude.json', agy: '.gemini/config/mcp_config.json', grok: '.grok/config.toml' };
const original = { codex: '# mcp_servers = { playwright = { command = "comment only" } }\nmodel = "keep"\n[mcp_servers.other]\ncommand = "keep"\nargs = []\n',
  claude: '{"theme":"keep","mcpServers":{"other":{"command":"keep"}}}\n',
  agy: '', grok: 'disabled_mcp_servers = ["other"]\n\n[mcp_servers.other]\ncommand = "keep"\nargs = []\nenabled = false\n' };

async function fixture(t, enabled = ['playwright']) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pac-provider-only-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home');
  const repository = path.join(temporary, 'profile');
  await fs.mkdir(home);
  await fs.mkdir(repository);
  for (const client of PROVIDER_CLIENTS) {
    const file = path.join(home, paths[client]);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original[client], { mode: 0o640 });
  }
  await fs.writeFile(path.join(repository, 'pac-profile.json'), JSON.stringify({ schemaVersion: 3, bootstrap: null,
    skills: [], plugins: { enabled: [], disabled: [] }, providers: { enabled } }));
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'PAC Tests');
  git('config', 'user.email', 'pac-tests@example.invalid');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Provider fixture');
  const mise = path.join(home, 'mise');
  await fs.writeFile(mise, '#!/bin/sh\ncase "$*" in\n "exec -- codegraph --version") echo 1.6.0 ;;\n "exec -- playwright-mcp --version") echo "Version 0.0.83" ;;\n *) exit 42 ;;\nesac\n', { mode: 0o700 });
  const context = { root: process.cwd(), home, stateDir: path.join(home, '.local/state/personal-agent-control'), mise, platform: 'darwin', isWsl: false };
  const options = { name: 'playwright', repository, commit: git('rev-parse', 'HEAD'), clients: [...PROVIDER_CLIENTS] };
  return { home, context, options, file: (client) => path.join(home, paths[client]), owner: path.join(context.stateDir, 'owned-providers.json') };
}

test('provider-only delivery round-trips all four clients, preserves CodeGraph/native values and is idempotent', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(HOSTS, ['codex', 'claude']);
  await reconcileProviders(f.context, { manifest: { providers: { enabled: ['codegraph'] } } }, HOSTS, HOSTS);
  const priorOwned = JSON.parse(await fs.readFile(f.owner, 'utf8')).providers.codegraph;
  const priorClaude = JSON.parse(await fs.readFile(f.file('claude'), 'utf8')).mcpServers.codegraph;
  const priorModes = await Promise.all(PROVIDER_CLIENTS.map(async (client) => (await fs.stat(f.file(client))).mode & 0o777));
  const result = await synchronizeProvider(f.context, f.options);
  assert.equal(result.ok, true);
  assert.equal(result.providers.length, 4);
  assert.equal(result.profileCommit, f.options.commit);
  assert.deepEqual(JSON.parse(await fs.readFile(f.owner, 'utf8')).providers.codegraph, priorOwned);
  const claude = JSON.parse(await fs.readFile(f.file('claude'), 'utf8'));
  assert.equal(claude.theme, 'keep');
  assert.deepEqual(claude.mcpServers.codegraph, priorClaude);
  assert.deepEqual(claude.mcpServers.other, { command: 'keep' });
  const agy = JSON.parse(await fs.readFile(f.file('agy'), 'utf8'));
  assert.equal(agy.mcpServers.playwright.command, f.context.mise);
  assert.equal(agy.mcpServers.playwright.type, undefined);
  assert.match(await fs.readFile(f.file('grok'), 'utf8'), /disabled_mcp_servers = \["other"\]/u);
  assert.match(await fs.readFile(f.file('grok'), 'utf8'), /\[mcp_servers.playwright\][\s\S]*enabled = true/u);
  for (const [index, client] of PROVIDER_CLIENTS.entries()) assert.equal((await fs.stat(f.file(client))).mode & 0o777, priorModes[index]);
  const beforeStatus = await Promise.all([...PROVIDER_CLIENTS.map(f.file), f.owner].map((file) => fs.stat(file)));
  const status = await providerDeploymentStatus(f.context, f.options);
  assert.equal(status.ok, true);
  assert.deepEqual(status.clients, PROVIDER_CLIENTS);
  assert.ok(status.providers.every((row) => row.owned && row.profileCommit === f.options.commit));
  const afterStatus = await Promise.all([...PROVIDER_CLIENTS.map(f.file), f.owner].map((file) => fs.stat(file)));
  assert.deepEqual(afterStatus.map((s) => [s.ino, s.mtimeMs]), beforeStatus.map((s) => [s.ino, s.mtimeMs]));
  assert.equal((await synchronizeProvider(f.context, f.options)).changed, 0);
  const grok = await fs.readFile(f.file('grok'), 'utf8');
  await fs.writeFile(f.file('grok'), grok.replace('disabled_mcp_servers = ["other"]', 'disabled_mcp_servers = ["other", "playwright"]'));
  assert.equal((await providerDeploymentStatus(f.context, f.options)).ok, false);
  await assert.rejects(synchronizeProvider(f.context, f.options), { code: 'PROVIDER_DRIFT' });
});

test('unmanaged conflicts and explicit disables are preserved before any client projection', async (t) => {
  for (const client of PROVIDER_CLIENTS) {
    const f = await fixture(t);
    const conflict = client === 'codex' ? '[mcp_servers."playwright"] # native quoted key\ncommand = "native"\nargs = []\n'
      : client === 'grok' ? 'disabled_mcp_servers = ["playwright"]\n'
        : JSON.stringify({ mcpServers: { playwright: { command: 'native', args: [], disabled: true } } });
    await fs.writeFile(f.file(client), conflict);
    await assert.rejects(synchronizeProvider(f.context, f.options), { code: 'PROVIDER_CONFLICT' });
    for (const current of PROVIDER_CLIENTS) assert.equal(await fs.readFile(f.file(current), 'utf8'), current === client ? conflict : original[current]);
    await assert.rejects(fs.access(f.owner), { code: 'ENOENT' });
  }
});

test('inline and dotted MCP declarations fail closed without config or ownership changes', async (t) => {
  const forms = [
    'mcp_servers = { playwright = { command = "native", args = ["keep"] } }\n',
    'mcp_servers.playwright.command = "native"\nmcp_servers.playwright.args = ["keep"]\n',
    '[mcp_servers]\nplaywright = { command = "native", args = ["keep"] }\n',
    '[mcp_servers]\nplaywright.command = "native"\nplaywright.args = ["keep"]\n',
    '"mcp_servers" = { "playwright" = { command = "native", args = ["keep"] } }\n',
    "'mcp_servers' . 'playwright' . command = 'native'\n",
    '[ "mcp_servers" ] # native parent table\n"playwright" = { command = "native", args = ["keep"] }\n',
    "[ 'mcp_servers' ]\n'playwright'.command = 'native'\n",
  ];
  for (const client of ['codex', 'grok']) {
    const f = await fixture(t);
    for (const content of forms) {
      await fs.writeFile(f.file(client), content);
      await assert.rejects(synchronizeProvider(f.context, f.options), { code: 'PROVIDER_CONFIG_INVALID' });
      for (const current of PROVIDER_CLIENTS) assert.equal(await fs.readFile(f.file(current), 'utf8'), current === client ? content : original[current]);
      await assert.rejects(fs.access(f.owner), { code: 'ENOENT' });
    }
  }
});

test('late ownership replacement failure rolls back all config bytes and metadata', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.context.stateDir, { recursive: true });
  const owned = '{"schemaVersion":1,"providers":{"codegraph":{"codex":{"command":"keep","args":[]}}}}\n';
  await fs.writeFile(f.owner, owned, { mode: 0o640 });
  const allFiles = [...PROVIDER_CLIENTS.map(f.file), f.owner];
  const before = await Promise.all(allFiles.map((file) => fs.stat(file)));
  const rename = fs.rename;
  let injected = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!injected && to === f.owner && path.basename(from).startsWith('.pac-provider-')) {
      injected = true;
      throw Object.assign(new Error('late ownership failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(synchronizeProvider(f.context, f.options), { code: 'EIO' });
  assert.equal(injected, true);
  for (const client of PROVIDER_CLIENTS) assert.equal(await fs.readFile(f.file(client), 'utf8'), original[client]);
  assert.equal(await fs.readFile(f.owner, 'utf8'), owned);
  for (const [index, file] of allFiles.entries()) {
    const after = await fs.stat(file);
    assert.equal(after.mode, before[index].mode);
    assert.equal(after.uid, before[index].uid);
    assert.equal(after.gid, before[index].gid);
    assert.ok(Math.abs(after.mtimeMs - before[index].mtimeMs) < 1);
  }
});

test('a concurrent native edit aborts sync and survives rollback of earlier writes', async (t) => {
  const f = await fixture(t);
  const rename = fs.rename;
  let injected = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    const result = await rename(from, to);
    if (!injected && to === f.file('codex')) {
      injected = true;
      await fs.writeFile(f.file('grok'), '# concurrent native edit\n');
    }
    return result;
  });
  await assert.rejects(synchronizeProvider(f.context, f.options), { code: 'PROVIDER_RACE' });
  assert.equal(injected, true);
  assert.equal(await fs.readFile(f.file('grok'), 'utf8'), '# concurrent native edit\n');
  for (const client of ['codex', 'claude', 'agy']) assert.equal(await fs.readFile(f.file(client), 'utf8'), original[client]);
  await assert.rejects(fs.access(f.owner), { code: 'ENOENT' });
});

test('provider delivery rejects absent Profile enablement, skipped version checks and symlinked native paths', async (t) => {
  const disabled = await fixture(t, []);
  await assert.rejects(synchronizeProvider(disabled.context, disabled.options), { code: 'PROVIDER_NOT_SELECTED' });
  const f = await fixture(t);
  const previous = process.env.PAC_PROVIDER_NO_VERSION_CHECK;
  process.env.PAC_PROVIDER_NO_VERSION_CHECK = '1';
  try { await assert.rejects(synchronizeProvider(f.context, f.options), { code: 'PROVIDER_VERSION_REQUIRED' }); }
  finally {
    if (previous === undefined) delete process.env.PAC_PROVIDER_NO_VERSION_CHECK;
    else process.env.PAC_PROVIDER_NO_VERSION_CHECK = previous;
  }
  await fs.rename(path.join(f.home, '.gemini/config'), path.join(f.home, '.gemini/original'));
  await fs.symlink('original', path.join(f.home, '.gemini/config'));
  await assert.rejects(synchronizeProvider(f.context, f.options), { code: 'PATH_UNSAFE' });
  await assert.rejects(fs.access(f.owner), { code: 'ENOENT' });
});
