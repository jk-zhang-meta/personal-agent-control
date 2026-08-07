#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const host = process.env.PAC_TEST_PLUGIN_HOST;
if (!['codex', 'claude'].includes(host)) {
  console.error('PAC_TEST_PLUGIN_HOST must be codex or claude');
  process.exit(2);
}

const home = process.env.HOME || os.homedir();
const stateDir = path.join(home, '.local', 'state', 'pac-test-plugin-host');
const stateFile = path.join(stateDir, `${host}.json`);
const args = process.argv.slice(2);

function loadState() {
  if (!fs.existsSync(stateFile)) return { marketplaces: [], plugins: [] };
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function manifestFor(source) {
  const relative = host === 'codex'
    ? '.agents/plugins/marketplace.json'
    : '.claude-plugin/marketplace.json';
  return JSON.parse(fs.readFileSync(path.join(source, relative), 'utf8'));
}

function splitId(id) {
  const separator = id.lastIndexOf('@');
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`invalid Plugin id: ${id}`);
  }
  return [id.slice(0, separator), id.slice(separator + 1)];
}

function pluginDefinition(state, id) {
  const [name, marketplaceName] = splitId(id);
  const marketplace = state.marketplaces.find((row) => row.name === marketplaceName);
  if (!marketplace) throw new Error(`unknown marketplace: ${marketplaceName}`);
  const manifest = manifestFor(marketplace.source);
  const plugin = manifest.plugins.find((row) => row.name === name);
  if (!plugin) throw new Error(`unknown Plugin: ${id}`);
  const sourceSpec = typeof plugin.source === 'string'
    ? plugin.source
    : plugin.source.path;
  const pluginSource = path.resolve(marketplace.source, sourceSpec);
  let version = plugin.version;
  if (!version) {
    const pluginManifest = path.join(
      pluginSource,
      host === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json',
    );
    version = JSON.parse(fs.readFileSync(pluginManifest, 'utf8')).version;
  }
  return { name, marketplaceName, marketplace, pluginSource, version };
}

function marketplaceList(state) {
  if (host === 'codex') {
    return {
      marketplaces: state.marketplaces.map((row) => ({
        name: row.name,
        marketplaceSource: { sourceType: 'local', source: row.source },
      })),
    };
  }
  return state.marketplaces.map((row) => ({
    name: row.name,
    source: 'directory',
    path: row.source,
  }));
}

function pluginList(state) {
  if (host === 'codex') {
    return {
      installed: state.plugins.map((row) => ({
        pluginId: row.id,
        marketplaceName: row.marketplace,
        version: row.version,
        enabled: true,
        installed: true,
        marketplaceSource: { sourceType: 'local', source: row.source },
      })),
    };
  }
  return state.plugins.map((row) => ({
    id: row.id,
    version: row.version,
    enabled: true,
    installPath: row.installPath,
  }));
}

function install(state, id) {
  if (state.plugins.some((row) => row.id === id)) return;
  const definition = pluginDefinition(state, id);
  const cacheRoot = path.join(
    home,
    host === 'codex' ? '.codex' : '.claude',
    'plugins',
    'cache',
    definition.marketplaceName,
    definition.name,
    definition.version,
  );
  fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
  fs.cpSync(definition.pluginSource, cacheRoot, { recursive: true });
  state.plugins.push({
    id,
    marketplace: definition.marketplaceName,
    source: definition.marketplace.source,
    version: definition.version,
    installPath: cacheRoot,
  });
}

function uninstall(state, id) {
  const row = state.plugins.find((candidate) => candidate.id === id);
  if (row?.installPath) fs.rmSync(row.installPath, { recursive: true, force: true });
  state.plugins = state.plugins.filter((candidate) => candidate.id !== id);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const state = loadState();
  if (args[0] !== 'plugin') throw new Error('only Plugin commands are supported');

  if (args[1] === 'marketplace' && args[2] === 'list') {
    output(marketplaceList(state));
  } else if (args[1] === 'marketplace' && args[2] === 'add') {
    const source = path.resolve(args[3]);
    const manifest = manifestFor(source);
    state.marketplaces = state.marketplaces.filter((row) => row.name !== manifest.name);
    state.marketplaces.push({ name: manifest.name, source });
    saveState(state);
    output({ ok: true });
  } else if (args[1] === 'marketplace' && args[2] === 'remove') {
    const name = args[3];
    if (state.plugins.some((row) => row.marketplace === name)) {
      throw new Error(`marketplace still has installed Plugins: ${name}`);
    }
    state.marketplaces = state.marketplaces.filter((row) => row.name !== name);
    saveState(state);
    output({ ok: true });
  } else if (args[1] === 'list') {
    output(pluginList(state));
  } else if (args[1] === 'add' || args[1] === 'install') {
    install(state, args[2]);
    saveState(state);
    output({ ok: true });
  } else if (args[1] === 'remove' || args[1] === 'uninstall') {
    uninstall(state, args[2]);
    saveState(state);
    output({ ok: true });
  } else {
    throw new Error(`unsupported command: ${args.join(' ')}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
