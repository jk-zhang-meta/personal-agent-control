import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { readLock, readManifestDependencies, renderManifest, verifyRuntimeContent } from '../src/apm.mjs';
import {
  atomicWrite, reconcileProjections, createBackup, augmentBackup,
} from '../src/state.mjs';
import { applyMaterializerExceptions, MATERIALIZER_EXCEPTIONS } from '../src/materializers.mjs';
import { reconcilePlugins } from '../src/plugins.mjs';
import { hashDirectory, loadActiveProfile } from '../src/profile.mjs';
import { hostAdapterStatus, reconcileHostAdapters } from '../src/host-adapters.mjs';
import {
  effectiveEnabledHosts, loadMachineProfile, saveConfig, saveMachineProfile,
} from '../src/config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('host adapters are adopted, scoped, retired, and unmanaged disabled files survive', async () => {
  const home = await temporary('pac-host-adapters-');
  const context = {
    root: repo,
    home,
    stateDir: path.join(home, '.local/state/personal-agent-control'),
  };
  const codexTarget = path.join(home, '.codex/AGENTS.md');
  const codexReviewer = path.join(home, '.codex/agents/independent-reviewer.toml');
  const claudeTarget = path.join(home, '.claude/CLAUDE.md');
  await Promise.all([
    copyFileTree(path.join(repo, 'generated/codex/AGENTS.md'), codexTarget),
    copyFileTree(path.join(repo, 'generated/codex/agents/independent-reviewer.toml'), codexReviewer),
    fs.mkdir(path.dirname(claudeTarget), { recursive: true }),
  ]);
  await fs.writeFile(claudeTarget, 'user-owned claude instructions\n');

  const priorMode = process.env.PAC_HOST_ADAPTER_MODE;
  process.env.PAC_HOST_ADAPTER_MODE = 'adopt';
  try {
    const adopted = await reconcileHostAdapters(context, ['codex'], ['codex', 'claude']);
    assert.deepEqual(adopted.hosts, [
      { host: 'codex', action: 'adopted' },
      { host: 'claude', action: 'preserved-unmanaged' },
    ]);
    assert.equal((await hostAdapterStatus(context, ['codex'], ['codex', 'claude'])).every((entry) => entry.valid), true);

    await fs.unlink(path.join(context.stateDir, 'owned-host-adapters.json'));
    assert.equal((await hostAdapterStatus(context, ['codex'], ['codex'])).every((entry) => entry.valid), false);
    await reconcileHostAdapters(context, ['codex'], ['codex']);

    const retired = await reconcileHostAdapters(context, [], ['codex']);
    assert.deepEqual(retired.hosts, [{ host: 'codex', action: 'retired' }]);
    assert.equal(await exists(codexTarget), false);
    assert.equal(await exists(codexReviewer), false);
    assert.equal(await fs.readFile(claudeTarget, 'utf8'), 'user-owned claude instructions\n');
  } finally {
    if (priorMode === undefined) delete process.env.PAC_HOST_ADAPTER_MODE;
    else process.env.PAC_HOST_ADAPTER_MODE = priorMode;
  }
});

test('missing PAC adapters recover stale Chezmoi state without forcing drift', async () => {
  const home = await temporary('pac-host-adapter-recovery-');
  const fakeChezmoi = path.join(home, 'fake-chezmoi');
  const invocation = path.join(home, 'invocation');
  const staleState = path.join(home, 'stale-chezmoi-state');
  const context = {
    root: repo,
    home,
    stateDir: path.join(home, '.local/state/personal-agent-control'),
  };
  await fs.writeFile(fakeChezmoi, [
    '#!/bin/sh',
    'set -eu',
    'source=',
    'destination=',
    'force=false',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --source) source=$2; shift 2 ;;',
    '    --destination) destination=$2; shift 2 ;;',
    '    --force) force=true; shift ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'printf "%s\\n" "$force" > "$PAC_TEST_INVOCATION"',
    'for target in "$destination/.codex/AGENTS.md" "$destination/.codex/agents/independent-reviewer.toml"; do',
    '  case "$target" in',
    '    */.codex/AGENTS.md) expected="$source/generated/codex/AGENTS.md" ;;',
    '    *) expected="$source/generated/codex/agents/independent-reviewer.toml" ;;',
    '  esac',
    '  if [ "$force" != true ] && [ -f "$PAC_TEST_STALE_STATE" ] && [ ! -f "$target" ]; then exit 17; fi',
    '  if [ "$force" != true ] && [ -f "$target" ] && ! cmp -s "$target" "$expected"; then exit 17; fi',
    '  mkdir -p "$(dirname "$target")"',
    '  cp "$expected" "$target"',
    'done',
  ].join('\n'));
  await fs.chmod(fakeChezmoi, 0o755);
  const priorMode = process.env.PAC_HOST_ADAPTER_MODE;
  const priorChezmoi = process.env.PAC_CHEZMOI;
  const priorInvocation = process.env.PAC_TEST_INVOCATION;
  const priorStaleState = process.env.PAC_TEST_STALE_STATE;
  delete process.env.PAC_HOST_ADAPTER_MODE;
  process.env.PAC_CHEZMOI = fakeChezmoi;
  process.env.PAC_TEST_INVOCATION = invocation;
  process.env.PAC_TEST_STALE_STATE = staleState;
  try {
    await reconcileHostAdapters(context, ['codex'], ['codex']);
    assert.equal(await fs.readFile(invocation, 'utf8'), 'true\n');

    // Model a successful prior Chezmoi write followed by an external
    // deletion: its persistent state still exists, but both targets are gone.
    await fs.writeFile(staleState, 'Chezmoi remembers these paths\n');
    await fs.unlink(path.join(home, '.codex/AGENTS.md'));
    await fs.unlink(path.join(home, '.codex/agents/independent-reviewer.toml'));
    await reconcileHostAdapters(context, ['codex'], ['codex']);
    assert.equal(await fs.readFile(invocation, 'utf8'), 'true\n');

    // The mixed recovery branch must also force only because the other entry
    // is already canonical; it must not require both files to be absent.
    await fs.unlink(path.join(home, '.codex/AGENTS.md'));
    await reconcileHostAdapters(context, ['codex'], ['codex']);
    assert.equal(await fs.readFile(invocation, 'utf8'), 'true\n');

    await fs.writeFile(path.join(home, '.codex/AGENTS.md'), 'user drift\n');
    await fs.unlink(path.join(home, '.codex/agents/independent-reviewer.toml'));
    await assert.rejects(
      reconcileHostAdapters(context, ['codex'], ['codex']),
      (error) => error.code === 'HOST_ADAPTER_APPLY_FAILED',
    );
    assert.equal(await fs.readFile(invocation, 'utf8'), 'false\n');
    assert.equal(await fs.readFile(path.join(home, '.codex/AGENTS.md'), 'utf8'), 'user drift\n');
  } finally {
    if (priorMode === undefined) delete process.env.PAC_HOST_ADAPTER_MODE;
    else process.env.PAC_HOST_ADAPTER_MODE = priorMode;
    if (priorChezmoi === undefined) delete process.env.PAC_CHEZMOI;
    else process.env.PAC_CHEZMOI = priorChezmoi;
    if (priorInvocation === undefined) delete process.env.PAC_TEST_INVOCATION;
    else process.env.PAC_TEST_INVOCATION = priorInvocation;
    if (priorStaleState === undefined) delete process.env.PAC_TEST_STALE_STATE;
    else process.env.PAC_TEST_STALE_STATE = priorStaleState;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('forged host-adapter ownership cannot authorize deletion outside the adapter allowlist', async () => {
  const home = await temporary('pac-host-adapter-forgery-');
  const context = {
    root: repo,
    home,
    stateDir: path.join(home, '.local/state/personal-agent-control'),
  };
  const sentinel = path.join(home, '.ssh/id_ed25519');
  const content = Buffer.from('do not delete\n');
  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, content);
  await fs.mkdir(context.stateDir, { recursive: true });
  await fs.writeFile(path.join(context.stateDir, 'owned-host-adapters.json'), `${JSON.stringify({
    schemaVersion: 1,
    hosts: {
      codex: [{ targetRelative: '.ssh/id_ed25519', sha256: crypto.createHash('sha256').update(content).digest('hex') }],
    },
  })}\n`);

  await assert.rejects(
    reconcileHostAdapters(context, [], ['codex']),
    (error) => error.code === 'HOST_ADAPTER_OWNERSHIP_INVALID',
  );
  assert.equal((await fs.readFile(sentinel)).equals(content), true);
});

async function directoryDigest(root) {
  const records = [];
  async function collect(directory, relativeDirectory = '') {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.isDirectory()) await collect(absolute, relative);
      else if (child.isFile()) {
        const stat = await fs.lstat(absolute);
        records.push({ type: 'file', path: relative, executable: (stat.mode & 0o111) !== 0, content: await fs.readFile(absolute) });
      } else if (child.isSymbolicLink()) {
        records.push({ type: 'symlink', path: relative, target: await fs.readlink(absolute) });
      }
    }
  }
  await collect(root);
  records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const hash = crypto.createHash('sha256');
  for (const record of records) {
    hash.update(record.type); hash.update('\0'); hash.update(record.path); hash.update('\0');
    if (record.type === 'file') {
      hash.update(record.executable ? 'x' : '-'); hash.update('\0'); hash.update(record.content);
    } else hash.update(record.target);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function sourceIntegrityManifest(root) {
  const files = ['catalog/capabilities.jsonl', 'catalog/taxonomy.json'];
  async function collect(directory, relative) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), childRelative);
      else if (entry.isFile()) files.push(childRelative);
    }
  }
  await collect(path.join(root, 'payload/skills'), 'payload/skills');
  const lines = await Promise.all(files.sort().map(async (relative) => {
    const content = await fs.readFile(path.join(root, ...relative.split('/')));
    return `${crypto.createHash('sha256').update(content).digest('hex')}  ${relative}`;
  }));
  return `${lines.join('\n')}\n`;
}

function runJsonPac(root, home, args, extraEnv = {}, hosts = 'all') {
  const result = spawnSync(path.join(repo, 'bin/pac'), ['--json', '--home', home, '--hosts', hosts, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PAC_ROOT: root,
      PAC_NODE: process.execPath,
      PAC_NO_PLUGINS: '1',
      PAC_HOST_ADAPTER_MODE: 'skip',
      ...extraEnv,
    },
  });
  let json;
  try { json = JSON.parse(result.stdout); }
  catch { json = null; }
  return { ...result, json };
}

function runJsonPacUnscoped(root, home, args, extraEnv = {}) {
  const result = spawnSync(path.join(repo, 'bin/pac'), ['--json', '--home', home, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PAC_ROOT: root,
      PAC_NODE: process.execPath,
      PAC_NO_PLUGINS: '1',
      PAC_HOST_ADAPTER_MODE: 'skip',
      ...extraEnv,
    },
  });
  let json;
  try { json = JSON.parse(result.stdout); }
  catch { json = null; }
  return { ...result, json };
}

async function copyFileTree(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, dereference: false });
}

