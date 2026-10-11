import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { HOSTS } from './config.mjs';
import { run } from './exec.mjs';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';
import { resolveWslPlaywright, installWslPlaywright } from './playwright-wsl.mjs';

const PROVIDER_CATALOG = 'catalog/providers.json';
const OWNERSHIP_SCHEMA = 1;
// Provider compatibility does not imply full Core installation support.
export const PROVIDER_CLIENTS = Object.freeze(['codex', 'claude', 'agy', 'grok']);
const FORMATS = { codex: 'codex-toml', claude: 'claude-json', agy: 'agy-json', grok: 'grok-toml' };

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

async function writeOwnership(context, value, write = atomicWriteFile) {
  await write(ownershipPath(context), `${JSON.stringify(value, null, 2)}\n`);
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
        || typeof provider.versionCommand !== 'string' || !provider.versionCommand
        || !provider.hosts || typeof provider.hosts !== 'object' || Array.isArray(provider.hosts)) {
      throw new PacError('PROVIDER_CATALOG_INVALID', `Invalid provider entry in ${file}.`);
    }
    names.add(provider.name);
    const missingHosts = HOSTS.filter((host) => !Object.hasOwn(provider.hosts, host));
    if (missingHosts.length > 0) {
      throw new PacError('PROVIDER_CATALOG_INVALID', `${provider.name} must declare an adapter for every Core-supported Agent: ${missingHosts.join(', ')}.`);
    }
    if (Object.keys(provider.hosts).some((host) => !HOSTS.includes(host))
        || (provider.clients !== undefined && (!provider.clients || typeof provider.clients !== 'object' || Array.isArray(provider.clients)
          || Object.keys(provider.clients).some((client) => HOSTS.includes(client))))) {
      throw new PacError('PROVIDER_CATALOG_INVALID', `Invalid ${provider.name} compatibility clients.`);
    }
    for (const [host, spec] of Object.entries({ ...provider.hosts, ...provider.clients })) {
      if (!PROVIDER_CLIENTS.includes(host) || !spec || typeof spec.config !== 'string'
          || spec.format !== FORMATS[host]) {
        throw new PacError('PROVIDER_CATALOG_INVALID', `Invalid ${provider.name} host adapter.`);
      }
    }
  }
  return value.providers.map((provider) => ({ ...provider, hosts: { ...provider.hosts, ...provider.clients } }));
}

