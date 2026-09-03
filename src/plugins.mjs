import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.mjs';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';

const HEADER = '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility';

async function readCatalog(file) {
  const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/u);
  if (lines[0] !== HEADER) throw new PacError('PLUGIN_CATALOG_INVALID', `Unexpected Plugin catalog header in ${file}.`);
  return lines.slice(1).filter((line) => line && !line.startsWith('#')).map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 12) {
      throw new PacError('PLUGIN_CATALOG_INVALID', `${file}:${index + 2} must contain exactly 12 columns.`);
    }
    return {
      name: fields[0], marketplace: fields[1], acquisition: fields[2], source: fields[3],
      ref: fields[4], commit: fields[5], tree: fields[6], version: fields[7],
      targets: fields[8], bundledSkills: fields[9].split(','), license: fields[10],
      visibility: fields[11], line,
    };
  });
}

function assertUniqueCatalog(entries) {
  const names = new Set();
  const marketplaces = new Set();
  const providers = new Set();
  for (const entry of entries) {
    const provider = `${entry.name}@${entry.marketplace}`;
    if (providers.has(provider)) {
      throw new PacError('PLUGIN_CATALOG_CONFLICT', `Duplicate Plugin provider: ${provider}`);
    }
    if (names.has(entry.name)) {
      throw new PacError('PLUGIN_CATALOG_CONFLICT', `Duplicate Plugin name: ${entry.name}`);
    }
    if (marketplaces.has(entry.marketplace)) {
      throw new PacError('PLUGIN_CATALOG_CONFLICT', `Duplicate Plugin marketplace: ${entry.marketplace}`);
    }
    providers.add(provider);
    names.add(entry.name);
    marketplaces.add(entry.marketplace);
  }
}

export async function pluginCatalog(context, profile = null) {
  const files = [path.join(context.root, 'catalog/plugins.tsv')];
  const profileCatalog = profile?.catalog?.plugins ?? profile?.plugins?.pluginsPath ?? null;
  if (profileCatalog) {
    if (!path.isAbsolute(profileCatalog)) {
      throw new PacError('PLUGIN_CATALOG_INVALID', 'Profile Plugin catalog path must be absolute.');
    }
    files.push(profileCatalog);
  }
  const entries = (await Promise.all(files.map(readCatalog))).flat();
  assertUniqueCatalog(entries);
  return entries;
}

async function filteredCatalog(context, enabled, host, profile = null) {
  const known = await pluginCatalog(context, profile);
  const selected = known.filter((entry) =>
    enabled.includes(entry.name) && entry.targets.split(',').includes(host));
  const unknown = enabled.filter((name) => !known.some((entry) => entry.name === name));
  if (unknown.length) throw new PacError('PLUGIN_UNKNOWN', `Unknown Plugin(s): ${unknown.join(', ')}`);
  await fs.mkdir(context.stateDir, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(context.stateDir, 'plugin-catalog-'));
  const file = path.join(directory, 'plugins.tsv');
  await fs.writeFile(file, `${HEADER}\n${selected.map((entry) => entry.line).join('\n')}${selected.length ? '\n' : ''}`, { mode: 0o600 });
  return { file, directory, selected, known };
}

const HOST_PLUGIN_SURFACES = {
  codex: [
    ['.codex/config.toml', 'file'],
    ['.codex/plugins/cache', 'directory'],
    ['.codex/.tmp/marketplaces', 'directory'],
  ],
  claude: [
    ['.claude.json', 'file'],
    ['.claude/.claude.json', 'file'],
    ['.claude/settings.json', 'file'],
    ['.claude/plugins/installed_plugins.json', 'file'],
    ['.claude/plugins/known_marketplaces.json', 'file'],
    ['.claude/plugins/cache', 'directory'],
    ['.claude/plugins/marketplaces', 'directory'],
  ],
};

async function assertSafeActivePluginSurfaces(context, host) {
  for (const [relative, type] of HOST_PLUGIN_SURFACES[host] || []) {
    await assertSafeManagedObject(
      context.home,
      path.join(context.home, relative),
      `${host} native Plugin surface`,
      type,
    );
  }
}

export async function reconcilePlugins(context, config, hosts, mode = 'apply', profile = null) {
  if (!['apply', 'check', 'preflight'].includes(mode)) {
    throw new PacError('PLUGIN_MODE_INVALID', `Unknown Plugin reconciliation mode: ${mode}`);
  }
  if (process.env.PAC_NO_PLUGINS === '1' || hosts.length === 0) return { skipped: true, reason: hosts.length ? 'PAC_NO_PLUGINS' : 'no-enabled-hosts' };
  const override = process.env.PAC_PLUGIN_RECONCILER;
  const executable = override || 'sh';
  const results = [];
  const enabled = [...new Set([
    ...config.plugins.enabled,
    ...(profile?.manifest?.plugins?.enabled ?? []),
  ])].filter((name) => !(profile?.manifest?.plugins?.disabled ?? []).includes(name));
  for (const host of hosts) {
    if (config.hosts[host]?.enabled) await assertSafeActivePluginSurfaces(context, host);
    const desired = config.hosts[host]?.enabled ? enabled : [];
    const catalog = await filteredCatalog(context, desired, host, profile);
    const args = [
      ...(override ? [] : [path.join(context.root, 'scripts/reconcile-plugins.sh')]),
      mode, '--home', context.home, '--agents', host, '--catalog', catalog.file,
    ];
    try {
      const result = await run(executable, args, {
        cwd: context.root,
        errorCode: mode === 'apply' ? 'PLUGIN_APPLY_FAILED' : 'PLUGIN_DRIFT',
      });
      results.push({ host, plugins: catalog.selected.map((entry) => entry.name), output: result.stdout.trim() });
    } finally {
      await fs.rm(catalog.directory, { recursive: true, force: true });
    }
  }
  return { skipped: false, results };
}