async function makeRealLifecycleFixture() {
  const root = await temporary('pac-real-source-');
  const home = await temporary('pac-real-home-');
  const manifestDir = path.join(root, 'packages/skills');
  const base = path.join(root, 'payload/skills/base-skill');
  const ppt = path.join(root, 'ppt-master');
  const demo = path.join(root, 'demo-skill');
  const late = path.join(root, 'late-skill');
  await Promise.all([
    fs.mkdir(manifestDir, { recursive: true }),
    fs.mkdir(base, { recursive: true }),
    fs.mkdir(ppt, { recursive: true }),
    fs.mkdir(demo, { recursive: true }),
    fs.mkdir(late, { recursive: true }),
    fs.mkdir(path.join(root, 'catalog'), { recursive: true }),
    fs.mkdir(path.join(root, 'scripts'), { recursive: true }),
  ]);
  await Promise.all([
    copyFileTree(path.join(repo, 'payload/skills/capability-resolver'), path.join(root, 'payload/skills/capability-resolver')),
    fs.copyFile(path.join(repo, 'catalog/taxonomy.json'), path.join(root, 'catalog/taxonomy.json')),
    fs.copyFile(path.join(repo, 'scripts/path-safety.sh'), path.join(root, 'scripts/path-safety.sh')),
    fs.copyFile(path.join(repo, 'scripts/restore-backup.sh'), path.join(root, 'scripts/restore-backup.sh')),
    fs.writeFile(path.join(base, 'SKILL.md'), '---\nname: base-skill\ndescription: Base lifecycle fixture.\n---\n'),
    fs.writeFile(path.join(ppt, 'SKILL.md'), '---\nname: ppt-master\ndescription: PPT lifecycle fixture.\n---\n'),
    fs.writeFile(path.join(demo, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo lifecycle fixture.\n---\n'),
    fs.writeFile(path.join(late, 'SKILL.md'), '---\nname: late-skill\ndescription: Late failure fixture.\n---\n'),
    fs.writeFile(path.join(root, 'catalog/plugins.tsv'), '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility\n'),
    fs.writeFile(path.join(root, 'catalog/plugin-migrations.tsv'), '# plugin\tmarketplace\ttargets\treplacement\tmarker-base\n'),
    fs.writeFile(path.join(root, 'catalog/tools.tsv'), '# name\tversion\towner\tpurpose\tintegrity-or-lock\n'),
    fs.writeFile(path.join(root, 'pac.json'), `${JSON.stringify({
      schemaVersion: 1,
      neutralSkillStore: '~/.local/share/agent-skills',
      hosts: {
        codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
        claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
      },
      plugins: { enabled: [] },
    }, null, 2)}\n`),
  ]);
  const overlay = [
    JSON.stringify({ id: 'skill:base-skill', memberships: ['kind.skill'], targets: ['codex', 'claude'], delivery: 'apm', visibility: 'private' }),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(root, 'catalog/capabilities.jsonl'), overlay);
  await fs.writeFile(path.join(root, 'catalog/files.sha256'), await sourceIntegrityManifest(root));
  await fs.writeFile(path.join(manifestDir, 'apm.yml'), renderManifest(['../../payload/skills/base-skill']));

  const apm = process.env.PAC_APM || path.join(os.homedir(), '.local/share/mise/installs/apm/0.28.0/apm');
  assert.equal(await exists(apm), true, `real APM 0.28.0 is unavailable at ${apm}`);
  const locked = spawnSync(apm, ['lock', '--target', 'agent-skills'], { cwd: manifestDir, encoding: 'utf8' });
  assert.equal(locked.status, 0, locked.stderr || locked.stdout);

  const skills = path.join(root, 'fake-skills');
  await fs.writeFile(skills, `#!/bin/sh
set -eu
target="$HOME/.agents/skills/ppt-master"
rm -rf -- "$target"
mkdir -p "$target"
cp -R "$2"/. "$target"/
`, { mode: 0o755 });
  const doctor = path.join(root, 'fail-doctor');
  await fs.writeFile(doctor, '#!/bin/sh\nexit 47\n', { mode: 0o755 });
  const pptDigest = await directoryDigest(ppt);
  const env = {
    NODE_ENV: 'test',
    PAC_APM: apm,
    PAC_SKILLS: skills,
    PAC_TEST_PPT_SOURCE: ppt,
    PAC_TEST_PPT_CONTENT_SHA256: pptDigest,
    PAC_SKIP_POST_DOCTOR: '1',
  };
  return { root, home, demo, late, doctor, env };
}

async function makeProfileRepository({
  enabledPlugins = [], catalogPlugins = [], skillTargets = ['codex', 'claude'],
  bootstrap = null,
} = {}) {
  const root = await temporary('pac-profile-repository-');
  const skill = path.join(root, 'skills/profile-fixture');
  await fs.mkdir(path.join(root, 'catalog'), { recursive: true });
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), [
    '---',
    'name: profile-fixture',
    'description: Profile lifecycle fixture.',
    '---',
    '',
  ].join('\n'));
  const capabilities = [{
    id: 'skill:profile-fixture',
    memberships: ['kind.skill'],
    targets: skillTargets,
    delivery: 'profile',
    visibility: 'private',
  }, {
    id: 'skill:ppt-master',
    memberships: ['kind.skill'],
    targets: ['codex', 'claude'],
    delivery: 'vercel-skills-exception',
    visibility: 'private',
  }];
  for (const plugin of catalogPlugins) {
    capabilities.push({
      id: `provider:plugin:${plugin.name}@${plugin.marketplace}`,
      memberships: ['kind.provider.plugin'],
      summary: `${plugin.name} Profile fixture provider.`,
    });
    capabilities.push({
      id: `skill:${plugin.bundledSkill}`,
      memberships: ['kind.skill'],
      summary: `${plugin.bundledSkill} bundled fixture Skill.`,
    });
  }
  await fs.writeFile(
    path.join(root, 'catalog/capabilities.jsonl'),
    `${capabilities.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  if (catalogPlugins.length) {
    await fs.writeFile(path.join(root, 'catalog/plugins.tsv'), [
      '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility',
      ...catalogPlugins.map((plugin) => [
        plugin.name,
        plugin.marketplace,
        'github-tag',
        `example/${plugin.name}`,
        'v1.0.0',
        'c'.repeat(40),
        'd'.repeat(40),
        '1.0.0',
        plugin.targets || 'codex,claude',
        plugin.bundledSkill,
        'MIT',
        'private',
      ].join('\t')),
      '',
    ].join('\n'));
  }
  if (bootstrap !== null) await fs.writeFile(path.join(root, 'bootstrap.md'), bootstrap);
  const manifest = {
    schemaVersion: bootstrap === null ? 1 : 2,
    skills: [{
      name: 'profile-fixture',
      path: 'skills/profile-fixture',
      contentSha256: await hashDirectory(skill),
      targets: skillTargets,
    }],
    plugins: bootstrap === null
      ? { enabled: enabledPlugins }
      : { enabled: enabledPlugins, disabled: [] },
    ...(bootstrap === null ? {} : { bootstrap: 'bootstrap.md' }),
  };
  await fs.writeFile(path.join(root, 'pac-profile.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'],
    ['config', 'user.name', 'PAC Test'],
    ['config', 'user.email', 'pac-test@example.invalid'],
    ['add', '--all'],
    ['commit', '--quiet', '-m', 'Create fixture Profile'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(revision.status, 0, revision.stderr);
  return { root, commit: revision.stdout.trim() };
}

async function makeProfilePluginReconciler(root, home, plugin) {
  const executable = path.join(root, 'profile-plugin-reconciler.cjs');
  const source = path.join(home, '.local/share/agent-plugins/sources', plugin.marketplace);
  const cache = path.join(home, '.codex/plugins/cache', plugin.marketplace);
  const marketplace = path.join(home, '.codex/.tmp/marketplaces', plugin.marketplace);
  const ownership = path.join(home, '.local/state/personal-agent-control/owned-plugins.tsv');
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = args[0];
const host = args[args.indexOf('--agents') + 1];
const catalog = args[args.indexOf('--catalog') + 1];
const rows = fs.readFileSync(catalog, 'utf8').split(/\\r?\\n/u)
  .filter((line) => line && !line.startsWith('#')).map((line) => line.split('\\t'));
if (mode === 'apply' && host === 'codex' && rows.some((row) => row[0] === ${JSON.stringify(plugin.name)})) {
  const source = ${JSON.stringify(source)};
  const bundled = path.join(source, 'plugins', ${JSON.stringify(plugin.name)}, 'skills', ${JSON.stringify(plugin.bundledSkill)});
  for (const directory of [bundled, ${JSON.stringify(cache)}, ${JSON.stringify(marketplace)}]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(bundled, 'SKILL.md'), '---\\nname: ${plugin.bundledSkill}\\ndescription: Profile Plugin fixture.\\n---\\n');
  fs.mkdirSync(path.dirname(${JSON.stringify(ownership)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(ownership)}, '# plugin\\tmarketplace\\ttargets\\n${plugin.name}\\t${plugin.marketplace}\\tcodex\\n');
}
`, { mode: 0o755 });
  return { executable, artifacts: [source, cache, marketplace, ownership] };
}

async function makeOuterTransaction(root, home, managedPaths) {
  const state = path.join(home, '.local/state/personal-agent-control');
  const backupRoot = path.join(home, '.agent-work/backups/personal-agent-control');
  const backup = path.join(backupRoot, `outer-${crypto.randomUUID()}`);
  const token = crypto.randomBytes(12).toString('hex');
  const marker = path.join(state, `chezmoi-transaction-${process.pid}`);
  await fs.mkdir(path.join(backup, 'home'), { recursive: true });
  await fs.mkdir(state, { recursive: true });
  for (const relative of managedPaths) {
    const source = path.join(home, ...relative.split('/'));
    if (await exists(source)) {
      const target = path.join(backup, 'home', ...relative.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(source, target, { recursive: true, dereference: false });
    }
  }
  await fs.writeFile(path.join(backup, 'managed-paths.txt'), `${[...managedPaths].sort().join('\n')}\n`);
  await fs.writeFile(path.join(backup, 'metadata.txt'), `kind=chezmoi-outer\nsource=${root}\ncreated=test\n`);
  await fs.writeFile(path.join(state, 'last-backup'), `${backup}\n`);
  await fs.writeFile(marker, `${backup}\n${token}\n`);
  const lock = path.join(state, 'pac.lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({
    token, pid: process.pid, kind: 'chezmoi-outer', command: ['chezmoi', 'apply'],
  })}\n`);
  return { backup, marker, token, lock };
}

async function repositoryState(root) {
  const relative = [
    'packages/skills/apm.yml',
    'packages/skills/apm.lock.yaml',
    'catalog/capabilities.jsonl',
    'catalog/files.sha256',
  ];
  return Object.fromEntries(await Promise.all(relative.map(async (file) => [file, await fs.readFile(path.join(root, file), 'utf8')])));
}

async function assertRepositoryState(root, expected) {
  for (const [relative, content] of Object.entries(expected)) {
    assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), content, relative);
  }
}

async function temporary(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function context(home) {
  return {
    root: repo,
    home,
    stateDir: path.join(home, '.local/state/personal-agent-control'),
    manifestDir: path.join(repo, 'packages/skills'),
    manifestPath: path.join(repo, 'packages/skills/apm.yml'),
    lockPath: path.join(repo, 'packages/skills/apm.lock.yaml'),
    configPath: path.join(repo, 'pac.json'),
    machineConfigPath: path.join(home, '.config/personal-agent-control/machine.json'),
    apm: process.env.PAC_APM || 'apm',
  };
}

const config = {
  schemaVersion: 1,
  neutralSkillStore: '~/.local/share/agent-skills',
  hosts: {
    codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
    claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
  },
  plugins: { enabled: [] },
};

test('machine profile falls back to source defaults and resolves explicit host scope', async () => {
  const ctx = context(await temporary('pac-machine-fallback-'));
  const sourceConfig = structuredClone(config);
  sourceConfig.hosts.claude.enabled = false;
  const profile = await loadMachineProfile(ctx, sourceConfig);
  assert.deepEqual(profile, {
    schemaVersion: 1,
    enabledHosts: ['codex'],
    origin: 'source-default',
  });
  assert.deepEqual(effectiveEnabledHosts(profile), ['codex']);
  assert.deepEqual(effectiveEnabledHosts(profile, 'claude'), []);
  assert.deepEqual(effectiveEnabledHosts(profile, 'all'), ['codex']);
});

test('Skill search rejects an explicit scope with no enabled host', async () => {
  const root = await temporary('pac-search-scope-source-');
  const home = await temporary('pac-search-scope-home-');
  const resolver = path.join(root, 'resolver.mjs');
  const resolverLog = path.join(home, 'resolver-invoked');
  const sourceConfig = structuredClone(config);
  sourceConfig.hosts.claude.enabled = false;
  await fs.writeFile(path.join(root, 'pac.json'), `${JSON.stringify(sourceConfig, null, 2)}\n`);
  await fs.writeFile(resolver, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(resolverLog)}, 'invoked\\n');\nprocess.stdout.write('{}\\n');\n`);

  const result = runJsonPac(root, home, ['skill', 'search', 'fixture'], {
    PAC_RESOLVER: resolver,
  }, 'claude');

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json?.error?.code, 'HOST_SCOPE_EMPTY');
  assert.match(result.json?.error?.message || '', /no enabled host matches.*claude/iu);
  assert.equal(await exists(resolverLog), false);
});

