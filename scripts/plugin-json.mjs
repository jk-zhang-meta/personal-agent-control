#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(
    'usage: plugin-json.mjs marketplace-present|marketplace-exact|plugin-present|plugin-exact|plugins-for-marketplace HOST JSON_FILE ARGS...',
  );
  process.exit(2);
}

const [command, host, jsonFile, ...args] = process.argv.slice(2);
if (!command || !['codex', 'claude'].includes(host) || !jsonFile) usage();

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
} catch (error) {
  console.error(`invalid ${host} plugin JSON: ${error.message}`);
  process.exit(2);
}

const marketplaces = host === 'codex' ? parsed.marketplaces : parsed;
const plugins = host === 'codex' ? parsed.installed : parsed;
if (!Array.isArray(marketplaces) && command.startsWith('marketplace-')) usage();
if (!Array.isArray(plugins) &&
    (command.startsWith('plugin-') || command === 'plugins-for-marketplace')) usage();

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function marketplaceName(entry) {
  return entry.name;
}

function pluginId(entry) {
  return host === 'codex' ? entry.pluginId : entry.id;
}

function pluginMarketplace(entry) {
  if (host === 'codex') return entry.marketplaceName;
  const id = entry.id ?? '';
  return id.includes('@') ? id.slice(id.lastIndexOf('@') + 1) : '';
}

switch (command) {
  case 'marketplace-present': {
    const [name] = args;
    process.exit(marketplaces.some((entry) => marketplaceName(entry) === name) ? 0 : 1);
  }
  case 'marketplace-exact': {
    const [name, source] = args;
    const entry = marketplaces.find((candidate) => marketplaceName(candidate) === name);
    if (!entry) process.exit(1);
    const exact = host === 'codex'
      ? entry.marketplaceSource?.sourceType === 'local' &&
        samePath(entry.marketplaceSource.source, source)
      : entry.source === 'directory' && samePath(entry.path, source);
    process.exit(exact ? 0 : 1);
  }
  case 'plugin-present': {
    const [id] = args;
    process.exit(plugins.some((entry) => pluginId(entry) === id) ? 0 : 1);
  }
  case 'plugin-exact': {
    const [id, version, source] = args;
    const entry = plugins.find((candidate) => pluginId(candidate) === id);
    if (!entry || entry.version !== version || entry.enabled !== true) process.exit(1);
    if (host === 'codex') {
      const exactSource = entry.marketplaceSource?.sourceType === 'local' &&
        samePath(entry.marketplaceSource.source, source);
      process.exit(entry.installed === true && exactSource ? 0 : 1);
    }
    process.exit(entry.installPath && fs.existsSync(entry.installPath) ? 0 : 1);
  }
  case 'plugins-for-marketplace': {
    const [name] = args;
    for (const entry of plugins) {
      if (pluginMarketplace(entry) === name) console.log(pluginId(entry));
    }
    break;
  }
  default:
    usage();
}
