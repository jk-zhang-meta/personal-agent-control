import path from 'node:path';
import fs from 'node:fs/promises';

import { run } from './exec.mjs';
import { PacError } from './errors.mjs';

// WSL browser work stays on Windows. This is intentionally only a Playwright adapter.
async function findWindowsNode(execute) {
  const converted = await execute('wslpath', ['-u', 'C:\\Program Files\\nodejs\\node.exe'], { timeoutMs: 5000 });
  const candidates = [...new Set([converted.stdout.trim(),
    ...(process.env.PATH || '').split(path.delimiter).slice(0, 128).filter(path.isAbsolute).map(dir => path.join(dir, 'node.exe'))])];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new PacError('WINDOWS_BROWSER_DEPENDENCY_MISSING', 'Windows Node is required in its standard installation directory or WSL PATH.');
}

export async function resolveWslPlaywright(context, provider, { execute = run, findNode = findWindowsNode } = {}) {
  if (!context.isWsl || provider.name !== 'playwright') return provider;
  const command = await findNode(execute);
  const windowsOptions = { cwd: path.dirname(command), timeoutMs: 15000 };
  const discovery = await execute(command, ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw Error('Windows Node and LOCALAPPDATA are required');
    const chrome = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe')).find(file => fs.existsSync(file));
    const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!chrome || !fs.existsSync(npm)) throw Error('Windows Chrome and the Node npm CLI are required');
    console.log(JSON.stringify({ localAppData: process.env.LOCALAPPDATA, chrome, npm }));
  `.replace(/\n\s*/gu, ' ')], { ...windowsOptions, errorCode: 'WINDOWS_BROWSER_DEPENDENCY_MISSING' });
  const host = JSON.parse(discovery.stdout);
  if (![host.localAppData, host.chrome, host.npm].every(value => typeof value === 'string' && path.win32.isAbsolute(value))) {
    throw new PacError('WINDOWS_BROWSER_DEPENDENCY_MISSING', 'Windows browser discovery returned invalid paths.');
  }
  const prefix = path.win32.join(host.localAppData, 'personal-agent-control/providers/playwright', provider.version);
  const cli = path.win32.join(prefix, 'node_modules/@playwright/mcp/cli.js');
  const output = path.win32.join(host.localAppData, 'personal-agent-control/browser-automation/mcp');
  const inspected = await execute(command, ['-e', `
    const fs = require('node:fs'), path = require('node:path'), prefix = process.argv[1];
    const manifest = path.join(prefix, 'node_modules/@playwright/mcp/package.json');
    console.log(JSON.stringify({ exists: fs.existsSync(prefix), version: fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).version : null }));
  `.replace(/\n\s*/gu, ' '), prefix], { ...windowsOptions, errorCode: 'WINDOWS_BROWSER_RUNTIME_INVALID' });
  const installed = JSON.parse(inspected.stdout);
  return {
    ...provider,
    command: process.execPath,
    args: [path.join(context.root, 'src/playwright-wsl-launcher.mjs'), command, cli, '--browser', 'chrome', '--executable-path', host.chrome, '--headless', '--isolated', '--output-dir', output],
    windowsRuntime: { command, prefix, cli, npm: host.npm, ...installed },
  };
}

export async function installWslPlaywright(provider, execute = run) {
  const runtime = provider.windowsRuntime;
  if (!runtime || runtime.version === provider.version) return;
  if (runtime.exists) {
    throw new PacError('WINDOWS_BROWSER_RUNTIME_INVALID', 'Refusing to overwrite an existing Windows Playwright runtime with a missing or different package pin.', { prefix: runtime.prefix });
  }
  await execute(runtime.command, [runtime.npm, 'install', '--prefix', runtime.prefix,
    `@playwright/mcp@${provider.version}`, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund'], {
    errorCode: 'WINDOWS_BROWSER_INSTALL_FAILED',
    cwd: path.dirname(runtime.command), timeoutMs: 180000,
  });
  const version = await execute(runtime.command, [runtime.cli, '--version'], {
    cwd: path.dirname(runtime.command), timeoutMs: 15000, errorCode: 'PROVIDER_VERSION_INVALID',
  });
  if (version.stdout.trim() !== `Version ${provider.version}`) {
    throw new PacError('PROVIDER_VERSION_INVALID', 'Installed Windows Playwright MCP does not match the reviewed pin.');
  }
  runtime.version = provider.version;
  runtime.exists = true;
}