test('machine profile persists ordered host choices atomically without changing pac.json', async () => {
  const ctx = context(await temporary('pac-machine-save-'));
  const sourceBefore = await fs.readFile(ctx.configPath);
  const saved = await saveMachineProfile(ctx, ['claude', 'codex']);
  assert.deepEqual(saved, {
    schemaVersion: 1,
    enabledHosts: ['claude', 'codex'],
    origin: 'machine',
  });
  assert.deepEqual(JSON.parse(await fs.readFile(ctx.machineConfigPath, 'utf8')), {
    schemaVersion: 1,
    enabledHosts: ['claude', 'codex'],
  });
  assert.equal((await fs.stat(ctx.machineConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(await loadMachineProfile(ctx, config), saved);
  assert.deepEqual(await fs.readFile(ctx.configPath), sourceBefore);
  assert.deepEqual(await fs.readdir(path.dirname(ctx.machineConfigPath)), ['machine.json']);
});

test('atomic state and source writes do not follow predictable temporary symlinks', async () => {
  const home = await temporary('pac-atomic-write-');
  const outside = await temporary('pac-atomic-write-outside-');
  const stateFile = path.join(home, '.local/state/personal-agent-control/value.json');
  const configRoot = await temporary('pac-atomic-config-');
  const configPath = path.join(configRoot, 'pac.json');
  const stateSentinel = path.join(outside, 'state-sentinel');
  const configSentinel = path.join(outside, 'config-sentinel');
  await Promise.all([
    fs.mkdir(path.dirname(stateFile), { recursive: true }),
    fs.writeFile(stateSentinel, 'preserve state\n'),
    fs.writeFile(configSentinel, 'preserve config\n'),
    fs.writeFile(configPath, '{}\n'),
  ]);
  await fs.symlink(stateSentinel, `${stateFile}.${process.pid}.tmp`);
  await fs.symlink(configSentinel, `${configPath}.${process.pid}.tmp`);

  await atomicWrite(stateFile, 'managed state\n');
  await saveConfig({ root: configRoot, configPath }, config);

  assert.equal(await fs.readFile(stateSentinel, 'utf8'), 'preserve state\n');
  assert.equal(await fs.readFile(configSentinel, 'utf8'), 'preserve config\n');
  assert.equal(await fs.readFile(stateFile, 'utf8'), 'managed state\n');
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), config);
});

test('machine profile rejects malformed, unknown, and duplicate host selections', async () => {
  const ctx = context(await temporary('pac-machine-invalid-'));
  await assert.rejects(
    saveMachineProfile(ctx, ['codex', 'gemini']),
    (error) => error.code === 'MACHINE_PROFILE_INVALID' && /unknown host IDs/u.test(error.message),
  );
  await assert.rejects(
    saveMachineProfile(ctx, ['codex', 'codex']),
    (error) => error.code === 'MACHINE_PROFILE_INVALID' && /duplicate host IDs/u.test(error.message),
  );
  await fs.mkdir(path.dirname(ctx.machineConfigPath), { recursive: true });
  for (const value of [
    { schemaVersion: 2, enabledHosts: ['codex'] },
    { schemaVersion: 1, enabledHosts: 'codex' },
    { schemaVersion: 1, enabledHosts: ['unknown'] },
    { schemaVersion: 1, enabledHosts: ['claude', 'claude'] },
  ]) {
    await fs.writeFile(ctx.machineConfigPath, `${JSON.stringify(value)}\n`);
    await assert.rejects(
      loadMachineProfile(ctx, config),
      (error) => error.code === 'MACHINE_PROFILE_INVALID',
    );
  }
  await fs.writeFile(ctx.machineConfigPath, '{not-json}\n');
  await assert.rejects(
    loadMachineProfile(ctx, config),
    (error) => error.code === 'MACHINE_PROFILE_INVALID',
  );
});

test('machine profile refuses paths outside HOME and symlinked ancestors or files', async () => {
  const home = await temporary('pac-machine-path-');
  const outside = await temporary('pac-machine-outside-');
  const ctx = context(home);
  await assert.rejects(
    saveMachineProfile({ ...ctx, machineConfigPath: path.join(outside, 'machine.json') }, ['codex']),
    (error) => error.code === 'PATH_UNSAFE',
  );

  await fs.symlink(outside, path.join(home, '.config'), 'dir');
  await assert.rejects(
    saveMachineProfile(ctx, ['codex']),
    (error) => error.code === 'PATH_UNSAFE',
  );
  assert.equal(await exists(path.join(outside, 'personal-agent-control/machine.json')), false);

  const finalHome = await temporary('pac-machine-final-link-');
  const finalContext = context(finalHome);
  const sentinel = path.join(outside, 'sentinel.json');
  await fs.writeFile(sentinel, 'unchanged\n');
  await fs.mkdir(path.dirname(finalContext.machineConfigPath), { recursive: true });
  await fs.symlink(sentinel, finalContext.machineConfigPath);
  await assert.rejects(
    loadMachineProfile(finalContext, config),
    (error) => error.code === 'PATH_UNSAFE',
  );
  await assert.rejects(
    saveMachineProfile(finalContext, ['claude']),
    (error) => error.code === 'PATH_UNSAFE',
  );
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged\n');
});

test('canonical APM manifest has unique scalar dependencies and a matching pinned lock', async () => {
  const ctx = context(await temporary('pac-manifest-'));
  const dependencies = await readManifestDependencies(ctx);
  assert.deepEqual(dependencies, [
    '../../payload/skills/capability-resolver',
    '../../payload/skills/graph-workflow',
  ]);
  assert.equal(new Set(dependencies).size, dependencies.length);
  assert.deepEqual(await readManifestDependencies({ ...ctx, manifestPath: ctx.manifestPath }), dependencies);
  const lock = await readLock(ctx);
  assert.equal(lock.version, '0.28.0');
  assert.equal(lock.dependencies.length, dependencies.length);
  assert.equal(renderManifest(dependencies).match(/^    - /gmu)?.length, dependencies.length);
});

test('projection IDs come from Skill frontmatter while physical directories remain APM-owned', async () => {
  const home = await temporary('pac-projection-');
  const ctx = context(home);
  const neutral = path.join(home, '.local/share/agent-skills');
  const physical = path.join(neutral, '.agents/skills/composition-patterns');
  await fs.mkdir(physical, { recursive: true });
  await fs.writeFile(path.join(physical, 'SKILL.md'), '---\nname: vercel-composition-patterns\ndescription: test\n---\n');
  const result = await reconcileProjections(ctx, config, neutral, [{
    id: 'vercel-composition-patterns', physicalName: 'composition-patterns', engine: 'apm',
  }], ['codex', 'claude']);
  assert.deepEqual(result.ownedAfter, ['vercel-composition-patterns']);
  for (const link of [
    path.join(home, '.agents/skills/vercel-composition-patterns'),
    path.join(home, '.claude/skills/vercel-composition-patterns'),
  ]) {
    assert.equal(path.resolve(path.dirname(link), await fs.readlink(link)), physical);
  }
});

test('projection reconciliation blocks unmanaged collisions', async () => {
  const home = await temporary('pac-collision-');
  const ctx = context(home);
  const neutral = path.join(home, '.local/share/agent-skills');
  const physical = path.join(neutral, '.agents/skills/example');
  await fs.mkdir(physical, { recursive: true });
  await fs.writeFile(path.join(physical, 'SKILL.md'), '---\nname: example\ndescription: test\n---\n');
  await fs.mkdir(path.join(home, '.agents/skills/example'), { recursive: true });
  await assert.rejects(
    reconcileProjections(ctx, config, neutral, [{ id: 'example', physicalName: 'example', engine: 'apm' }], ['codex']),
    (error) => error.code === 'SKILL_COLLISION',
  );
});

test('projection reconciliation removes a disabled host from an explicit cleanup scope', async () => {
  const home = await temporary('pac-host-disable-');
  const ctx = context(home);
  const neutral = path.join(home, '.local/share/agent-skills');
  const physical = path.join(neutral, '.agents/skills/example');
  await fs.mkdir(physical, { recursive: true });
  await fs.writeFile(path.join(physical, 'SKILL.md'), '---\nname: example\ndescription: test\n---\n');
  const skills = [{ id: 'example', physicalName: 'example', engine: 'apm' }];
  await reconcileProjections(ctx, config, neutral, skills, ['codex', 'claude']);
  await reconcileProjections(ctx, config, neutral, skills, ['codex'], ['codex', 'claude']);
  assert.equal((await fs.lstat(path.join(home, '.agents/skills/example'))).isSymbolicLink(), true);
  await assert.rejects(fs.lstat(path.join(home, '.claude/skills/example')), (error) => error.code === 'ENOENT');
});

test('projection reconciliation does not create an absent disabled-host root', async () => {
  const home = await temporary('pac-disabled-projection-');
  const ctx = context(home);
  const neutral = path.join(home, '.local/share/agent-skills');
  const physical = path.join(neutral, '.agents/skills/example');
  await fs.mkdir(physical, { recursive: true });
  await fs.writeFile(path.join(physical, 'SKILL.md'), '---\nname: example\ndescription: test\n---\n');

  await reconcileProjections(
    ctx,
    config,
    neutral,
    [{ id: 'example', physicalName: 'example', engine: 'apm' }],
    ['codex'],
    ['codex', 'claude'],
  );

  assert.equal(await exists(path.join(home, '.agents/skills/example')), true);
  assert.equal(await exists(path.join(home, '.claude/skills')), false);
});

test('projection reconciliation preserves unowned entries in an existing disabled-host root', async () => {
  const home = await temporary('pac-disabled-projection-user-');
  const ctx = context(home);
  const neutral = path.join(home, '.local/share/agent-skills');
  const physical = path.join(neutral, '.agents/skills/example');
  const claudeRoot = path.join(home, '.claude/skills');
  const userLink = path.join(claudeRoot, 'example');
  const sentinel = path.join(claudeRoot, 'user-owned.txt');
  await fs.mkdir(physical, { recursive: true });
  await fs.writeFile(path.join(physical, 'SKILL.md'), '---\nname: example\ndescription: test\n---\n');
  await fs.mkdir(claudeRoot, { recursive: true });
  await fs.writeFile(sentinel, 'preserve\n');
  await fs.symlink(path.relative(claudeRoot, physical), userLink, 'dir');

  await reconcileProjections(
    ctx,
    config,
    neutral,
    [{ id: 'example', physicalName: 'example', engine: 'apm' }],
    ['codex'],
    ['codex', 'claude'],
  );

  assert.equal((await fs.lstat(claudeRoot)).isDirectory(), true);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve\n');
  assert.equal((await fs.lstat(userLink)).isSymbolicLink(), true);
});

test('Plugin reconciliation gives disabled and incompatible hosts an empty desired catalog', async () => {
  const root = await temporary('pac-plugin-hosts-source-');
  const home = await temporary('pac-plugin-hosts-');
  await fs.mkdir(path.join(root, 'catalog'), { recursive: true });
  await fs.writeFile(path.join(root, 'catalog/plugins.tsv'), [
    '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility',
    `context-mode\tcontext-mode\tgithub-tag\texample/context-mode\tv1.0.0\t${'c'.repeat(40)}\t${'d'.repeat(40)}\t1.0.0\tcodex\tcontext-mode\tMIT\tprivate`,
    '',
  ].join('\n'));
  const ctx = { ...context(home), root };
  const executable = path.join(home, 'plugin-reconciler.cjs');
  const log = path.join(home, 'plugin-log.jsonl');
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const rows = fs.readFileSync(value('--catalog'), 'utf8').split(/\\r?\\n/u)
  .filter((line) => line && !line.startsWith('#')).map((line) => line.split('\\t')[0]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ host: value('--agents'), rows }) + '\\n');
`, { mode: 0o755 });
  const old = process.env.PAC_PLUGIN_RECONCILER;
  process.env.PAC_PLUGIN_RECONCILER = executable;
  try {
    const hostConfig = structuredClone(config);
    hostConfig.hosts.claude.enabled = false;
    hostConfig.plugins.enabled = ['context-mode'];
    const result = await reconcilePlugins(ctx, hostConfig, ['codex', 'claude']);
    assert.equal(result.skipped, false);
  } finally {
    if (old === undefined) delete process.env.PAC_PLUGIN_RECONCILER;
    else process.env.PAC_PLUGIN_RECONCILER = old;
  }
  const rows = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [
    { host: 'codex', rows: ['context-mode'] },
    { host: 'claude', rows: [] },
  ]);
});

test('runtime deployment hashes detect a single-byte managed edit', async () => {
  const neutral = await temporary('pac-runtime-lock-');
  const relative = '.agents/skills/example/SKILL.md';
  const file = path.join(neutral, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'original\n');
  const digest = crypto.createHash('sha256').update('original\n').digest('hex');
  await fs.writeFile(path.join(neutral, 'apm.lock.yaml'), `lockfile_version: '1'\napm_version: 0.28.0\ndependencies:\n- repo_url: _local/example\n  name: example\n  deployed_files:\n  - ${relative}\n  deployed_file_hashes:\n    ${relative}: sha256:${digest}\n`);
  assert.deepEqual(await verifyRuntimeContent(neutral), { files: 1, roots: 1 });
  await fs.writeFile(file, 'Original\n');
  await assert.rejects(verifyRuntimeContent(neutral), (error) => error.code === 'MANAGED_DRIFT');
});

test('runtime inventory rejects an unexpected physical Skill root', async () => {
  const neutral = await temporary('pac-runtime-extra-root-');
  const relative = '.agents/skills/example/SKILL.md';
  const file = path.join(neutral, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'original\n');
  await fs.mkdir(path.join(neutral, '.agents/skills/leftover'));
  await fs.writeFile(path.join(neutral, '.agents/skills/leftover/SKILL.md'), 'leftover\n');
  const digest = crypto.createHash('sha256').update('original\n').digest('hex');
  await fs.writeFile(path.join(neutral, 'apm.lock.yaml'), `lockfile_version: '1'\napm_version: 0.28.0\ndependencies:\n- repo_url: _local/example\n  name: example\n  deployed_files:\n  - ${relative}\n  deployed_file_hashes:\n    ${relative}: sha256:${digest}\n`);
  await assert.rejects(
    verifyRuntimeContent(neutral),
    (error) => error.code === 'MANAGED_DRIFT' && error.details.unexpectedRoots.includes('.agents/skills/leftover'),
  );
});

test('transaction backup includes canonical desired state and enabled-host configuration', async () => {
  const home = await temporary('pac-backup-');
  const ctx = context(home);
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude/settings.json'), '{"keep":true}\n');
  await fs.mkdir(path.join(home, '.config/personal-agent-control'), { recursive: true });
  await fs.writeFile(path.join(home, '.config/personal-agent-control/state.boltdb'), 'chezmoi-state\n');
  await fs.mkdir(ctx.stateDir, { recursive: true });
  await fs.writeFile(path.join(ctx.stateDir, 'owned-host-adapters.json'), '{"schemaVersion":1,"hosts":{}}\n');
  const backup = await createBackup(ctx, config, path.join(home, '.local/share/agent-skills'), []);
  assert.equal(await fs.readFile(path.join(backup, 'repo/pac.json'), 'utf8'), await fs.readFile(path.join(repo, 'pac.json'), 'utf8'));
  assert.equal(await fs.readFile(path.join(backup, 'repo/packages/skills/apm.yml'), 'utf8'), await fs.readFile(path.join(repo, 'packages/skills/apm.yml'), 'utf8'));
  assert.equal(await fs.readFile(path.join(backup, 'repo/catalog/capabilities.jsonl'), 'utf8'), await fs.readFile(path.join(repo, 'catalog/capabilities.jsonl'), 'utf8'));
  assert.equal(await fs.readFile(path.join(backup, 'repo/catalog/files.sha256'), 'utf8'), await fs.readFile(path.join(repo, 'catalog/files.sha256'), 'utf8'));
  assert.equal(await fs.readFile(path.join(backup, 'home/.claude/settings.json'), 'utf8'), '{"keep":true}\n');
  assert.equal(await fs.readFile(path.join(backup, 'home/.config/personal-agent-control/state.boltdb'), 'utf8'), 'chezmoi-state\n');
  assert.equal(await fs.readFile(path.join(backup, 'home/.local/state/personal-agent-control/owned-host-adapters.json'), 'utf8'), '{"schemaVersion":1,"hosts":{}}\n');
});

test('transaction backup covers retired owned and first-time migration Plugin artifacts', async () => {
  const root = await temporary('pac-plugin-backup-source-');
  const home = await temporary('pac-plugin-backup-home-');
  const repositoryFiles = {
    'pac.json': '{}\n',
    'packages/skills/apm.yml': 'packages: []\n',
    'packages/skills/apm.lock.yaml': "lockfile_version: '1'\n",
    'catalog/capabilities.jsonl': '',
    'catalog/files.sha256': '',
    'catalog/plugins.tsv': '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility\n',
    'catalog/plugin-migrations.tsv': '# plugin\tmarketplace\ttargets\treplacement\tmarker-base\ndrawio\tdrawio\tcodex,claude\tskill:drawio\tdrawio-plugin-to-skill-v1\n',
  };
  await Promise.all(Object.entries(repositoryFiles).map(async ([relative, content]) => {
    const file = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }));
  const ctx = { ...context(home), root };
  const codexOnly = structuredClone(config);
  codexOnly.hosts.claude.enabled = false;
  await fs.mkdir(ctx.stateDir, { recursive: true });
  await fs.writeFile(path.join(ctx.stateDir, 'owned-plugins.tsv'), [
    '# plugin\tmarketplace\ttargets',
    'retired-plugin\tretired-marketplace\tcodex',
    '',
  ].join('\n'));
  const artifacts = [
    '.local/share/agent-plugins/sources/retired-marketplace/source.txt',
    '.codex/plugins/cache/retired-marketplace/cache.txt',
    '.codex/.tmp/marketplaces/retired-marketplace/registration.txt',
    '.local/share/agent-plugins/sources/drawio/source.txt',
    '.codex/plugins/cache/drawio/cache.txt',
    '.codex/.tmp/marketplaces/drawio/registration.txt',
  ];
  for (const relative of artifacts) {
    const file = path.join(home, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${relative}\n`);
  }

  const backup = await createBackup(ctx, codexOnly, path.join(home, '.local/share/agent-skills'), []);

  for (const relative of artifacts) {
    assert.equal(await fs.readFile(path.join(backup, 'home', ...relative.split('/')), 'utf8'), `${relative}\n`);
  }
  const managed = await fs.readFile(path.join(backup, 'managed-paths.txt'), 'utf8');
  assert.doesNotMatch(managed, /^\.claude\/plugins\/(?:cache|marketplaces)\/(?:drawio|retired-marketplace)$/mu);
});