export async function providerConfigurationFiles(context, name, clients) {
  const providers = await catalog(context);
  const provider = providers.find((entry) => entry.name === name);
  if (!provider) throw new PacError('PROVIDER_UNKNOWN', `Unknown provider: ${name}`);
  return clients.map((client) => {
    if (!provider.hosts[client]) throw new PacError('PROVIDER_CLIENT_UNSUPPORTED', `${name} has no ${client} adapter.`);
    return providerConfigPath(context, provider.hosts[client].config);
  });
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

function expandedArgs(context, provider) {
  return provider.args.map((argument) => {
    if (argument === '{{PAC_ROOT}}') return context.root;
    return typeof argument === 'string' ? argument.replaceAll('{{PAC_ROOT}}', context.root)
      .replaceAll('{{PAC_HOME}}', context.home) : argument;
  });
}

function expectedArgs(context, provider) {
  return JSON.stringify(expandedArgs(context, provider));
}

function expectedCommand(context, provider) {
  return provider.command === 'mise' ? context.mise || provider.command : provider.command;
}

function ownedBinding(provider, ownership, host) {
  const owned = ownership.providers[provider.name]?.[host];
  if (!owned || !Object.hasOwn(owned, 'command')) return provider;
  if (typeof owned.command !== 'string' || !Array.isArray(owned.args) || owned.args.some(arg => typeof arg !== 'string')) {
    throw new PacError('PROVIDER_OWNERSHIP_INVALID', `Invalid saved ${provider.name} binding for ${host}.`);
  }
  return { ...provider, command: owned.command, args: owned.args };
}

function codexBlock(context, provider, format) {
  return [
    `[mcp_servers.${provider.name}]`,
    `command = ${JSON.stringify(expectedCommand(context, provider))}`,
    `args = ${expectedArgs(context, provider)}`,
    format === 'grok-toml' ? 'enabled = true' : 'startup_timeout_sec = 30',
  ];
}

function providerTableStart(lines, provider) {
  // Inline/dotted declarations can already own this table. This text adapter
  // only edits explicit server tables; never append a colliding TOML table.
  const rootKey = '(?:mcp_servers|"mcp_servers"|\'mcp_servers\')';
  const unsupported = new RegExp(`^\\s*(?:${rootKey}\\s*(?:=|\\.)|\\[\\s*${rootKey}\\s*\\]\\s*(?:#.*)?$)`, 'u');
  if (lines.some((line) => unsupported.test(line))) {
    throw new PacError('PROVIDER_CONFIG_INVALID', 'MCP inline/dotted declarations are unsupported; use explicit [mcp_servers.NAME] tables.');
  }
  const pattern = new RegExp(`^\\s*\\[\\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\\s*\\.\\s*(?:${provider.name}|"${provider.name}"|'${provider.name}')\\s*\\]\\s*(?:#.*)?$`, 'u');
  const starts = lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
  if (starts.length > 1) throw new PacError('PROVIDER_CONFIG_INVALID', `Duplicate ${provider.name} MCP tables.`);
  return starts[0] ?? -1;
}

// This text adapter accepts string bindings, not arbitrary TOML expressions.
// Decode native formatting before comparing values; unsupported syntax fails closed.
function tomlBinding(text, key) {
  const fields = [...text.matchAll(new RegExp(`^[ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*=[ \\t]*`, 'gmu'))];
  if (fields.length !== 1) return null;
  const field = fields[0];
  let offset = field.index + field[0].length;
  const string = () => {
    const match = /^(?:"(?:[^"\\\u0000-\u001f\u007f]|\\(?:["\\bfnrt]|u[\da-fA-F]{4}))*"|'[^'\u0000-\u0008\u000a-\u001f\u007f]*')/u.exec(text.slice(offset));
    if (!match) throw new Error('unsupported TOML string');
    offset += match[0].length;
    return match[0][0] === "'" ? match[0].slice(1, -1) : JSON.parse(match[0]);
  };
  const trivia = () => {
    const match = /^(?:[ \t\r\n]|#[^\r\n]*(?:\r?\n|$))*/u.exec(text.slice(offset));
    offset += match[0].length;
  };
  try {
    let value;
    if (text[offset] === '[') {
      value = [];
      offset += 1;
      trivia();
      while (text[offset] !== ']') {
        value.push(string());
        trivia();
        if (text[offset] !== ',') break;
        offset += 1;
        trivia();
      }
      if (text[offset++] !== ']') return null;
    } else value = string();
    if (!/^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/u.test(text.slice(offset))) return null;
    return { value, firstLine: text.slice(0, field.index).split('\n').length - 1,
      lastLine: text.slice(0, offset).split('\n').length - 1 };
  } catch { return null; }
}

function upsertCodex(text, context, provider, format) {
  const lines = text ? text.split(/\r?\n/u) : [];
  const start = providerTableStart(lines, provider);
  const endFrom = start < 0 ? -1 : lines.findIndex((line, index) => index > start && /^\s*\[[^[]/u.test(line));
  const end = endFrom < 0 ? lines.length : endFrom;
  const block = start < 0 ? codexBlock(context, provider, format) : lines.slice(start, end);
  const setLine = (name, value) => {
    const binding = tomlBinding(block.join('\n'), name);
    const line = `${name} = ${value}`;
    if (!binding) block.splice(1, 0, line);
    else block.splice(binding.firstLine, binding.lastLine - binding.firstLine + 1, line);
  };
  setLine('command', JSON.stringify(expectedCommand(context, provider)));
  setLine('args', expectedArgs(context, provider));
  if (start < 0) {
    const prefix = lines.length && lines.at(-1) !== '' ? [''] : [];
    return [...lines, ...prefix, ...block, ''].join('\n');
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

function removeCodex(text, provider) {
  const lines = text.split(/\r?\n/u);
  const start = providerTableStart(lines, provider);
  if (start < 0) return text;
  const end = lines.findIndex((line, index) => index > start && /^\s*\[[^[]/u.test(line));
  const next = end < 0 ? lines.length : end;
  return [...lines.slice(0, start), ...lines.slice(next)].join('\n').replace(/\n{3,}/gu, '\n\n');
}

async function readCodex(context, provider, file) {
  await assertSafeManagedObject(context.home, file, `${provider.name} config`, 'file');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = text.split(/\r?\n/u);
  const start = providerTableStart(lines, provider);
  const globallyDisabled = new RegExp(`^\\s*disabled_mcp_servers\\s*=\\s*\\[[^\\]]*["']${provider.name}["']`, 'mu').test(text);
  if (start < 0) return { present: globallyDisabled, valid: false, path: file };
  const end = lines.findIndex((line, index) => index > start && /^\s*\[[^[]/u.test(line));
  const block = lines.slice(start, end < 0 ? lines.length : end).join('\n');
  const command = tomlBinding(block, 'command')?.value;
  const args = tomlBinding(block, 'args')?.value;
  const disabled = /^\s*enabled\s*=\s*false\b/mu.test(block) || globallyDisabled;
  return { present: true, valid: !disabled && command === expectedCommand(context, provider) && JSON.stringify(args) === expectedArgs(context, provider), path: file };
}

async function readJsonConfig(file, format) {
  let value = {};
  try {
    const text = await fs.readFile(file, 'utf8');
    value = JSON.parse(format === 'agy-json' && !text.trim() ? '{}' : text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (value.mcpServers !== undefined && (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)))) throw new Error('Invalid MCP configuration object');
  }
  catch (error) { if (error.code !== 'ENOENT') throw new PacError('PROVIDER_CONFIG_INVALID', `Cannot parse ${file}: ${error.message}`); }
  return value;
}

async function readClaude(context, provider, file, format) {
  await assertSafeManagedObject(context.home, file, `${provider.name} config`, 'file');
  const value = await readJsonConfig(file, format);
  const entry = value.mcpServers?.[provider.name];
  const valid = entry && (format === 'agy-json' ? entry.disabled !== true && !entry.serverUrl : entry.type === 'stdio')
    && entry.command === expectedCommand(context, provider)
    && JSON.stringify(entry.args) === expectedArgs(context, provider);
  return { present: Boolean(entry), valid, path: file };
}

async function applyCodex(context, provider, file, format, write) {
  await assertSafeManagedObject(context.home, file, `${provider.name} Codex config`, 'file');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await write(file, upsertCodex(text, context, provider, format));
}

async function applyClaude(context, provider, file, format, write) {
  await assertSafeManagedObject(context.home, file, `${provider.name} Claude config`, 'file');
  const value = await readJsonConfig(file, format);
  value.mcpServers = { ...(value.mcpServers || {}), [provider.name]: {
    ...(value.mcpServers?.[provider.name] || {}),
    ...(format === 'claude-json' ? { type: 'stdio' } : {}),
    command: expectedCommand(context, provider), args: expandedArgs(context, provider),
  } };
  await write(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function inspect(context, provider, host, file) {
  const format = provider.hosts[host].format;
  return format.endsWith('-toml') ? readCodex(context, provider, file) : readClaude(context, provider, file, format);
}

async function retireProvider(context, provider, host, file, write) {
  await assertSafeManagedObject(context.home, file, `${provider.name} ${host} config`, 'file');
  if (provider.hosts[host].format.endsWith('-toml')) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await write(file, removeCodex(text, provider));
    return;
  }
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw new PacError('PROVIDER_CONFIG_INVALID', `Cannot parse ${file}: ${error.message}`); }
  if (value.mcpServers) {
    delete value.mcpServers[provider.name];
    await write(file, `${JSON.stringify(value, null, 2)}\n`);
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
  if (provider.windowsRuntime && !provider.windowsRuntime.version) {
    return { expected: provider.version, actual: null, matches: false, missing: true };
  }
  const result = await run(provider.windowsRuntime ? provider.windowsRuntime.command : context.mise || 'mise',
    provider.windowsRuntime ? [provider.windowsRuntime.cli, '--version'] : ['exec', '--', provider.versionCommand, '--version'], {
    cwd: provider.windowsRuntime ? path.dirname(provider.windowsRuntime.command) : context.root,
    timeoutMs: 15000,
    errorCode: 'PROVIDER_VERSION_INVALID',
  });
  const actual = result.stdout.trim().replace(/^Version /u, '');
  return {
    expected: provider.version || provider.versionPolicy,
    actual,
    matches: provider.versionPolicy !== 'pinned' || actual === provider.version,
  };
}

export async function providerStatus(context, profile, enabledHosts, scopeHosts, names) {
  const selected = selectedNames(profile);
  const ownership = await readOwnership(context);
  if (selected.size === 0 && Object.keys(ownership.providers).length === 0) return [];
  const providers = await catalog(context);
  assertSelectedKnown(selected, providers);
  if (names) assertSelectedKnown(new Set(names), providers);
  const results = [];
  for (let provider of providers) {
    if (names && !names.includes(provider.name)) continue;
    const active = PROVIDER_CLIENTS.some((host) => scopeHosts.includes(host)
      && enabledHosts.includes(host) && provider.hosts[host] && selected.has(provider.name));
    if (active) provider = await resolveWslPlaywright(context, provider);
    const version = active ? await providerVersion(context, provider) : null;
    for (const host of PROVIDER_CLIENTS) {
      if (!scopeHosts.includes(host) || !provider.hosts[host]) continue;
      const hostActive = enabledHosts.includes(host) && selected.has(provider.name);
      const file = providerConfigPath(context, provider.hosts[host].config);
      const inspectedProvider = hostActive ? provider : ownedBinding(provider, ownership, host);
      const inspected = await inspect(context, inspectedProvider, host, file);
      const owned = Boolean(ownership.providers[provider.name]?.[host]);
      results.push({
        provider: provider.name, host, ...inspected,
        expected: hostActive ? 'managed' : owned ? 'missing' : 'unmanaged',
        owned,
        profileCommit: ownership.providers[provider.name]?.[host]?.profileCommit || null,
        version,
        valid: hostActive ? inspected.valid && version.matches : owned ? !inspected.present : true,
      });
    }
  }
  return results;
}

export async function reconcileProviders(context, profile, enabledHosts, scopeHosts, mode = 'apply', options = {}) {
  const { names, write = atomicWriteFile, installRuntime = true, profileCommit } = options;
  const selected = selectedNames(profile);
  const ownership = await readOwnership(context);
  if (selected.size === 0 && Object.keys(ownership.providers).length === 0) return { valid: true, providers: [] };
  const providers = await catalog(context);
  assertSelectedKnown(selected, providers);
  if (names) assertSelectedKnown(new Set(names), providers);
  const results = [];
  for (let provider of providers) {
    if (names && !names.includes(provider.name)) continue;
    const activeHosts = PROVIDER_CLIENTS.filter((host) => scopeHosts.includes(host)
      && enabledHosts.includes(host) && provider.hosts[host] && selected.has(provider.name));
    if (activeHosts.length) provider = await resolveWslPlaywright(context, provider);
    for (const host of activeHosts) {
      const file = providerConfigPath(context, provider.hosts[host].config);
      const owned = ownership.providers[provider.name]?.[host];
      const inspected = await inspect(context, owned ? ownedBinding(provider, ownership, host) : provider, host, file);
      // An already matching entry is safe to adopt; conflicting native config is not.
      if (inspected.present && !inspected.valid) {
        throw new PacError(owned ? 'PROVIDER_DRIFT' : 'PROVIDER_CONFLICT', `Refusing to replace ${owned ? 'modified' : 'unmanaged'} ${provider.name} configuration for ${host}.`, inspected);
      }
    }
    const upgrade = mode === 'apply' && installRuntime && activeHosts.length
      ? await upgradeLatest(provider)
      : { skipped: true, reason: mode === 'apply' ? 'inactive' : 'check' };
    if (mode === 'apply' && installRuntime && activeHosts.length) await installWslPlaywright(provider);
    const version = activeHosts.length ? await providerVersion(context, provider) : null;
    if (version && !version.matches) {
      throw new PacError('PROVIDER_VERSION_INVALID', `${provider.name} version does not match the reviewed Core pin.`, version);
    }
    for (const host of PROVIDER_CLIENTS) {
      if (!scopeHosts.includes(host) || !provider.hosts[host]) continue;
      const file = providerConfigPath(context, provider.hosts[host].config);
      if (activeHosts.includes(host)) {
        if (mode === 'apply') {
          const format = provider.hosts[host].format;
          if (format.endsWith('-toml')) await applyCodex(context, provider, file, format, write);
          else await applyClaude(context, provider, file, format, write);
        }
        const inspected = await inspect(context, provider, host, file);
        if (!inspected.valid) throw new PacError('PROVIDER_CONFIG_INVALID', `${provider.name} was not configured for ${host}.`, inspected);
        ownership.providers[provider.name] = { ...(ownership.providers[provider.name] || {}), [host]: {
          ...(ownership.providers[provider.name]?.[host] || {}),
          config: provider.hosts[host].config, command: expectedCommand(context, provider), args: expandedArgs(context, provider),
          ...(profileCommit ? { profileCommit } : {}),
        } };
        results.push({ provider: provider.name, host, action: mode === 'apply' ? 'applied' : 'checked', upgrade, version });
      } else if (ownership.providers[provider.name]?.[host]) {
        const savedProvider = ownedBinding(provider, ownership, host);
        const inspected = await inspect(context, savedProvider, host, file);
        if (inspected.present && !inspected.valid) {
          throw new PacError('PROVIDER_DRIFT', `Refusing to retire modified ${provider.name} configuration for ${host}.`, inspected);
        }
        if (mode === 'apply') await retireProvider(context, provider, host, file, write);
        delete ownership.providers[provider.name][host];
        if (!Object.keys(ownership.providers[provider.name]).length) delete ownership.providers[provider.name];
        results.push({ provider: provider.name, host, action: mode === 'apply' ? 'retired' : 'retire-required', upgrade });
      }
    }
  }
  if (mode === 'apply') await writeOwnership(context, ownership, write);
  return { valid: mode === 'apply' || results.every((entry) => entry.action === 'checked'), providers: results };
}
