import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './exec.mjs';
import { PacError } from './errors.mjs';

const PACKAGES = Object.freeze({ ida: 'ida-mcp', windbg: 'mcp-windbg' });

export function providerSupported(context, provider) {
  return !provider.platforms || provider.platforms.includes(context.platform || process.platform);
}

export function reverseRuntime(context, provider) {
  if (!Object.hasOwn(PACKAGES, provider.name)) return null;
  if (!providerSupported(context, provider)) {
    throw new PacError('PROVIDER_PLATFORM_UNSUPPORTED', `${provider.name} requires native ${provider.platforms.join(' or ')}; no cross-machine or WSL bridge is configured.`);
  }
  const platform = context.platform || process.platform;
  const directory = path.join(context.home, '.agent-work/tools/reverse-engineering', provider.name);
  if (provider.name === 'windbg' && (typeof provider.debuggerPath !== 'string'
      || !provider.debuggerPath.startsWith('.agent-work/tools/reverse-engineering/')
      || provider.debuggerPath.split(/[\\/]/u).includes('..'))) {
    throw new PacError('PROVIDER_CATALOG_INVALID', 'WinDbg requires a pinned home-relative debugger path.');
  }
  return {
    python: path.join(directory, platform === 'win32' ? 'Scripts/python.exe' : 'venv/bin/python'),
    package: PACKAGES[provider.name],
    directory,
    ...(provider.name === 'windbg' ? { debugger: path.join(context.home, provider.debuggerPath) } : {}),
  };
}

export function reverseBinding(context, provider) {
  if (!reverseRuntime(context, provider)) return provider;
  return { ...provider, command: process.execPath,
    args: [path.join(context.root, 'src/reverse-provider.mjs'), provider.name, '--home', context.home] };
}

export async function reverseVersion(context, provider) {
  const runtime = reverseRuntime(context, provider);
  if (!runtime) return null;
  const executable = await fs.stat(runtime.python).catch(() => null);
  if (!executable?.isFile()) {
    throw new PacError('PROVIDER_RUNTIME_MISSING', `Install the pinned ${runtime.package} environment at ${runtime.directory} before enabling ${provider.name}.`);
  }
  if (runtime.debugger && !(await fs.stat(runtime.debugger).catch(() => null))?.isFile()) {
    throw new PacError('PROVIDER_RUNTIME_MISSING', `Install reviewed Windows debugger ${provider.debuggerVersion} at ${runtime.debugger} before enabling windbg.`);
  }
  if (runtime.debugger) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(runtime.debugger)) hash.update(chunk);
    if (hash.digest('hex') !== provider.debuggerSha256) {
      throw new PacError('PROVIDER_VERSION_INVALID', 'The installed CDB executable differs from the reviewed debugger digest.');
    }
  }
  const { stdout } = await run(runtime.python,
    ['-I', '-B', '-c', 'import importlib.metadata,sys; print(importlib.metadata.version(sys.argv[1]))', runtime.package],
    { timeoutMs: 15000, errorCode: 'PROVIDER_VERSION_INVALID' });
  const actual = stdout.trim();
  return { expected: provider.version, actual, matches: actual === provider.version };
}

export function serveProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (signal) process.exitCode = signal === 'SIGINT' ? 130 : 143;
      else process.exitCode = code || 0;
      resolve();
    });
  });
}

async function main(args) {
  const [name, marker, home] = args;
  if (!Object.hasOwn(PACKAGES, name) || marker !== '--home' || !home || args.length !== 3
      || path.resolve(home) !== path.resolve(os.homedir())) {
    throw new PacError('PROVIDER_INPUT_INVALID', 'Use the PAC-managed provider command as the target HOME owner.');
  }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog/providers.json'), 'utf8'));
  const provider = catalog.providers.find((entry) => entry.name === name);
  if (!provider || provider.versionPolicy !== 'pinned') throw new PacError('PROVIDER_CATALOG_INVALID', 'A pinned reverse-engineering provider is required.');
  const context = { home, root };
  const version = await reverseVersion(context, provider);
  if (!version.matches) throw new PacError('PROVIDER_VERSION_INVALID', `${name} expected ${version.expected}; installed ${version.actual}.`);
  const runtime = reverseRuntime(context, provider);
  const state = path.join(home, '.agent-work/runtime/reverse-engineering', name);
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    TMPDIR: state, TMP: state, TEMP: state };
  let serverArgs;
  if (name === 'ida') {
    env.IDA_NEXUS_IDALIB_ONLY = '1';
    env.IDA_MCP_STATE_DIR = path.join(state, 'mcp');
    env.IDA_NEXUS_STATE_DIR = path.join(state, 'nexus');
    serverArgs = ['stdio', '--agent=pac', '--idle-timeout=300'];
  } else {
    await fs.mkdir(path.join(state, 'symbols'), { recursive: true, mode: 0o700 });
    serverArgs = ['--transport', 'stdio', '--timeout', '60', '--cdb-path', runtime.debugger,
      '--symbols-path', path.join(state, 'symbols')];
  }
  // Use the installed console entry point; no uvx, download, HTTP, or update on startup.
  const entry = 'import importlib.metadata,sys; d=importlib.metadata.distribution(sys.argv.pop(1)); e=next(e for e in d.entry_points if e.group=="console_scripts" and e.name==sys.argv[1]); sys.argv=sys.argv[1:]; sys.exit(e.load()())';
  await serveProcess(runtime.python, ['-I', '-B', '-u', '-c', entry, runtime.package, runtime.package, ...serverArgs],
    { env, cwd: state });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.code || 'PROVIDER_FAILED'}: ${error.message}`);
    process.exitCode = 1;
  });
}
