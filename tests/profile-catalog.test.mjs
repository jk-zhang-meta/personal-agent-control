import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  loadSourceModel,
  validateRepositoryMetadata,
} from '../payload/skills/capability-resolver/scripts/lib/catalog.mjs';
import {
  checkIndex,
  rebuildIndex,
} from '../payload/skills/capability-resolver/scripts/lib/index.mjs';
import { pluginCatalog, reconcilePlugins } from '../src/plugins.mjs';

const PLUGIN_HEADER = '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility';
const TOOL_HEADER = '# name\tversion\towner\tpurpose\tintegrity-or-lock';
const RESOLVER = join(process.cwd(), 'payload/skills/capability-resolver/scripts/capability-resolver.mjs');

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function writeSkill(file, name, description = `${name} fixture`) {
  write(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

function pluginRow(plugin, marketplace, bundledSkill) {
  return [
    plugin,
    marketplace,
    'github-tag',
    `example/${plugin}`,
    'v1.0.0',
    'c'.repeat(40),
    'd'.repeat(40),
    '1.0.0',
    'codex,claude',
    bundledSkill,
    'MIT',
    'private',
  ].join('\t');
}

function writePluginCatalog(file, rows = []) {
  write(file, `${[PLUGIN_HEADER, ...rows, ''].join('\n')}`);
}

function createResolverFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pac-profile-catalog-'));
  const repo = join(root, 'core');
  const profile = join(root, 'profile');
  const home = join(root, 'home');
  const skillRoot = join(home, '.local/share/agent-skills/.agents/skills');
  const dbPath = join(home, '.cache/personal-agent-control/capabilities-v1.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  write(join(repo, 'pac.json'), JSON.stringify({
    schemaVersion: 1,
    hosts: {
      codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
      claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
    },
    plugins: { enabled: [] },
  }));
  write(join(repo, 'catalog/taxonomy.json'), JSON.stringify({
    schemaVersion: 1,
    categories: [
      { id: 'root', parent: null, label: 'Capabilities' },
      { id: 'kind', parent: 'root', label: 'Kind' },
      { id: 'kind.skill', parent: 'kind', label: 'Skills' },
      { id: 'kind.provider', parent: 'kind', label: 'Providers' },
      { id: 'kind.provider.plugin', parent: 'kind.provider', label: 'Plugins' },
    ],
  }));
  write(join(repo, 'catalog/tools.tsv'), `${TOOL_HEADER}\nnode\t24.18.0\tnodejs/node\truntime\tmise.lock\n`);
  writePluginCatalog(join(repo, 'catalog/plugins.tsv'));
  write(join(repo, 'catalog/capabilities.jsonl'), `${JSON.stringify({
    id: 'skill:base-skill', memberships: ['kind.skill'], targets: ['codex', 'claude'],
  })}\n`);

  write(join(profile, 'pac-profile.json'), JSON.stringify({
    schemaVersion: 1,
    skills: [{ name: 'personal-skill', targets: ['codex', 'claude'] }],
    plugins: { enabled: ['private-plugin'] },
  }));
  writePluginCatalog(join(profile, 'catalog/plugins.tsv'), [
    pluginRow('private-plugin', 'private-marketplace', 'private-bundle'),
  ]);
  write(join(profile, 'catalog/capabilities.jsonl'), [
    JSON.stringify({
      id: 'skill:personal-skill', memberships: ['kind.skill'], targets: ['codex', 'claude'],
      visibility: 'private',
    }),
    JSON.stringify({
      id: 'provider:plugin:private-plugin@private-marketplace',
      memberships: ['kind.provider.plugin'], summary: 'Private Plugin provider.',
    }),
    JSON.stringify({ id: 'skill:private-bundle', memberships: ['kind.skill'] }),
    '',
  ].join('\n'));

  writeSkill(join(skillRoot, 'base-skill/SKILL.md'), 'base-skill');
  writeSkill(join(skillRoot, 'personal-skill/SKILL.md'), 'personal-skill');
  writeSkill(join(
    home,
    '.local/share/agent-plugins/sources/private-marketplace/plugins/private-plugin/skills/private-bundle/SKILL.md',
  ), 'private-bundle');

  return { root, repo, profile, home, skillRoot, dbPath };
}

