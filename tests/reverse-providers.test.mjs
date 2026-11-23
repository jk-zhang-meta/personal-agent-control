import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { providerSupported, reverseRuntime, reverseVersion, reverseBinding } from '../src/reverse-provider.mjs';
import { providerStatus, reconcileProviders } from '../src/providers.mjs';

const root = process.cwd();
const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog/providers.json'), 'utf8')).providers;
const ida = catalog.find(entry => entry.name === 'ida');
const windbg = catalog.find(entry => entry.name === 'windbg');
const selected = { manifest: { providers: { enabled: ['ida', 'windbg'] } } };

test('reverse providers use native environments or explicitly supported same-host WSL', () => {
  assert.equal(providerSupported({ platform: 'darwin' }, ida), true);
  assert.equal(providerSupported({ platform: 'win32' }, ida), true);
  assert.equal(providerSupported({ platform: 'darwin' }, windbg), false);
  assert.equal(providerSupported({ platform: 'win32' }, windbg), true);
  for (const provider of [ida, windbg]) {
    assert.equal(providerSupported({ platform: 'linux', isWsl: false }, provider), false);
    assert.equal(providerSupported({ platform: 'linux', isWsl: true }, provider), true);
    assert.throws(() => reverseRuntime({ home: '/test', platform: 'linux' }, provider), { code: 'PROVIDER_PLATFORM_UNSUPPORTED' });
  }
  assert.match(reverseRuntime({ home: '/test', platform: 'win32' }, ida).python, /ida\/Scripts\/python\.exe$/u);
  assert.match(reverseRuntime({ home: '/test', platform: 'darwin' }, ida).python, /ida\/venv\/bin\/python$/u);
});

test('WSL uses argument-array local Windows discovery, distinct HOME ownership, and no credential or HTTP bridge', async () => {
  const command = '/mnt/c/Program Files/nodejs/node.exe';
  const home = 'C:\\Users\\Test User';
  const source = '\\\\wsl.localhost\\Ubuntu\\root\\core space\\src\\reverse-provider.mjs';
  const calls = [];
  const execute = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return { stdout: executable === 'wslpath' ? source : JSON.stringify({ home }) };
  };
  const context = { platform: 'linux', isWsl: true, home: '/root', root: '/root/core space' };
  const bound = await reverseBinding(context, ida, { execute, findNode: async () => command });
  assert.equal(bound.command, command);
  assert.deepEqual(bound.args, [source, 'ida', '--home', home]);
  assert.equal(context.home, '/root');
  assert.deepEqual(calls[1].args, ['-w', '/root/core space/src/reverse-provider.mjs']);
  assert.ok(calls.every(call => Array.isArray(call.args) && !call.options.shell));
  assert.deepEqual(Object.keys(bound.sameHostWindows).sort(), ['command', 'home', 'source']);
  await assert.rejects(reverseBinding(context, ida, { findNode: async () => command,
    execute: async executable => ({ stdout: executable === 'wslpath' ? source : JSON.stringify({ home: 'relative' }) }) }),
  { code: 'WINDOWS_PROVIDER_DISCOVERY_FAILED' });
  await assert.rejects(reverseBinding({ ...context, isWsl: false }, ida, { execute: async () => { throw Error('unexpected discovery'); } }),
    { code: 'PROVIDER_PLATFORM_UNSUPPORTED' });
});