test('backup preflight rejects an incompatible final object before creating a snapshot', async () => {
  const home = await temporary('pac-backup-type-');
  const ctx = context(home);
  await fs.mkdir(path.join(home, '.claude/settings.json'), { recursive: true });
  await assert.rejects(
    createBackup(ctx, config, path.join(home, '.local/share/agent-skills'), []),
    (error) => error.code === 'PATH_UNSAFE' && /regular file/u.test(error.message),
  );
  assert.equal(await exists(path.join(home, '.agent-work/backups/personal-agent-control')), false);
  assert.equal(await exists(path.join(ctx.stateDir, 'last-backup')), false);
});

test('a desired-state transaction snapshot validates and round-trips through the restore contract', async () => {
  const root = await temporary('pac-backup-roundtrip-source-');
  const home = await temporary('pac-backup-roundtrip-home-');
  const repositoryFiles = {
    'pac.json': '{}\n',
    'packages/skills/apm.yml': 'packages: []\n',
    'packages/skills/apm.lock.yaml': "lockfile_version: '1'\n",
    'catalog/capabilities.jsonl': '',
    'catalog/files.sha256': '',
    'catalog/plugins.tsv': '# fixture\n',
    'catalog/plugin-migrations.tsv': '# fixture\n',
  };
  await Promise.all(Object.entries(repositoryFiles).map(async ([relative, content]) => {
    const file = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(repo, 'scripts/path-safety.sh'), path.join(root, 'scripts/path-safety.sh')),
    fs.copyFile(path.join(repo, 'scripts/restore-backup.sh'), path.join(root, 'scripts/restore-backup.sh')),
  ]);
  const ctx = {
    ...context(home),
    root,
    stateDir: path.join(home, '.local/state/personal-agent-control'),
  };
  const settings = path.join(home, '.claude/settings.json');
  const chezmoiState = path.join(home, '.config/personal-agent-control/state.boltdb');
  const adapterOwnership = path.join(home, '.local/state/personal-agent-control/owned-host-adapters.json');
  await fs.mkdir(path.dirname(settings), { recursive: true });
  await fs.writeFile(settings, '{"before":true}\n');
  await fs.mkdir(path.dirname(chezmoiState), { recursive: true });
  await fs.writeFile(chezmoiState, 'state-before\n');
  await fs.mkdir(path.dirname(adapterOwnership), { recursive: true });
  await fs.writeFile(adapterOwnership, 'ownership-before\n');
  const backup = await createBackup(ctx, config, path.join(home, '.local/share/agent-skills'), []);
  await augmentBackup(ctx, backup, [{
    id: 'profile-skill',
    physicalName: 'profile-skill',
    targets: ['codex', 'claude'],
  }], {
    activeHosts: ['codex', 'claude'],
    desiredPlugins: ['private-plugin'],
    pluginEntries: [{
      name: 'private-plugin',
      marketplace: 'private-marketplace',
      targets: 'codex,claude',
    }],
  });
  const validated = spawnSync('sh', [path.join(root, 'scripts/restore-backup.sh'), '--validate', backup], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  await fs.writeFile(settings, '{"after":true}\n');
  await fs.writeFile(chezmoiState, 'state-after\n');
  await fs.writeFile(adapterOwnership, 'ownership-after\n');

  const restored = spawnSync('sh', [path.join(root, 'scripts/restore-backup.sh'), backup], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.equal(await fs.readFile(settings, 'utf8'), '{"before":true}\n');
  assert.equal(await fs.readFile(chezmoiState, 'utf8'), 'state-before\n');
  assert.equal(await fs.readFile(adapterOwnership, 'utf8'), 'ownership-before\n');
  assert.equal((await fs.readFile(path.join(ctx.stateDir, 'last-backup'), 'utf8')).trim(), backup);
});

test('ppt-master materializer passes an exact-commit checkout to npm:skills', async () => {
  const home = await temporary('pac-materializer-');
  const fakeBin = path.join(home, 'bin');
  const log = path.join(home, 'skills.log');
  await fs.mkdir(fakeBin, { recursive: true });
  const commit = MATERIALIZER_EXCEPTIONS[0].commit;
  const fakeGit = `#!/bin/sh
set -eu
case "$*" in
  *ls-remote*) printf '%s\\trefs/tags/v4.3.0\\n' '${commit}' ;;
  init*) mkdir -p "${'$'}3/.git" ;;
  *' fetch '*) d=${'$'}2; mkdir -p "${'$'}d/skills/ppt-master"; printf '%s\\n' '---' 'name: ppt-master' 'description: fixture' '---' > "${'$'}d/skills/ppt-master/SKILL.md" ;;
  *' rev-parse HEAD'*) printf '%s\\n' '${commit}' ;;
  *) : ;;
esac
`;
  const fakeSkills = `#!/bin/sh
set -eu
printf '%s\\n' "$*" > '${log}'
mkdir -p "$HOME/.agents/skills/ppt-master"
cp -R "$2"/. "$HOME/.agents/skills/ppt-master/"
`;
  await fs.writeFile(path.join(fakeBin, 'git'), fakeGit, { mode: 0o755 });
  await fs.writeFile(path.join(fakeBin, 'skills'), fakeSkills, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldSkills = process.env.PAC_SKILLS;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  process.env.PAC_SKILLS = path.join(fakeBin, 'skills');
  try {
    await assert.rejects(applyMaterializerExceptions(context(home), path.join(home, '.local/share/agent-skills')),
      (error) => error.code === 'MATERIALIZER_INTEGRITY_FAILED');
  } finally {
    process.env.PATH = oldPath;
    if (oldSkills === undefined) delete process.env.PAC_SKILLS; else process.env.PAC_SKILLS = oldSkills;
  }
  const invocation = await fs.readFile(log, 'utf8');
  assert.match(invocation, new RegExp(commit));
  assert.doesNotMatch(invocation, /v4\.3\.0/u);
});

test('launcher help succeeds without Node or mise shims on PATH when PAC_NODE is explicit', () => {
  const emptyPath = path.join(os.tmpdir(), `pac-empty-path-${process.pid}`);
  const result = spawnSync(path.join(repo, 'bin/pac'), ['--help'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: emptyPath, PAC_NODE: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: pac/u);
});

test('JSON usage errors are stable and nonzero', () => {
  const result = spawnSync(path.join(repo, 'bin/pac'), ['--json', 'unknown-command'], {
    encoding: 'utf8',
    env: { ...process.env, PAC_NODE: process.execPath },
  });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'USAGE');
});

test('fresh-HOME plan is not ready even when the pinned APM executable is available', async () => {
  const home = await temporary('pac-fresh-plan-');
  const fakeApm = path.join(home, 'apm');
  await fs.writeFile(fakeApm, '#!/bin/sh\necho "apm 0.28.0"\n', { mode: 0o755 });
  const result = spawnSync(path.join(repo, 'bin/pac'), ['--json', '--home', home, 'plan'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PAC_NODE: process.execPath,
      PAC_APM: fakeApm,
      PAC_NO_PLUGINS: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.ready, false);
  assert.equal(parsed.data.status.runtimeLock.matchesCanonical, false);
});

test('Profile set, cached replay, status, and remove converge through the PAC transaction', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const profileRepository = await makeProfileRepository();
  const attached = runJsonPac(root, home, [
    'profile', 'set', profileRepository.root, 'main', profileRepository.commit,
  ], env, 'codex');
  assert.equal(attached.status, 0, attached.stderr || attached.stdout);
  assert.equal(attached.json?.data?.profile?.lockedCommit, profileRepository.commit);
  assert.equal(await exists(path.join(home, '.agents/skills/profile-fixture')), true);
  assert.equal(await exists(path.join(home, '.local/share/agent-skills/.agents/skills/profile-fixture')), true);

  const offline = `${profileRepository.root}.offline`;
  await fs.rename(profileRepository.root, offline);
  const replayed = runJsonPac(root, home, ['apply'], env, 'codex');
  assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
  const checked = runJsonPac(root, home, ['profile', 'status'], env, 'codex');
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(checked.json?.data?.profile?.state, 'ready');
  assert.equal(checked.json?.data?.profile?.lockedCommit, profileRepository.commit);

  const detached = runJsonPac(root, home, ['profile', 'remove'], env, 'codex');
  assert.equal(detached.status, 0, detached.stderr || detached.stdout);
  assert.equal(detached.json?.data?.profile?.configured, false);
  assert.equal(await exists(path.join(home, '.agents/skills/profile-fixture')), false);
  assert.equal(await exists(path.join(home, '.local/share/agent-skills/.agents/skills/profile-fixture')), false);
  assert.equal(await exists(path.join(home, '.config/personal-agent-control/profile.json')), false);
});

test('Profile Skill targets filter native Codex and Claude projections', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const profileRepository = await makeProfileRepository({ skillTargets: ['codex'] });
  const attached = runJsonPac(root, home, [
    'profile', 'set', profileRepository.root, 'main', profileRepository.commit,
  ], env);
  assert.equal(attached.status, 0, attached.stderr || attached.stdout);
  assert.equal(await exists(path.join(home, '.agents/skills/profile-fixture')), true);
  assert.equal(await exists(path.join(home, '.claude/skills/profile-fixture')), false);

  const checked = runJsonPac(root, home, ['status'], env);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(checked.json?.data?.ok, true);
  const profileProjections = checked.json?.data?.projections
    ?.filter((entry) => entry.skill === 'profile-fixture');
  assert.deepEqual(profileProjections?.map(({ host, state, expected, valid }) => ({
    host, state, expected, valid,
  })), [
    { host: 'codex', state: 'managed', expected: 'managed', valid: true },
    { host: 'claude', state: 'missing', expected: 'missing', valid: true },
  ]);
});

test('failed Profile set rolls back descriptor, Skill roots, and projections', { timeout: 120_000 }, async () => {
  const { root, home, env, doctor } = await makeRealLifecycleFixture();
  const profileRepository = await makeProfileRepository();
  const failed = runJsonPac(root, home, [
    'profile', 'set', profileRepository.root, 'main', profileRepository.commit,
  ], {
    ...env,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  }, 'codex');
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.error?.code, 'POST_APPLY_VERIFICATION_FAILED');
  assert.equal(failed.json?.error?.details?.rollback?.succeeded, true);
  assert.equal(await exists(path.join(home, '.config/personal-agent-control/profile.json')), false);
  assert.equal(await exists(path.join(home, '.agents/skills/profile-fixture')), false);
  assert.equal(await exists(path.join(home, '.local/share/agent-skills/.agents/skills/profile-fixture')), false);
});

test('PAC_PROFILE_REPO seeds Chezmoi-style apply once and never follows a moving ref implicitly', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const profileRepository = await makeProfileRepository();
  const seeded = runJsonPac(root, home, ['apply'], {
    ...env,
    PAC_PROFILE_REPO: profileRepository.root,
    PAC_PROFILE_REF: 'main',
  }, 'codex');
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  assert.equal(seeded.json?.data?.profile?.lockedCommit, profileRepository.commit);

  const skill = path.join(profileRepository.root, 'skills/profile-fixture');
  await fs.appendFile(path.join(skill, 'SKILL.md'), '\nupdated\n');
  const manifestPath = path.join(profileRepository.root, 'pac-profile.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.skills[0].contentSha256 = await hashDirectory(skill);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const args of [
    ['add', 'pac-profile.json', 'skills/profile-fixture/SKILL.md'],
    ['commit', '--quiet', '-m', 'Move fixture ref'],
  ]) {
    const committed = spawnSync('git', args, { cwd: profileRepository.root, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  }
  const movedRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: profileRepository.root, encoding: 'utf8',
  });
  assert.equal(movedRevision.status, 0, movedRevision.stderr);
  const movedCommit = movedRevision.stdout.trim();

  const replayed = runJsonPac(root, home, ['apply'], {
    ...env,
    PAC_PROFILE_REPO: profileRepository.root,
    PAC_PROFILE_REF: 'main',
  }, 'codex');
  assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
  assert.equal(replayed.json?.data?.profile?.lockedCommit, profileRepository.commit);

  const updated = runJsonPac(root, home, ['profile', 'update', movedCommit], env, 'codex');
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  assert.equal(updated.json?.data?.profile?.lockedCommit, movedCommit);
  assert.match(await fs.readFile(
    path.join(home, '.local/share/agent-skills/.agents/skills/profile-fixture/SKILL.md'),
    'utf8',
  ), /updated/u);
});

