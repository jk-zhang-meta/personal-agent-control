import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { HOSTS } from './config.mjs';
import { run } from './exec.mjs';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';

const PROVIDER_CATALOG = 'catalog/providers.json';
const OWNERSHIP_SCHEMA = 1;

function ownershipPath(context) {
  return path.join(context.stateDir, 'owned-providers.json');
}

async function readOwnership(context) {
  const file = ownershipPath(context);
  await assertSafeManagedObject(context.home, file, 'provider ownership', 'file');
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || value.schemaVersion !== OWNERSHIP_SCHEMA || !value.providers
        || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
      throw new Error('invalid provider ownership shape');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: OWNERSHIP_SCHEMA, providers: {} };
    throw new PacError('PROVIDER_OWNERSHIP_INVALID', `Cannot read provider ownership: ${error.message}`);
  }
}

async function writeOwnership(context, value) {
  await atomicWriteFile(ownershipPath(context), `${JSON.stringify(value, null, 2)}\n`);
}

async function catalog(context) {
  const file = path.join(context.root, PROVIDER_CATALOG);
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { throw new PacError('PROVIDER_CATALOG_INVALID', `Cannot read ${file}: ${error.message}`); }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.providers)) {
    throw new PacError('PROVIDER_CATALOG_INVALID', `${file} must use schemaVersion 1 and declare providers.`);
  }
  const names = new Set();
  for (const provider of value.providers) {
    if (!provider || typeof provider.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(provider.name)
        || names.has(provider.name) || provider.kind !== 'mcp-server'
        || !['latest', 'pinned'].includes(provider.versionPolicy)
        || (provider.versionPolicy === 'pinned' && (typeof provider.version !== 'string' || !provider.version))
        || typeof provider.command !== 'string' || !Array.isArray(provider.args)
        || !provider.hosts || typeof provider.hosts !== 'object' || Array.isArray(provider.hosts)) {
      throw new PacError('PROVIDER_CATALOG_INVALID', `Invalid provider entry in ${file}.`);
    }
    names.add(provider.name);
    const missingHosts = HOSTS.filter((host) => !Object.hasOwn(provider.hosts, host));
    if (missingHosts.length > 0) {
      throw new PacError('PROVIDER_CATALOG_INVALID', `${provider.name} must declare an adapter for every Core-supported Agent: ${missingHosts.join(', ')}.`);
    }
    for (const [host, spec] of Object.entries(provider.hosts)) {
      if (!HOSTS.includes(host) || !spec || typeof spec.config !== 'string'
          || !['codex-toml', 'claude-json'].includes(spec.format)) {
        throw new PacError('PROVIDER_CATALOG_INVALID', `Invalid ${provider.name} host adapter.`);
      }
    }
  }
  return value.providers;
}

function selectedNames(profile) {
  return new Set(profile?.manifest?.providers?.enabled || []);
}

function assertSelectedKnown(selected, providers) {
  const known = new Set(providers.map((provider) => provider.name));
  const unknown = [...selected].filter((name) => !known.has(name));
  if (unknown.length) throw new PacError('PROVIDER_UNKNOWN', `Unknown provider(s): ${unknown.join(', ')}`);
}

function providerConfigPath(context, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes('..')) {
    throw new PacError('PROVIDER_CATALOG_INVALID', `Provider config path is unsafe: ${relative}`);
  }
  return path.join(context.home, relative);
}

function expectedArgs(provider) {
  return JSON.stringify(provider.args);
}

function codexBlock(provider) {
  return [
    `[mcp_servers.${provider.name}]`,
    `command = ${JSON.stringify(provider.command)}`,
    `args = ${expectedArgs(provider)}`,
    'startup_timeout_sec = 30',
  ];
}