test('stdio launcher closes on EOF and forwards termination to its owned process', async () => {
  const moduleUrl = pathToFileURL(path.join(root, 'src/reverse-provider.mjs')).href;
  for (const action of ['eof', 'terminate']) {
    const childCode = 'process.stdout.write(String(process.pid)+"\\n"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));';
    const code = `import {serveProcess} from ${JSON.stringify(moduleUrl)}; await serveProcess(process.execPath, ['-e', ${JSON.stringify(childCode)}], {});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    const [output] = await once(child.stdout, 'data');
    const pythonStandInPid = Number(String(output).trim());
    assert.ok(pythonStandInPid > 0);
    if (action === 'eof') child.stdin.end();
    else child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, signal] = await closed;
      assert.equal(signal, null);
      assert.equal(code, action === 'eof' ? 0 : 143);
      assert.throws(() => process.kill(pythonStandInPid, 0), { code: 'ESRCH' });
    } finally { clearTimeout(timeout); }
  }
});

test('a shared Profile skips unsupported platforms; explicit delivery fails without touching existing bindings', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-re-platform-'));
  const context = { root, home, platform: 'linux', stateDir: path.join(home, 'state') };
  const file = path.join(home, '.codex/config.toml');
  const original = '[mcp_servers.custom]\ncommand="preserve"\nargs=[]\n';
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original);
    const applied = await reconcileProviders(context, selected, ['codex'], ['codex']);
    assert.deepEqual(applied.providers.map(entry => entry.action), ['unsupported', 'unsupported']);
    const status = await providerStatus(context, selected, ['codex'], ['codex']);
    assert.ok(status.filter(entry => ['ida', 'windbg'].includes(entry.provider))
      .every(entry => entry.valid && entry.expected === 'unsupported'));
    await assert.rejects(reconcileProviders(context, selected, ['codex'], ['codex'], 'apply', { names: ['ida'] }), { code: 'PROVIDER_PLATFORM_UNSUPPORTED' });
    assert.equal(await fs.readFile(file, 'utf8'), original);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('supported platform requires real installed metadata, preserves unrelated config and blocks drift and duplicate servers', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-re-version-'));
  const context = { root, home, platform: 'darwin', stateDir: path.join(home, 'state') };
  const runtime = reverseRuntime(context, ida);
  const file = path.join(home, '.claude.json');
  const original = { theme: 'dark', mcpServers: { other: { command: 'keep', args: [] } } };
  try {
    await fs.writeFile(file, JSON.stringify(original));
    await assert.rejects(reconcileProviders(context, selected, ['claude'], ['claude']), { code: 'PROVIDER_RUNTIME_MISSING' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
    execFileSync('python3', ['-m', 'venv', '--without-pip', path.dirname(path.dirname(runtime.python))]);
    const site = execFileSync(runtime.python, ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { encoding: 'utf8' }).trim();
    const dist = path.join(site, 'ida_mcp-20261028.0.3.dist-info');
    await fs.mkdir(dist);
    const metadata = version => `Metadata-Version: 2.1\nName: ida-mcp\nVersion: ${version}\n`;
    await fs.writeFile(path.join(dist, 'METADATA'), metadata(ida.version));
    assert.deepEqual(await reverseVersion(context, ida), { expected: ida.version, actual: ida.version, matches: true });
    const applied = await reconcileProviders(context, selected, ['claude'], ['claude']);
    assert.equal(applied.providers[0].version.matches, true);
    assert.equal(applied.providers[1].action, 'unsupported');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(value.theme, 'dark');
    assert.deepEqual(value.mcpServers.other, original.mcpServers.other);
    assert.equal(value.mcpServers.ida.command, process.execPath);
    assert.deepEqual(value.mcpServers.ida.args, [path.join(root, 'src/reverse-provider.mjs'), 'ida', '--home', home]);
    await fs.writeFile(path.join(dist, 'METADATA'), metadata('0.0.1'));
    await assert.rejects(reconcileProviders(context, selected, ['claude'], ['claude']), { code: 'PROVIDER_VERSION_INVALID' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), value);
    await fs.writeFile(path.join(dist, 'METADATA'), metadata(ida.version));
    value.mcpServers.legacy = { command: 'uvx', args: ['ida-pro-mcp'] };
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(reconcileProviders(context, selected, ['claude'], ['claude']), { code: 'PROVIDER_DUPLICATE' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), value);
    const codex = path.join(home, '.codex/config.toml');
    await fs.mkdir(path.dirname(codex));
    await fs.writeFile(codex, '[mcp_servers.legacy]\ncommand="uvx"\nargs=["ida-pro-mcp"]\n');
    await assert.rejects(reconcileProviders(context, selected, ['codex'], ['codex']), { code: 'PROVIDER_DUPLICATE' });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