test('Profile root is passed unchanged to post-apply and standalone doctor', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const profileRepository = await makeProfileRepository();
  const doctor = path.join(root, 'capture-profile-doctor.sh');
  const log = path.join(home, 'profile-doctor-args.txt');
  await fs.writeFile(doctor, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const doctorEnv = {
    ...env,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  };

  const attached = runJsonPac(root, home, [
    'profile', 'set', profileRepository.root, 'main', profileRepository.commit,
  ], doctorEnv, 'codex');
  assert.equal(attached.status, 0, attached.stderr || attached.stdout);
  const postArgs = (await fs.readFile(log, 'utf8')).trim().split('\n');
  assert.deepEqual(postArgs.slice(0, 4), ['--home', home, '--agents', 'codex']);
  assert.equal(postArgs[4], '--profile');
  assert.equal(path.isAbsolute(postArgs[5]), true);
  assert.equal(path.basename(postArgs[5]), profileRepository.commit);

  const checked = runJsonPac(root, home, ['doctor'], doctorEnv, 'codex');
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const standaloneArgs = (await fs.readFile(log, 'utf8')).trim().split('\n');
  assert.deepEqual(standaloneArgs, postArgs);
});

test('late Profile apply failure rolls back Profile-only Plugin artifacts and can retry', { timeout: 120_000 }, async () => {
  const { root, home, env, doctor } = await makeRealLifecycleFixture();
  const plugin = {
    name: 'profile-plugin', marketplace: 'profile-marketplace', bundledSkill: 'profile-bundle', targets: 'codex',
  };
  const profileRepository = await makeProfileRepository({
    enabledPlugins: [plugin.name],
    catalogPlugins: [plugin],
  });
  const reconciler = await makeProfilePluginReconciler(root, home, plugin);
  const pluginEnv = {
    ...env,
    PAC_NO_PLUGINS: '0',
    PAC_PLUGIN_RECONCILER: reconciler.executable,
  };
  const args = ['profile', 'set', profileRepository.root, 'main', profileRepository.commit];
  const failed = runJsonPac(root, home, args, {
    ...pluginEnv,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  }, 'codex');
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.error?.code, 'POST_APPLY_VERIFICATION_FAILED');
  assert.equal(failed.json?.error?.details?.rollback?.succeeded, true);
  for (const artifact of [
    ...reconciler.artifacts,
    path.join(home, '.config/personal-agent-control/profile.json'),
    path.join(home, '.agents/skills/profile-fixture'),
    path.join(home, '.local/share/agent-skills/.agents/skills/profile-fixture'),
  ]) assert.equal(await exists(artifact), false, artifact);
  const backupPaths = await fs.readFile(
    path.join(failed.json.error.details.rollback.backup, 'managed-paths.txt'),
    'utf8',
  );
  assert.match(backupPaths, /^\.local\/share\/agent-plugins\/sources\/profile-marketplace$/mu);
  assert.match(backupPaths, /^\.codex\/plugins\/cache\/profile-marketplace$/mu);
  assert.match(backupPaths, /^\.agents\/skills\/profile-fixture$/mu);

  const retried = runJsonPac(root, home, args, pluginEnv, 'codex');
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  for (const artifact of reconciler.artifacts) assert.equal(await exists(artifact), true, artifact);
  assert.equal(await exists(path.join(home, '.agents/skills/profile-fixture')), true);
});

test('precreated install backup is augmented for first-install Profile state and can retry', { timeout: 120_000 }, async () => {
  const { root, home, env, doctor } = await makeRealLifecycleFixture();
  const plugin = {
    name: 'install-profile-plugin', marketplace: 'install-profile-marketplace', bundledSkill: 'install-profile-bundle', targets: 'codex',
  };
  const profileRepository = await makeProfileRepository({
    enabledPlugins: [plugin.name],
    catalogPlugins: [plugin],
  });
  const reconciler = await makeProfilePluginReconciler(root, home, plugin);
  const pluginEnv = {
    ...env,
    PAC_PROFILE_REPO: profileRepository.root,
    PAC_PROFILE_REF: 'main',
    PAC_PROFILE_COMMIT: profileRepository.commit,
    PAC_NO_PLUGINS: '0',
    PAC_PLUGIN_RECONCILER: reconciler.executable,
  };
  const failed = runJsonPac(root, home, ['install', 'codex'], {
    ...pluginEnv,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  }, 'codex');
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.error?.details?.rollback?.succeeded, true);
  for (const artifact of [
    ...reconciler.artifacts,
    path.join(home, '.config/personal-agent-control/machine.json'),
    path.join(home, '.config/personal-agent-control/profile.json'),
    path.join(home, '.agents/skills/profile-fixture'),
    path.join(home, '.local/share/agent-skills/.agents/skills/profile-fixture'),
  ]) assert.equal(await exists(artifact), false, artifact);

  const retried = runJsonPac(root, home, ['install', 'codex'], pluginEnv, 'codex');
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(
    path.join(home, '.config/personal-agent-control/machine.json'), 'utf8',
  )).enabledHosts, ['codex']);
  for (const artifact of reconciler.artifacts) assert.equal(await exists(artifact), true, artifact);
  assert.equal(await exists(path.join(home, '.agents/skills/profile-fixture')), true);
});

