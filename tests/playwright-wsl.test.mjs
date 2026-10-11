import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWslPlaywright, installWslPlaywright } from '../src/playwright-wsl.mjs';

const provider = { name: 'playwright', version: '0.0.83', command: 'mise', args: ['exec', '--', 'playwright-mcp'] };
const windowsNode = '/mnt/c/Program Files/nodejs/node.exe';
const context = { isWsl: true, root: '/pac-core' };
const findNode = async () => windowsNode;
const host = {
  localAppData: 'C:\\Users\\Test User\\AppData\\Local',
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  npm: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
};

test('native hosts and other providers retain their launcher without Windows discovery', async () => {
  const reject = async () => { throw Error('unexpected Windows process'); };
  assert.equal(await resolveWslPlaywright({ isWsl: false }, provider, { execute: reject, findNode: reject }), provider);
  const codegraph = { ...provider, name: 'codegraph' };
  assert.equal(await resolveWslPlaywright(context, codegraph, { execute: reject, findNode: reject }), codegraph);
});

test('WSL resolves Windows-only arguments without installing; apply installs the exact isolated package once', async () => {
  const calls = [];
  const execute = async (command, args, options) => {
    assert.equal(options.cwd, '/mnt/c/Program Files/nodejs');
    assert.ok(options.timeoutMs > 0);
    calls.push({ command, args });
    if (args.at(-1) === '--version') return { stdout: 'Version 0.0.83\n' };
    return { stdout: JSON.stringify(calls.length === 1 ? host : { exists: false, version: null }) };
  };
  const resolved = await resolveWslPlaywright(context, provider, { execute, findNode });
  assert.equal(calls.length, 2);
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [
    '/pac-core/src/playwright-wsl-launcher.mjs', windowsNode,
    'C:\\Users\\Test User\\AppData\\Local\\personal-agent-control\\providers\\playwright\\0.0.83\\node_modules\\@playwright\\mcp\\cli.js',
    '--browser', 'chrome', '--executable-path', host.chrome, '--headless', '--isolated', '--output-dir',
    'C:\\Users\\Test User\\AppData\\Local\\personal-agent-control\\browser-automation\\mcp',
  ]);
  assert.equal(resolved.windowsRuntime.version, null);
  await installWslPlaywright(resolved, execute);
  assert.deepEqual(calls[2], { command: windowsNode, args: [host.npm, 'install', '--prefix', resolved.windowsRuntime.prefix,
    '@playwright/mcp@0.0.83', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund'] });
  await installWslPlaywright(resolved, execute);
  assert.equal(calls.length, 4);
  assert.equal(provider.command, 'mise');
});

test('WSL dependency failures never fall back and existing unexpected runtime data is preserved', async () => {
  await assert.rejects(resolveWslPlaywright(context, provider, { findNode, execute: async () => { throw Error('Windows Node missing'); } }), /Windows Node missing/u);
  await assert.rejects(installWslPlaywright({ ...provider, windowsRuntime: { exists: true, version: '0.0.82', prefix: 'C:\\runtime' } },
    async () => { throw Error('must not install'); }), { code: 'WINDOWS_BROWSER_RUNTIME_INVALID' });
  await assert.rejects(resolveWslPlaywright(context, provider, { findNode, execute: async () => ({ stdout: JSON.stringify({ ...host, chrome: 'relative.exe' }) }) }),
    { code: 'WINDOWS_BROWSER_DEPENDENCY_MISSING' });
  await assert.rejects(installWslPlaywright({ ...provider, windowsRuntime: { command: windowsNode, prefix: 'C:\\new', cli: 'C:\\new\\cli.js', npm: host.npm, exists: false } },
    async () => ({ stdout: 'Version 0.0.82\n' })), { code: 'PROVIDER_VERSION_INVALID' });
});