function upsertCodex(text, provider) {
  const lines = text ? text.split(/\r?\n/u) : [];
  const header = `[mcp_servers.${provider.name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  const endFrom = start < 0 ? -1 : lines.findIndex((line, index) => index > start && /^\s*\[[^[]/u.test(line));
  const end = endFrom < 0 ? lines.length : endFrom;
  const block = start < 0 ? codexBlock(provider) : lines.slice(start, end);
  const setLine = (name, value) => {
    const index = block.findIndex((line) => new RegExp(`^${name}\\s*=`).test(line));
    const line = `${name} = ${value}`;
    if (index < 0) block.splice(1, 0, line);
    else block[index] = line;
  };
  setLine('command', JSON.stringify(provider.command));
  setLine('args', expectedArgs(provider));
  if (start < 0) {
    const prefix = lines.length && lines.at(-1) !== '' ? [''] : [];
    return [...lines, ...prefix, ...block, ''].join('\n');
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

function removeCodex(text, provider) {
  const lines = text.split(/\r?\n/u);
  const header = `[mcp_servers.${provider.name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return text;
  const end = lines.findIndex((line, index) => index > start && /^\s*\[[^[]/u.test(line));
  const next = end < 0 ? lines.length : end;
  return [...lines.slice(0, start), ...lines.slice(next)].join('\n').replace(/\n{3,}/gu, '\n\n');
}

async function readCodex(context, provider, file) {
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = text.split(/\r?\n/u);
  const header = `[mcp_servers.${provider.name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return { present: false, valid: false, path: file };
  const end = lines.findIndex((line, index) => index > start && /^\s*\[[^[]/u.test(line));
  const block = lines.slice(start, end < 0 ? lines.length : end).join('\n');
  const command = block.match(/^\s*command\s*=\s*"([^"]*)"/mu)?.[1];
  const args = block.match(/^\s*args\s*=\s*(\[[^\n]*\])/mu)?.[1];
  return { present: true, valid: command === provider.command && args === expectedArgs(provider), path: file };
}

async function readClaude(context, provider, file) {
  let value = {};
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new PacError('PROVIDER_CONFIG_INVALID', `Cannot parse ${file}: ${error.message}`); }
  const entry = value.mcpServers?.[provider.name];
  const valid = entry?.type === 'stdio' && entry.command === provider.command
    && JSON.stringify(entry.args) === expectedArgs(provider);
  return { present: Boolean(entry), valid, path: file };
}

async function applyCodex(context, provider, file) {
  await assertSafeManagedObject(context.home, file, `${provider.name} Codex config`, 'file');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicWriteFile(file, upsertCodex(text, provider));
}

async function applyClaude(context, provider, file) {
  await assertSafeManagedObject(context.home, file, `${provider.name} Claude config`, 'file');
  let value = {};
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new PacError('PROVIDER_CONFIG_INVALID', `Cannot parse ${file}: ${error.message}`); }
  value.mcpServers = { ...(value.mcpServers || {}), [provider.name]: {
    ...(value.mcpServers?.[provider.name] || {}),
    type: 'stdio', command: provider.command, args: [...provider.args],
  } };
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function retireProvider(context, provider, host, file) {
  await assertSafeManagedObject(context.home, file, `${provider.name} ${host} config`, 'file');
  if (host === 'codex') {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await atomicWriteFile(file, removeCodex(text, provider));
    return;
  }
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw new PacError('PROVIDER_CONFIG_INVALID', `Cannot parse ${file}: ${error.message}`); }
  if (value.mcpServers) {
    delete value.mcpServers[provider.name];
    await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
  }
}

async function upgradeLatest(provider) {
  if (provider.versionPolicy !== 'latest' || process.env.PAC_PROVIDER_NO_UPGRADE === '1') {
    return { skipped: true, reason: provider.versionPolicy === 'latest' ? 'PAC_PROVIDER_NO_UPGRADE' : 'pinned' };
  }
  return await run('codegraph', ['upgrade'], { errorCode: 'PROVIDER_UPGRADE_FAILED' });
}

async function providerVersion(context, provider) {
  if (process.env.PAC_PROVIDER_NO_VERSION_CHECK === '1') {
    return { expected: provider.version || provider.versionPolicy, actual: null, matches: true, skipped: true };
  }
  const result = await run('mise', ['exec', '--', 'codegraph', '--version'], {
    cwd: context.root,
    errorCode: 'PROVIDER_VERSION_INVALID',
  });
  const actual = result.stdout.trim();
  return {
    expected: provider.version || provider.versionPolicy,
    actual,
    matches: provider.versionPolicy !== 'pinned' || actual === provider.version,
  };
}

export async function providerStatus(context, profile, enabledHosts, scopeHosts) {
  const selected = selectedNames(profile);
  const ownership = await readOwnership(context);
  if (selected.size === 0 && Object.keys(ownership.providers).length === 0) return [];
  const providers = await catalog(context);
  assertSelectedKnown(selected, providers);
  const results = [];
  for (const provider of providers) {
    const active = HOSTS.some((host) => scopeHosts.includes(host)
      && enabledHosts.includes(host) && provider.hosts[host] && selected.has(provider.name));
    const version = active ? await providerVersion(context, provider) : null;
    for (const host of HOSTS) {
      if (!scopeHosts.includes(host) || !provider.hosts[host]) continue;
      const hostActive = enabledHosts.includes(host) && selected.has(provider.name);
      const file = providerConfigPath(context, provider.hosts[host].config);
      const inspected = provider.hosts[host].format === 'codex-toml'
        ? await readCodex(context, provider, file)
        : await readClaude(context, provider, file);
      const owned = Boolean(ownership.providers[provider.name]?.[host]);
      results.push({
        provider: provider.name, host, ...inspected,
        expected: hostActive ? 'managed' : owned ? 'missing' : 'unmanaged',
        owned,
        version,
        valid: hostActive ? inspected.valid && version.matches : owned ? !inspected.present : true,
      });
    }
  }
  return results;
}

export async function reconcileProviders(context, profile, enabledHosts, scopeHosts, mode = 'apply') {
  const selected = selectedNames(profile);
  const ownership = await readOwnership(context);
  if (selected.size === 0 && Object.keys(ownership.providers).length === 0) return { valid: true, providers: [] };
  const providers = await catalog(context);
  assertSelectedKnown(selected, providers);
  const results = [];
  for (const provider of providers) {
    const activeHosts = HOSTS.filter((host) => scopeHosts.includes(host)
      && enabledHosts.includes(host) && provider.hosts[host] && selected.has(provider.name));
    const upgrade = mode === 'apply' && activeHosts.length
      ? await upgradeLatest(provider)
      : { skipped: true, reason: mode === 'apply' ? 'inactive' : 'check' };
    const version = activeHosts.length ? await providerVersion(context, provider) : null;
    if (version && !version.matches) {
      throw new PacError('PROVIDER_VERSION_INVALID', `${provider.name} version does not match the reviewed Core pin.`, version);
    }
    for (const host of HOSTS) {
      if (!scopeHosts.includes(host) || !provider.hosts[host]) continue;
      const file = providerConfigPath(context, provider.hosts[host].config);
      if (activeHosts.includes(host)) {
        if (mode === 'apply') {
          if (provider.hosts[host].format === 'codex-toml') await applyCodex(context, provider, file);
          else await applyClaude(context, provider, file);
        }
        const inspected = provider.hosts[host].format === 'codex-toml'
          ? await readCodex(context, provider, file)
          : await readClaude(context, provider, file);
        if (!inspected.valid) throw new PacError('PROVIDER_CONFIG_INVALID', `${provider.name} was not configured for ${host}.`, inspected);
        ownership.providers[provider.name] = { ...(ownership.providers[provider.name] || {}), [host]: { config: provider.hosts[host].config } };
        results.push({ provider: provider.name, host, action: mode === 'apply' ? 'applied' : 'checked', upgrade, version });
      } else if (ownership.providers[provider.name]?.[host]) {
        const inspected = provider.hosts[host].format === 'codex-toml'
          ? await readCodex(context, provider, file)
          : await readClaude(context, provider, file);
        if (inspected.present && !inspected.valid) {
          throw new PacError('PROVIDER_DRIFT', `Refusing to retire modified ${provider.name} configuration for ${host}.`, inspected);
        }
        if (mode === 'apply') await retireProvider(context, provider, host, file);
        delete ownership.providers[provider.name][host];
        if (!Object.keys(ownership.providers[provider.name]).length) delete ownership.providers[provider.name];
        results.push({ provider: provider.name, host, action: mode === 'apply' ? 'retired' : 'retire-required', upgrade });
      }
    }
  }
  if (mode === 'apply') await writeOwnership(context, ownership);
  return { valid: mode === 'apply' || results.every((entry) => entry.action === 'checked'), providers: results };
}