test('Chezmoi outer backup is augmented for first-install Profile state and can retry', { timeout: 120_000 }, async () => {
  const { root, home, env, doctor } = await makeRealLifecycleFixture();
  const bootstrap = '# Private bootstrap\n\nUse the private fixture policy.\n';
  const plugin = {
    name: 'outer-profile-plugin', marketplace: 'outer-profile-marketplace', bundledSkill: 'outer-profile-bundle', targets: 'codex',
  };
  const profileRepository = await makeProfileRepository({
    enabledPlugins: [plugin.name],
    catalogPlugins: [plugin],
    bootstrap,
  });
  const reconciler = await makeProfilePluginReconciler(root, home, plugin);
  const outer = await makeOuterTransaction(root, home, [
    '.local/state/personal-agent-control/last-backup',
  ]);
  const pluginEnv = {
    ...env,
    PAC_PROFILE_REPO: profileRepository.root,
    PAC_PROFILE_REF: 'main',
    PAC_PROFILE_COMMIT: profileRepository.commit,
    PAC_NO_PLUGINS: '0',
    PAC_PLUGIN_RECONCILER: reconciler.executable,
  };
  const failed = runJsonPac(root, home, ['apply'], {
    ...pluginEnv,
    PAC_PRECREATED_BACKUP: outer.backup,
    PAC_CHEZMOI_TRANSACTION: outer.marker,
    PAC_CHEZMOI_TOKEN: outer.token,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  }, 'codex');
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.error?.details?.rollback?.succeeded, true);
  for (const artifact of [
    ...reconciler.artifacts,
    path.join(home, '.config/personal-agent-control/profile.json'),
    path.join(home, '.config/personal-agent-control/profile-bootstrap.md'),
    path.join(home, '.local/state/personal-agent-control/profile-bootstrap.json'),
    path.join(home, '.agents/skills/profile-fixture'),
    path.join(home, '.local/share/agent-skills/.agents/skills/profile-fixture'),
  ]) assert.equal(await exists(artifact), false, artifact);
  const backupPaths = await fs.readFile(
    path.join(failed.json.error.details.rollback.backup, 'managed-paths.txt'),
    'utf8',
  );
  assert.match(backupPaths, /^\.config\/personal-agent-control\/profile-bootstrap\.md$/mu);
  assert.match(backupPaths, /^\.local\/state\/personal-agent-control\/profile-bootstrap\.json$/mu);

  await fs.rm(outer.lock, { recursive: true });
  await fs.rm(outer.marker, { force: true });
  await fs.rm(`${outer.marker}.claim`, { force: true });
  const retried = runJsonPac(root, home, ['apply'], pluginEnv, 'codex');
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  for (const artifact of reconciler.artifacts) assert.equal(await exists(artifact), true, artifact);
  assert.equal(await exists(path.join(home, '.agents/skills/profile-fixture')), true);
  assert.equal(
    await fs.readFile(path.join(home, '.config/personal-agent-control/profile-bootstrap.md'), 'utf8'),
    bootstrap,
  );
  assert.equal(
    await fs.readFile(path.join(home, '.local/state/personal-agent-control/profile-bootstrap.json'), 'utf8'),
    `${JSON.stringify({
      schemaVersion: 1,
      sha256: crypto.createHash('sha256').update(bootstrap).digest('hex'),
    }, null, 2)}\n`,
  );
});

test('Profile Plugin overlay disables and re-enables a Core provider without mutating Core', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const plugin = {
    name: 'core-profile-plugin', marketplace: 'core-profile-marketplace', bundledSkill: 'core-profile-bundle', targets: 'codex',
  };
  await fs.writeFile(path.join(root, 'catalog/plugins.tsv'), [
    '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility',
    `${plugin.name}\t${plugin.marketplace}\tgithub-tag\texample/${plugin.name}\tv1.0.0\t${'c'.repeat(40)}\t${'d'.repeat(40)}\t1.0.0\tcodex\t${plugin.bundledSkill}\tMIT\tprivate`,
    '',
  ].join('\n'));
  const overlayPath = path.join(root, 'catalog/capabilities.jsonl');
  await fs.appendFile(overlayPath, [
    JSON.stringify({
      id: `provider:plugin:${plugin.name}@${plugin.marketplace}`,
      memberships: ['kind.provider.plugin'],
      summary: 'Core provider enabled by Profile.',
    }),
    JSON.stringify({
      id: `skill:${plugin.bundledSkill}`,
      memberships: ['kind.skill'],
      summary: 'Core bundled fixture Skill.',
    }),
    '',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'catalog/files.sha256'), await sourceIntegrityManifest(root));
  const bundled = path.join(
    home,
    '.local/share/agent-plugins/sources',
    plugin.marketplace,
    'plugins',
    plugin.name,
    'skills',
    plugin.bundledSkill,
  );
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'SKILL.md'), `---\nname: ${plugin.bundledSkill}\ndescription: Core bundled fixture.\n---\n`);
  const profileRepository = await makeProfileRepository({ enabledPlugins: [plugin.name] });
  const attached = runJsonPac(root, home, [
    'profile', 'set', profileRepository.root, 'main', profileRepository.commit,
  ], env, 'codex');
  assert.equal(attached.status, 0, attached.stderr || attached.stdout);
  const configBefore = await fs.readFile(path.join(root, 'pac.json'), 'utf8');
  const removed = runJsonPac(root, home, ['plugin', 'remove', plugin.name], env, 'codex');
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  const workspace = JSON.parse(await fs.readFile(
    path.join(home, '.config/personal-agent-control/profile-workspace.json'),
    'utf8',
  ));
  let manifest = JSON.parse(await fs.readFile(path.join(workspace.path, 'pac-profile.json'), 'utf8'));
  assert.deepEqual(manifest.plugins, { enabled: [], disabled: [plugin.name] });
  assert.equal(await fs.readFile(path.join(root, 'pac.json'), 'utf8'), configBefore);

  const added = runJsonPac(root, home, ['plugin', 'add', plugin.name], env, 'codex');
  assert.equal(added.status, 0, added.stderr || added.stdout);
  manifest = JSON.parse(await fs.readFile(path.join(workspace.path, 'pac-profile.json'), 'utf8'));
  assert.deepEqual(manifest.plugins, { enabled: [plugin.name], disabled: [] });
  assert.equal(await fs.readFile(path.join(root, 'pac.json'), 'utf8'), configBefore);
});

test('apply rejects a symlinked managed ancestor before reconciliation and leaves its external target unchanged', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const outside = await temporary('pac-external-codex-');
  await fs.writeFile(path.join(outside, 'config.toml'), 'external = true\n');
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'do not mutate\n');
  await fs.symlink(outside, path.join(home, '.codex'), 'dir');
  const before = await directoryDigest(outside);

  const result = runJsonPac(root, home, ['apply'], env);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.json?.ok, false);
  assert.equal(result.json?.error.code, 'PATH_UNSAFE');
  assert.match(result.json?.error.message || '', /PAC backup source \.codex\//u);
  assert.equal(await directoryDigest(outside), before);
  assert.equal(await exists(path.join(home, '.agents/skills/base-skill')), false);
  assert.equal(await exists(path.join(home, '.claude/skills/base-skill')), false);
  assert.equal(await exists(path.join(home, '.local/state/personal-agent-control/last-backup')), false);
  assert.equal(await exists(path.join(home, '.agent-work/backups/personal-agent-control')), false);
});

test('scoped apply verifies only the requested host even when both hosts are enabled', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const doctor = path.join(root, 'capture-doctor.sh');
  const log = path.join(home, 'doctor-args.txt');
  await fs.writeFile(doctor, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 });

  const applied = runJsonPac(root, home, ['apply'], {
    ...env,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  }, 'codex');
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), [
    '--home', home, '--agents', 'codex',
  ]);
});

test('scoped apply snapshots only the selected enabled host and ignores an unsafe enabled peer', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const profile = path.join(home, '.config/personal-agent-control/machine.json');
  const outside = await temporary('pac-scoped-enabled-peer-');
  const sentinel = path.join(outside, 'sentinel.txt');
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.writeFile(profile, `${JSON.stringify({ schemaVersion: 1, enabledHosts: ['codex', 'claude'] })}\n`);
  await fs.writeFile(sentinel, 'preserve enabled peer\n');
  await fs.symlink(outside, path.join(home, '.claude'), 'dir');

  const applied = runJsonPac(root, home, ['apply'], env, 'codex');
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve enabled peer\n');
  const manifest = await fs.readFile(path.join(applied.json.data.backup, 'managed-paths.txt'), 'utf8');
  assert.doesNotMatch(manifest, /^\.claude(?:\/|\.json$)/mu);
});

test('fresh Codex install and diagnostics ignore an unrelated inactive Claude symlink', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const outside = await temporary('pac-inactive-claude-');
  const sentinel = path.join(outside, 'sentinel.txt');
  const doctor = path.join(root, 'pass-doctor.sh');
  await fs.writeFile(sentinel, 'preserve\n');
  await fs.symlink(outside, path.join(home, '.claude'), 'dir');
  await fs.writeFile(doctor, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const installed = runJsonPac(root, home, ['install', 'codex'], env, 'codex');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const checked = runJsonPac(root, home, ['status'], env, 'codex');
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const diagnosed = runJsonPac(root, home, ['doctor'], { ...env, PAC_DOCTOR: doctor }, 'codex');
  assert.equal(diagnosed.status, 0, diagnosed.stderr || diagnosed.stdout);
  const applied = runJsonPac(root, home, ['apply'], env, 'all');
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);

  assert.deepEqual(JSON.parse(await fs.readFile(
    path.join(home, '.config/personal-agent-control/machine.json'), 'utf8',
  )).enabledHosts, ['codex']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve\n');
  assert.equal((await fs.lstat(path.join(home, '.claude'))).isSymbolicLink(), true);
});

test('an active Claude projection rejects a symlinked ancestor before mutation', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const outside = await temporary('pac-active-claude-');
  const sentinel = path.join(outside, 'sentinel.txt');
  await fs.writeFile(sentinel, 'preserve\n');
  await fs.symlink(outside, path.join(home, '.claude'), 'dir');

  const installed = runJsonPac(root, home, ['install', 'claude'], env, 'claude');
  assert.notEqual(installed.status, 0, installed.stdout);
  assert.equal(installed.json?.error?.code, 'PATH_UNSAFE');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve\n');
  assert.equal(await exists(path.join(home, '.config/personal-agent-control/machine.json')), false);
  assert.equal(await exists(path.join(home, '.local/state/personal-agent-control/last-backup')), false);
});

test('fresh install still retires a deselected host with proven legacy PAC projections', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const legacy = runJsonPac(root, home, ['apply'], env, 'all');
  assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);
  assert.equal(await exists(path.join(home, '.claude/skills/base-skill')), true);
  assert.equal(await exists(path.join(home, '.config/personal-agent-control/machine.json')), false);

  const installed = runJsonPac(root, home, ['install', 'codex'], env, 'codex');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(await exists(path.join(home, '.agents/skills/base-skill')), true);
  assert.equal(await exists(path.join(home, '.claude/skills/base-skill')), false);
});