test('Plugin reconciliation merges Core and Profile catalogs without mutating Core config', async (t) => {
  const fixture = createResolverFixture(t);
  writePluginCatalog(join(fixture.repo, 'catalog/plugins.tsv'), [
    pluginRow('core-plugin', 'core-marketplace', 'core-bundle'),
  ]);
  const log = join(fixture.root, 'plugin-log.json');
  const reconciler = join(fixture.root, 'plugin-reconciler.cjs');
  write(reconciler, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const catalog = args[args.indexOf('--catalog') + 1];
const rows = fs.readFileSync(catalog, 'utf8').split(/\\r?\\n/u)
  .filter((line) => line && !line.startsWith('#')).map((line) => line.split('\\t')[0]);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(rows));
`);
  chmodSync(reconciler, 0o755);
  const context = {
    root: fixture.repo,
    home: fixture.home,
    stateDir: join(fixture.home, '.local/state/personal-agent-control'),
  };
  const config = {
    hosts: { codex: { enabled: true } },
    plugins: { enabled: ['core-plugin'] },
  };
  const profile = {
    root: fixture.profile,
    catalog: { plugins: join(fixture.profile, 'catalog/plugins.tsv') },
    manifest: { schemaVersion: 1, plugins: { enabled: ['private-plugin'] } },
  };
  const effectiveProfile = {
    root: fixture.profile,
    plugins: {
      enabled: ['private-plugin'],
      pluginsPath: join(fixture.profile, 'catalog/plugins.tsv'),
      capabilitiesPath: join(fixture.profile, 'catalog/capabilities.jsonl'),
    },
    manifest: profile.manifest,
  };
  const previous = process.env.PAC_PLUGIN_RECONCILER;
  process.env.PAC_PLUGIN_RECONCILER = reconciler;
  try {
    assert.deepEqual((await pluginCatalog(context, profile)).map(({ name }) => name), [
      'core-plugin', 'private-plugin',
    ]);
    assert.deepEqual((await pluginCatalog(context, effectiveProfile)).map(({ name }) => name), [
      'core-plugin', 'private-plugin',
    ]);
    await reconcilePlugins(context, config, ['codex'], 'apply', effectiveProfile);
  } finally {
    if (previous === undefined) delete process.env.PAC_PLUGIN_RECONCILER;
    else process.env.PAC_PLUGIN_RECONCILER = previous;
  }
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['core-plugin', 'private-plugin']);
  assert.deepEqual(config.plugins.enabled, ['core-plugin']);
});

test('resolver merges Profile metadata and enabled private Plugin in library and CLI paths', async (t) => {
  const fixture = createResolverFixture(t);
  const model = loadSourceModel({
    repo: fixture.repo,
    profile: fixture.profile,
    home: fixture.home,
    skillRoot: fixture.skillRoot,
  });
  assert.deepEqual(model.capabilities.map(({ id }) => id), [
    'provider:plugin:private-plugin@private-marketplace',
    'skill:base-skill',
    'skill:personal-skill',
    'skill:private-bundle',
  ]);

  const validation = validateRepositoryMetadata({
    repo: fixture.repo,
    profile: fixture.profile,
    skillRoot: fixture.skillRoot,
  });
  assert.equal(validation.capabilityCount, 4);
  const cliValidation = spawnSync(process.execPath, [
    RESOLVER,
    'validate-metadata', '--repo', fixture.repo, '--profile', fixture.profile,
    '--skill-root', fixture.skillRoot,
  ], { encoding: 'utf8' });
  assert.equal(cliValidation.status, 0, cliValidation.stderr);
  const profileOverlay = join(fixture.profile, 'catalog/capabilities.jsonl');
  const changedRows = readFileSync(profileOverlay, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  changedRows.find(({ id }) => id === 'skill:personal-skill').aliases = ['my private helper'];
  write(profileOverlay, `${changedRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const changedValidation = validateRepositoryMetadata({
    repo: fixture.repo,
    profile: fixture.profile,
    skillRoot: fixture.skillRoot,
  });
  assert.notEqual(changedValidation.revision, validation.revision);
  await rebuildIndex(fixture);
  await checkIndex(fixture);

  rmSync(fixture.dbPath, { force: true });
  const rebuilt = spawnSync(process.execPath, [
    RESOLVER,
    'rebuild', '--repo', fixture.repo, '--profile', fixture.profile,
    '--home', fixture.home, '--db', fixture.dbPath,
  ], { encoding: 'utf8' });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const checked = spawnSync(process.execPath, [
    RESOLVER,
    'check', '--repo', fixture.repo, '--profile', fixture.profile,
    '--home', fixture.home, '--db', fixture.dbPath,
  ], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('resolver rejects divergent Profile Skill host targets', (t) => {
  const fixture = createResolverFixture(t);
  const manifestPath = join(fixture.profile, 'pac-profile.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.skills[0].targets = ['codex'];
  write(manifestPath, JSON.stringify(manifest));

  assert.throws(() => loadSourceModel({
    repo: fixture.repo,
    profile: fixture.profile,
    home: fixture.home,
    skillRoot: fixture.skillRoot,
  }), /targets differ between pac-profile\.json and capabilities\.jsonl/u);
});

test('disabled Profile Plugin stays out of runtime but remains in static validation', (t) => {
  const fixture = createResolverFixture(t);
  write(join(fixture.profile, 'pac-profile.json'), JSON.stringify({
    schemaVersion: 1,
    skills: [{ name: 'personal-skill', targets: ['codex', 'claude'] }],
    plugins: { enabled: [] },
  }));
  const runtime = loadSourceModel({
    repo: fixture.repo,
    profile: fixture.profile,
    home: fixture.home,
    skillRoot: fixture.skillRoot,
  });
  assert.ok(!runtime.capabilities.some(({ id }) => id.includes('private-plugin') || id === 'skill:private-bundle'));
  const validation = validateRepositoryMetadata({
    repo: fixture.repo,
    profile: fixture.profile,
    skillRoot: fixture.skillRoot,
  });
  assert.equal(validation.capabilityCount, 4);
});

test('Profile merge rejects duplicate capability IDs, Plugin names, marketplaces, and providers', async (t) => {
  const cases = [
    {
      label: 'capability ID',
      mutate: (fixture) => write(join(fixture.profile, 'catalog/capabilities.jsonl'), `${JSON.stringify({
        id: 'skill:base-skill', memberships: ['kind.skill'], targets: ['codex'],
      })}\n`),
      pattern: /duplicate capability overlay id skill:base-skill/iu,
    },
    {
      label: 'Plugin name',
      mutate: (fixture) => writePluginCatalog(join(fixture.repo, 'catalog/plugins.tsv'), [
        pluginRow('private-plugin', 'other-marketplace', 'other-bundle'),
      ]),
      pattern: /duplicate Plugin name:? private-plugin/iu,
      catalogConflict: true,
    },
    {
      label: 'Plugin marketplace',
      mutate: (fixture) => writePluginCatalog(join(fixture.repo, 'catalog/plugins.tsv'), [
        pluginRow('other-plugin', 'private-marketplace', 'other-bundle'),
      ]),
      pattern: /duplicate Plugin marketplace:? private-marketplace/iu,
      catalogConflict: true,
    },
    {
      label: 'Plugin provider',
      mutate: (fixture) => writePluginCatalog(join(fixture.repo, 'catalog/plugins.tsv'), [
        pluginRow('private-plugin', 'private-marketplace', 'private-bundle'),
      ]),
      pattern: /duplicate Plugin provider:? private-plugin@private-marketplace/iu,
      catalogConflict: true,
    },
  ];
  for (const scenario of cases) {
    const fixture = createResolverFixture(t);
    scenario.mutate(fixture);
    assert.throws(() => validateRepositoryMetadata({
      repo: fixture.repo,
      profile: fixture.profile,
      skillRoot: fixture.skillRoot,
    }), scenario.pattern, scenario.label);
    if (scenario.catalogConflict) {
      await assert.rejects(pluginCatalog({ root: fixture.repo }, {
        root: fixture.profile,
        catalog: { plugins: join(fixture.profile, 'catalog/plugins.tsv') },
      }), scenario.pattern, scenario.label);
    }
  }
});
