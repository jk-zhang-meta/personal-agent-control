import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
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
      delivery: 'profile', visibility: 'private',
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
  assert.equal(
    model.capabilities.find(({ id }) => id === 'skill:personal-skill').delivery,
    'profile',
  );

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

test('hook-only Plugin catalogs resolve an explicit empty Skill inventory', async (t) => {
  const fixture = createResolverFixture(t);
  writePluginCatalog(join(fixture.profile, 'catalog/plugins.tsv'), [
    pluginRow('private-plugin', 'private-marketplace', '-'),
  ]);
  const overlay = join(fixture.profile, 'catalog/capabilities.jsonl');
  const rows = readFileSync(overlay, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line)).filter(({ id }) => id !== 'skill:private-bundle');
  write(overlay, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  rmSync(join(fixture.home, '.local/share/agent-plugins'), { recursive: true });

  const catalog = await pluginCatalog({ root: fixture.repo }, {
    catalog: { plugins: join(fixture.profile, 'catalog/plugins.tsv') },
  });
  assert.deepEqual(catalog[0].bundledSkills, []);
  assert.deepEqual(loadSourceModel(fixture).capabilities.map(({ id }) => id), [
    'provider:plugin:private-plugin@private-marketplace',
    'skill:base-skill',
    'skill:personal-skill',
  ]);
  assert.equal(validateRepositoryMetadata(fixture).capabilityCount, 3);
});

test('hook-only Plugin preflight preserves inventory and pinned-source checks', (t) => {
  const fixture = createResolverFixture(t);
  const source = join(fixture.home, '.local/share/agent-plugins/sources/private-marketplace');
  rmSync(source, { recursive: true });
  write(join(source, 'hooks/hooks.json'), '{"hooks":{}}\n');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('remote', 'add', 'origin', 'example/private-plugin');
  git('add', '.');
  git('-c', 'user.name=PAC Test', '-c', 'user.email=pac-test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const bin = join(fixture.root, 'bin');
  write(join(bin, 'codex'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/native-calls"\nprintf \'{"marketplaces":[],"installed":[]}\\n\'\n');
  chmodSync(join(bin, 'codex'), 0o755);
  write(join(fixture.home, '.local/state/personal-agent-control/owned-plugins.tsv'),
    '# plugin\tmarketplace\ttargets\nprivate-plugin\tprivate-marketplace\tcodex\n');
  const catalog = join(fixture.root, 'plugins.tsv');
  let sourceLocation = 'example/private-plugin';
  const preflight = (bundled, pinnedCommit = commit, pinnedTree = tree, mode = 'preflight') => {
    const fields = pluginRow('private-plugin', 'private-marketplace', bundled).split('\t');
    fields.splice(2, 1, 'github-commit');
    fields[3] = sourceLocation;
    fields.splice(4, 3, '-', pinnedCommit, pinnedTree);
    writePluginCatalog(catalog, [fields.join('\t')]);
    return spawnSync('sh', [join(process.cwd(), 'scripts/reconcile-plugins.sh'),
      mode, '--home', fixture.home, '--agents', 'codex', '--catalog', catalog,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  };
  const valid = preflight('-');
  assert.equal(valid.status, 0, valid.stderr);
  for (const [bundled, pattern] of [
    ['', /missing bundled Skill inventory/u],
    ['-,fixture-skill', /invalid bundled Skill -/u],
    ['fixture-skill', /does not contain bundled Skill fixture-skill/u],
  ]) {
    const result = preflight(bundled);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  }
  for (const pins of [['0'.repeat(40), tree], [commit, '0'.repeat(40)]]) {
    const result = preflight('-', ...pins);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DRIFT: Plugin source/u);
  }

  sourceLocation = join(fixture.root, 'upstream');
  renameSync(source, sourceLocation);
  const missingOwned = preflight('-');
  assert.notEqual(missingOwned.status, 0);
  assert.match(missingOwned.stderr, /DRIFT: Plugin source/u);
  const ownership = join(fixture.home, '.local/state/personal-agent-control/owned-plugins.tsv');
  rmSync(ownership);
  for (const bundled of ['-', 'fixture-skill']) {
    const pending = preflight(bundled);
    assert.equal(pending.status, 0, pending.stderr);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(ownership), false);
  }
  write(ownership, '# plugin\tmarketplace\ttargets\nother-plugin\tother-marketplace\tcodex\n');
  const priorOwned = preflight('fixture-skill');
  assert.equal(priorOwned.status, 0, priorOwned.stderr);
  assert.equal(readFileSync(ownership, 'utf8').includes('private-plugin'), false);
  write(ownership, 'invalid ownership\n');
  const corruptOwned = preflight('-');
  assert.notEqual(corruptOwned.status, 0);
  assert.match(corruptOwned.stderr, /invalid Plugin ownership header/u);
  rmSync(ownership);
  const missingCheck = preflight('-', commit, tree, 'check');
  assert.notEqual(missingCheck.status, 0);
  assert.match(missingCheck.stderr, /DRIFT: Plugin source/u);
  symlinkSync(join(fixture.root, 'absent'), source);
  const unsafe = preflight('-');
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /DRIFT: Plugin source/u);
  rmSync(source);
  mkdirSync(source);
  const unowned = preflight('-');
  assert.notEqual(unowned.status, 0);
  assert.match(unowned.stderr, /DRIFT: Plugin source/u);
  rmSync(source, { recursive: true });
  const nativeCalls = readFileSync(join(fixture.home, 'native-calls'), 'utf8');
  const missingSkill = preflight('fixture-skill', commit, tree, 'apply');
  assert.notEqual(missingSkill.status, 0);
  assert.match(missingSkill.stderr, /does not contain bundled Skill fixture-skill/u);
  assert.equal(git('rev-parse', 'HEAD'), commit);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), tree);
  assert.equal(readFileSync(join(fixture.home, 'native-calls'), 'utf8'), nativeCalls);
  assert.equal(existsSync(ownership), false);
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

test('wildcard Profile Skill targets inherit every Core resolver host', (t) => {
  const fixture = createResolverFixture(t);
  const manifestPath = join(fixture.profile, 'pac-profile.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.skills[0].targets = ['*'];
  write(manifestPath, JSON.stringify(manifest));

  const model = loadSourceModel({
    repo: fixture.repo,
    profile: fixture.profile,
    home: fixture.home,
    skillRoot: fixture.skillRoot,
  });
  assert.deepEqual(model.capabilities.find(({ id }) => id === 'skill:personal-skill').targets, ['claude', 'codex']);
});

test('resolver rejects non-Profile delivery for an embedded Profile Skill', (t) => {
  const fixture = createResolverFixture(t);
  const overlayPath = join(fixture.profile, 'catalog/capabilities.jsonl');
  const rows = readFileSync(overlayPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  rows.find(({ id }) => id === 'skill:personal-skill').delivery = 'apm';
  write(overlayPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  assert.throws(() => loadSourceModel({
    repo: fixture.repo,
    profile: fixture.profile,
    home: fixture.home,
    skillRoot: fixture.skillRoot,
  }), /Profile Skill personal-skill delivery must be profile/iu);
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