test('failed fresh apply restores the empty runtime and skips resolver rebuild after rollback', { timeout: 120_000 }, async () => {
  const { root, home, doctor, env } = await makeRealLifecycleFixture();
  const neutral = path.join(home, '.local/share/agent-skills');
  const failed = runJsonPac(root, home, ['apply'], {
    ...env,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  });

  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.error.code, 'POST_APPLY_VERIFICATION_FAILED');
  assert.equal(failed.json?.error.details?.rollback?.succeeded, true);
  assert.equal(failed.json?.error.details?.rollback?.resolver?.skipped, true);
  for (const artifact of [
    path.join(neutral, 'apm.lock.yaml'),
    path.join(neutral, 'apm_modules'),
    path.join(neutral, '.agents/skills/base-skill'),
    path.join(neutral, '.agents/skills/ppt-master'),
    path.join(home, '.agents/skills/base-skill'),
    path.join(home, '.claude/skills/base-skill'),
    path.join(home, '.local/state/personal-agent-control/owned-skills.txt'),
    path.join(home, '.local/state/personal-agent-control/owned-skill-map.json'),
    path.join(home, '.cache/personal-agent-control/capabilities-v1.sqlite'),
  ]) assert.equal(await exists(artifact), false, artifact);
});

test('an exact Chezmoi outer snapshot is consumed once and remains the rollback baseline under the outer lock', { timeout: 120_000 }, async () => {
  const { root, home, doctor, env } = await makeRealLifecycleFixture();
  const managedPaths = [
    '.local/share/agent-skills',
    '.agents/skills/base-skill',
    '.agents/skills/ppt-master',
    '.claude/skills/base-skill',
    '.claude/skills/ppt-master',
    '.local/state/personal-agent-control/last-backup',
    '.local/state/personal-agent-control/owned-host-adapters.json',
    '.local/state/personal-agent-control/owned-skills.txt',
    '.local/state/personal-agent-control/owned-skill-map.json',
    '.local/state/personal-agent-control/owned-plugins.tsv',
    '.local/state/personal-agent-control/external-skills.json',
  ];
  const outer = await makeOuterTransaction(root, home, managedPaths);
  const authorization = {
    PAC_PRECREATED_BACKUP: outer.backup,
    PAC_CHEZMOI_TRANSACTION: outer.marker,
    PAC_CHEZMOI_TOKEN: outer.token,
  };
  const failed = runJsonPac(root, home, ['apply'], {
    ...env,
    ...authorization,
    PAC_SKIP_POST_DOCTOR: '0',
    PAC_DOCTOR: doctor,
  });

  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.error.code, 'POST_APPLY_VERIFICATION_FAILED');
  assert.equal(failed.json?.error.details?.rollback?.succeeded, true);
  assert.equal(failed.json?.error.details?.rollback?.backup, outer.backup);
  assert.deepEqual(failed.json?.error.details?.rollback?.resolver, {
    skipped: true,
    reason: 'chezmoi-outer-source-state-not-archived',
    next: 'run pac apply after the Chezmoi transaction completes',
  });
  assert.equal(await exists(`${outer.marker}.claim`), true);
  assert.equal(await exists(outer.lock), true);
  for (const artifact of [
    path.join(home, '.local/share/agent-skills'),
    path.join(home, '.agents/skills/base-skill'),
    path.join(home, '.claude/skills/base-skill'),
  ]) assert.equal(await exists(artifact), false, artifact);

  const contender = runJsonPac(root, home, ['apply'], env);
  assert.notEqual(contender.status, 0, contender.stdout);
  assert.equal(contender.json?.error.code, 'PAC_LOCKED');
  const reused = runJsonPac(root, home, ['apply'], { ...env, ...authorization });
  assert.notEqual(reused.status, 0, reused.stdout);
  assert.equal(reused.json?.error.code, 'PAC_CHEZMOI_TRANSACTION_USED');
});

test('doctor ignores a selected but disabled host', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const applied = runJsonPac(root, home, ['install', 'codex'], env, 'codex');
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const failIfCalled = path.join(root, 'doctor-must-not-run.sh');
  await fs.writeFile(failIfCalled, '#!/bin/sh\nexit 49\n', { mode: 0o755 });
  const checked = runJsonPac(root, home, ['doctor'], {
    ...env,
    PAC_DOCTOR: failIfCalled,
    PAC_SKIP_POST_DOCTOR: '0',
  }, 'claude');
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(checked.json?.data?.doctor, 'No hosts enabled.');
  assert.deepEqual(checked.json?.data?.status?.adapters, []);
  assert.deepEqual(checked.json?.data?.status?.projections, []);
});

test('doctor.sh checks the resolver revision with the exact active Profile root', async () => {
  const root = await temporary('pac-doctor-profile-source-');
  const home = await temporary('pac-doctor-profile-home-');
  const profile = path.join(home, '.local/share/personal-agent-profiles/repository/commit');
  const resolverLog = path.join(home, 'resolver-args.json');
  const pacSource = path.join(root, 'bin/pac');
  const installedPac = path.join(home, '.local/bin/pac');
  const mise = path.join(home, '.local/bin/mise');
  const apm = path.join(home, 'fake-apm');
  const resolver = path.join(root, 'payload/skills/capability-resolver/scripts/capability-resolver.mjs');
  const expectedRules = path.join(root, 'generated/codex/AGENTS.md');
  const expectedReviewer = path.join(root, 'generated/codex/agents/independent-reviewer.toml');
  const installedRules = path.join(home, '.codex/AGENTS.md');
  const installedReviewer = path.join(home, '.codex/agents/independent-reviewer.toml');
  await Promise.all([
    fs.mkdir(path.dirname(pacSource), { recursive: true }),
    fs.mkdir(path.dirname(installedPac), { recursive: true }),
    fs.mkdir(path.dirname(resolver), { recursive: true }),
    fs.mkdir(path.dirname(expectedReviewer), { recursive: true }),
    fs.mkdir(path.dirname(installedReviewer), { recursive: true }),
    fs.mkdir(path.join(root, 'packages/skills'), { recursive: true }),
    fs.mkdir(profile, { recursive: true }),
    fs.mkdir(path.join(root, 'scripts'), { recursive: true }),
  ]);
  const healthy = JSON.stringify({
    ok: true,
    data: {
      ok: true,
      apm: { actual: '0.28.0', matches: true },
      canonicalLock: { sha256: 'a'.repeat(64) },
      runtimeLock: { matchesCanonical: true },
      skills: [{ id: 'fixture' }],
      projections: [],
      materializerExceptions: [],
      plugins: { valid: true },
    },
  });
  await Promise.all([
    fs.copyFile(path.join(repo, 'scripts/doctor.sh'), path.join(root, 'scripts/doctor.sh')),
    fs.writeFile(pacSource, `#!/bin/sh\ncase " $* " in *" --help "*) exit 0 ;; esac\nprintf '%s\\n' ${JSON.stringify(healthy)}\n`, { mode: 0o755 }),
    fs.writeFile(mise, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
    fs.writeFile(apm, '#!/bin/sh\n[ "${1:-}" = --version ] && echo "apm 0.28.0"\nexit 0\n', { mode: 0o755 }),
    fs.writeFile(resolver, `import fs from 'node:fs'; fs.writeFileSync(process.env.DOCTOR_RESOLVER_LOG, JSON.stringify(process.argv.slice(2)));\n`),
    fs.writeFile(expectedRules, 'rules\n'),
    fs.writeFile(expectedReviewer, 'reviewer\n'),
    fs.writeFile(installedRules, 'rules\n'),
    fs.writeFile(installedReviewer, 'reviewer\n'),
  ]);
  await fs.symlink(pacSource, installedPac);
  const result = spawnSync('sh', [
    path.join(root, 'scripts/doctor.sh'),
    '--home', home,
    '--agents', 'codex',
    '--profile', profile,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PAC_APM: apm,
      DOCTOR_RESOLVER_LOG: resolverLog,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(resolverLog, 'utf8')), [
    'check', '--repo', root, '--home', home,
    '--db', path.join(home, '.cache/personal-agent-control/capabilities-v1.sqlite'),
    '--profile', profile,
  ]);
});

test('host enable preserves profile order and re-enabled hosts append', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const profile = path.join(home, '.config/personal-agent-control/machine.json');
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.writeFile(profile, `${JSON.stringify({
    schemaVersion: 1,
    enabledHosts: ['claude', 'codex'],
  })}\n`);

  const noOp = runJsonPac(root, home, ['host', 'enable', 'claude'], env, 'claude');
  assert.equal(noOp.status, 0, noOp.stderr || noOp.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(profile, 'utf8')).enabledHosts, ['claude', 'codex']);

  const disabled = runJsonPac(root, home, ['host', 'disable', 'claude'], env, 'claude');
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(profile, 'utf8')).enabledHosts, ['codex']);

  const reEnabled = runJsonPac(root, home, ['host', 'enable', 'claude'], env, 'claude');
  assert.equal(reEnabled.status, 0, reEnabled.stderr || reEnabled.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(profile, 'utf8')).enabledHosts, ['codex', 'claude']);
});

test('an unscoped host mutation targets only that host and ignores an unsafe enabled peer', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const profile = path.join(home, '.config/personal-agent-control/machine.json');
  const outside = await temporary('pac-host-default-scope-peer-');
  const sentinel = path.join(outside, 'sentinel.txt');
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.writeFile(profile, `${JSON.stringify({ schemaVersion: 1, enabledHosts: ['claude'] })}\n`);
  await fs.writeFile(sentinel, 'preserve peer\n');
  await fs.symlink(outside, path.join(home, '.claude'), 'dir');

  const enabled = runJsonPacUnscoped(root, home, ['host', 'enable', 'codex'], env);
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(profile, 'utf8')).enabledHosts, ['claude', 'codex']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve peer\n');

  const disabled = runJsonPacUnscoped(root, home, ['host', 'disable', 'codex'], env);
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  assert.deepEqual(JSON.parse(await fs.readFile(profile, 'utf8')).enabledHosts, ['claude']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve peer\n');
});

test('failed host mutation restores machine profile bytes exactly', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const applied = runJsonPac(root, home, ['apply'], env);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const profile = path.join(home, '.config/personal-agent-control/machine.json');
  const before = Buffer.from('{\n  "schemaVersion": 1,\n  "enabledHosts": ["codex", "claude"],\n  "note": "preserve exact bytes"\n}\n');
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.writeFile(profile, before);
  const failingDoctor = path.join(root, 'failing-host-doctor.sh');
  await fs.writeFile(failingDoctor, '#!/bin/sh\nexit 51\n', { mode: 0o755 });
  const failed = runJsonPac(root, home, ['host', 'disable', 'claude'], {
    ...env,
    PAC_DOCTOR: failingDoctor,
    PAC_SKIP_POST_DOCTOR: '0',
  }, 'all');
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.error?.code, 'POST_APPLY_VERIFICATION_FAILED');
  assert.equal((await fs.readFile(profile)).equals(before), true);
});

test('fresh single-host install retires proven source-default state without inventing later ownership', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const both = runJsonPac(root, home, ['apply'], env);
  assert.equal(both.status, 0, both.stderr || both.stdout);
  assert.equal(await exists(path.join(home, '.claude/skills/base-skill')), true);
  assert.equal(await exists(path.join(home, '.config/personal-agent-control/machine.json')), false);

  const installed = runJsonPac(root, home, ['install', 'codex'], env, 'codex');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(await exists(path.join(home, '.agents/skills/base-skill')), true);
  assert.equal(await exists(path.join(home, '.claude/skills/base-skill')), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.config/personal-agent-control/machine.json'), 'utf8')).enabledHosts, ['codex']);

  const scoped = runJsonPac(root, home, ['apply'], env, 'all');
  assert.equal(scoped.status, 0, scoped.stderr || scoped.stdout);
  const paths = await fs.readFile(path.join(scoped.json.data.backup, 'managed-paths.txt'), 'utf8');
  assert.doesNotMatch(paths, /^\.claude\/CLAUDE\.md$/mu);
  assert.doesNotMatch(paths, /^\.claude\/agents\/independent-reviewer\.md$/mu);
});

test('status exposes managed content drift as structured unhealthy state', async () => {
  const home = await temporary('pac-status-drift-');
  const fakeApm = path.join(home, 'apm');
  await fs.writeFile(fakeApm, '#!/bin/sh\necho "apm 0.28.0"\n', { mode: 0o755 });
  const neutral = path.join(home, '.local/share/agent-skills');
  const managed = path.join(neutral, '.agents/skills/canonical-state/SKILL.md');
  await fs.mkdir(path.dirname(managed), { recursive: true });
  await fs.writeFile(managed, 'modified\n');
  let runtimeLock = await fs.readFile(path.join(repo, 'packages/skills/apm.lock.yaml'), 'utf8');
  runtimeLock = runtimeLock.replace(
    '  package_type: claude_skill\n  source: local',
    `  package_type: claude_skill\n  deployed_files:\n  - .agents/skills/canonical-state/SKILL.md\n  deployed_file_hashes:\n    .agents/skills/canonical-state/SKILL.md: sha256:${'0'.repeat(64)}\n  source: local`,
  );
  await fs.writeFile(path.join(neutral, 'apm.lock.yaml'), runtimeLock);
  const result = spawnSync(path.join(repo, 'bin/pac'), ['--json', '--home', home, 'status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PAC_NODE: process.execPath,
      PAC_APM: fakeApm,
      PAC_NO_PLUGINS: '1',
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.ok, false);
  assert.equal(parsed.data.runtimeContent.valid, false);
  assert.equal(parsed.data.runtimeContent.code, 'MANAGED_DRIFT');
});

test('real Core APM apply succeeds while a local personal Skill dependency fails closed without state drift', { timeout: 120_000 }, async () => {
  const { root, home, demo, env } = await makeRealLifecycleFixture();
  const neutral = path.join(home, '.local/share/agent-skills');
  const resolver = path.join(root, 'payload/skills/capability-resolver/scripts/capability-resolver.mjs');

  const indexCheck = async () => {
    const profile = await loadActiveProfile({ ...context(home), root });
    const result = spawnSync(process.execPath, [
      resolver, 'check', '--repo', root, '--home', home,
      ...(profile ? ['--profile', profile.root] : []),
    ], {
      encoding: 'utf8', env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  };
  const installed = runJsonPac(root, home, ['apply'], env);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(installed.json?.ok, true);
  assert.equal(await exists(path.join(neutral, '.agents/skills/base-skill/SKILL.md')), true);
  assert.equal(await exists(path.join(home, '.agents/skills/base-skill')), true);
  assert.equal(await exists(path.join(home, '.claude/skills/base-skill')), true);
  await indexCheck();

  const initialized = runJsonPac(root, home, ['profile', 'init'], env);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const workspace = JSON.parse(await fs.readFile(
    path.join(home, '.config/personal-agent-control/profile-workspace.json'),
    'utf8',
  ));
  const beforeFailure = {
    source: await repositoryState(root),
    workspace: await directoryDigest(workspace.path),
    runtime: await directoryDigest(neutral),
    codex: await directoryDigest(path.join(home, '.agents/skills')),
    claude: await directoryDigest(path.join(home, '.claude/skills')),
  };
  const runtimeLockBefore = await fs.readFile(path.join(neutral, 'apm.lock.yaml'), 'utf8');
  const failed = runJsonPac(root, home, ['skill', 'add', demo], env);
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.equal(failed.json?.ok, false);
  assert.equal(failed.json?.error.code, 'PROFILE_APM_NON_PORTABLE');
  await assertRepositoryState(root, beforeFailure.source);
  assert.equal(await directoryDigest(workspace.path), beforeFailure.workspace);
  assert.equal(await directoryDigest(neutral), beforeFailure.runtime);
  assert.equal(await directoryDigest(path.join(home, '.agents/skills')), beforeFailure.codex);
  assert.equal(await directoryDigest(path.join(home, '.claude/skills')), beforeFailure.claude);
  assert.equal(await fs.readFile(path.join(neutral, 'apm.lock.yaml'), 'utf8'), runtimeLockBefore);
  assert.equal(await exists(path.join(neutral, '.agents/skills/demo-skill')), false);
  assert.equal(await exists(path.join(home, '.agents/skills/demo-skill')), false);
  assert.equal(await exists(path.join(home, '.claude/skills/demo-skill')), false);
  await indexCheck();
  const finalStatus = runJsonPac(root, home, ['status'], env);
  assert.equal(finalStatus.status, 0, finalStatus.stderr || finalStatus.stdout);
  assert.equal(finalStatus.json?.data?.ok, true);
});

test('Plugin mutation preserves host scope before host lifecycle reconciliation', { timeout: 120_000 }, async () => {
  const { root, home, env } = await makeRealLifecycleFixture();
  const plugin = 'fixture-plugin';
  const marketplace = 'fixture-marketplace';
  const providerId = `provider:plugin:${plugin}@${marketplace}`;
  const source = path.join(home, '.local/share/agent-plugins/sources', marketplace);
  const bundled = path.join(source, 'plugins', plugin, 'skills', 'review-final');
  const stateDir = path.join(home, '.plugin-fixture-state');
  const reconciler = path.join(root, 'plugin-reconciler.cjs');
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'SKILL.md'), '---\nname: review-final\ndescription: Review final fixture.\n---\n');
  await fs.writeFile(path.join(root, 'catalog/plugins.tsv'), [
    '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility',
    `${plugin}\t${marketplace}\tgithub-tag\texample/plugin\tv1\t${'c'.repeat(40)}\t${'d'.repeat(40)}\t1.0.0\tcodex,claude\treview-final\tMIT\tprivate`,
    '',
  ].join('\n'));
  const overlayPath = path.join(root, 'catalog/capabilities.jsonl');
  const overlay = `${await fs.readFile(overlayPath, 'utf8')}${JSON.stringify({
    id: providerId, memberships: ['kind.provider.plugin'], summary: 'Fixture Plugin provider.',
  })}\n${JSON.stringify({
    id: 'skill:review-final', memberships: ['kind.skill'], summary: 'Fixture bundled Skill.',
  })}\n`;
  await fs.writeFile(overlayPath, overlay);
  await fs.writeFile(path.join(root, 'catalog/files.sha256'), await sourceIntegrityManifest(root));
  const configPath = path.join(root, 'pac.json');
  const initialConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
  initialConfig.plugins.enabled = [plugin];
  await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
  await fs.writeFile(reconciler, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const rows = fs.readFileSync(value('--catalog'), 'utf8').split(/\\r?\\n/u)
  .filter((line) => line && !line.startsWith('#')).map((line) => line.split('\\t')[0]).sort();
fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });
fs.writeFileSync(path.join(${JSON.stringify(stateDir)}, value('--agents') + '.json'), JSON.stringify(rows));
`, { mode: 0o755 });

  const run = (scope, args) => spawnSync(path.join(repo, 'bin/pac'), [
    '--json', '--home', home, '--hosts', scope, ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env, ...env, HOME: home, PAC_ROOT: root, PAC_NODE: process.execPath,
      PAC_NO_PLUGINS: '0', PAC_PLUGIN_RECONCILER: reconciler,
      PAC_HOST_ADAPTER_MODE: 'skip',
    },
  });
  const state = async (host) => JSON.parse(await fs.readFile(path.join(stateDir, `${host}.json`), 'utf8'));
  const writeState = async (host, value) => {
    await fs.writeFile(path.join(stateDir, `${host}.json`), JSON.stringify(value));
  };
  const targets = () => {
    const db = new DatabaseSync(path.join(home, '.cache/personal-agent-control/capabilities-v1.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT targets_json FROM capability WHERE id = ?').get(providerId);
      return row ? JSON.parse(row.targets_json) : null;
    } finally { db.close(); }
  };
  const expectSuccess = (result) => assert.equal(result.status, 0, result.stderr || result.stdout);

  expectSuccess(run('all', ['apply']));
  assert.deepEqual(await state('codex'), [plugin]);
  assert.deepEqual(await state('claude'), [plugin]);
  assert.deepEqual(targets(), ['claude', 'codex']);

  await writeState('claude', ['claude-remove-sentinel']);
  expectSuccess(run('codex', ['plugin', 'remove', plugin]));
  assert.deepEqual(await state('codex'), []);
  assert.deepEqual(await state('claude'), ['claude-remove-sentinel']);
  assert.equal(targets(), null);

  await writeState('claude', ['claude-add-sentinel']);
  expectSuccess(run('codex', ['plugin', 'add', plugin]));
  assert.deepEqual(await state('codex'), [plugin]);
  assert.deepEqual(await state('claude'), ['claude-add-sentinel']);
  assert.deepEqual(targets(), ['claude', 'codex']);

  await writeState('claude', ['claude-update-sentinel']);
  expectSuccess(run('codex', ['plugin', 'update', plugin]));
  assert.deepEqual(await state('codex'), [plugin]);
  assert.deepEqual(await state('claude'), ['claude-update-sentinel']);
  assert.deepEqual(targets(), ['claude', 'codex']);

  expectSuccess(run('all', ['apply']));
  assert.deepEqual(await state('codex'), [plugin]);
  assert.deepEqual(await state('claude'), [plugin]);
  const sourceConfigBeforeHostChanges = await fs.readFile(configPath, 'utf8');

  expectSuccess(run('codex', ['host', 'disable', 'claude']));
  assert.deepEqual(await state('codex'), [plugin]);
  assert.deepEqual(await state('claude'), []);
  assert.deepEqual(targets(), ['codex']);
  assert.equal(await exists(path.join(home, '.claude/skills/base-skill')), false);

  expectSuccess(run('claude', ['host', 'disable', 'codex']));
  assert.deepEqual(await state('codex'), []);
  assert.deepEqual(await state('claude'), []);
  assert.equal(targets(), null);
  assert.equal(await exists(path.join(home, '.agents/skills/base-skill')), false);

  expectSuccess(run('codex', ['host', 'enable', 'claude']));
  assert.deepEqual(await state('codex'), []);
  assert.deepEqual(await state('claude'), [plugin]);
  assert.deepEqual(targets(), ['claude']);
  assert.equal(await fs.readFile(configPath, 'utf8'), sourceConfigBeforeHostChanges);
});

test('self-update refuses a dirty tracked worktree before network or apply', async () => {
  const root = await temporary('pac-self-update-');
  const home = await temporary('pac-self-update-home-');
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(git(['init', '--quiet']).status, 0);
  assert.equal(git(['config', 'user.name', 'PAC Test']).status, 0);
  assert.equal(git(['config', 'user.email', 'pac@example.invalid']).status, 0);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'clean\n');
  assert.equal(git(['add', 'tracked.txt']).status, 0);
  assert.equal(git(['commit', '--quiet', '-m', 'fixture']).status, 0);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'dirty\n');
  const result = spawnSync(path.join(repo, 'bin/pac'), ['--json', '--home', home, 'self-update'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PAC_NODE: process.execPath, PAC_ROOT: root },
  });
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'SELF_UPDATE_DIRTY');

  const untrackedRoot = await temporary('pac-self-update-untracked-');
  const untrackedGit = (args) => spawnSync('git', ['-C', untrackedRoot, ...args], { encoding: 'utf8' });
  assert.equal(untrackedGit(['init', '--quiet']).status, 0);
  await fs.writeFile(path.join(untrackedRoot, 'untracked.txt'), 'dirty\n');
  const untrackedResult = spawnSync(path.join(repo, 'bin/pac'), ['--json', '--home', home, 'self-update'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PAC_NODE: process.execPath, PAC_ROOT: untrackedRoot },
  });
  assert.equal(untrackedResult.status, 1, untrackedResult.stderr);
  const untracked = JSON.parse(untrackedResult.stdout);
  assert.equal(untracked.ok, false);
  assert.equal(untracked.error.code, 'SELF_UPDATE_DIRTY');
  assert.deepEqual(untracked.error.details.changedPaths, ['untracked.txt']);
});
