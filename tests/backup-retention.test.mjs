import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { abandonManagedBackup, completeManagedBackup, createManagedBackup, registerManagedBackup, retainManagedBackups } from '../src/backup-retention.mjs';
import { createBackup } from '../src/state.mjs';
import { hasUnownedNativeBaseline } from '../src/commands.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-backup-retention-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const context = { home, stateDir: path.join(home, '.local/state/personal-agent-control') };
  const create = async (options = {}) => {
    const { mode = 'apply', outcome = 'complete', containsUnownedOriginals = false } = options;
    const backup = await createManagedBackup(context, { mode, prefix: mode });
    await fs.writeFile(path.join(backup, 'original'), 'fixture rollback content');
    if (outcome) assert.deepEqual(await completeManagedBackup(context, backup, { outcome, containsUnownedOriginals }), { ok: true });
    return backup;
  };
  return { context, create, registry: path.join(context.stateDir, 'backup-retention.json') };
}

test('retention bounds terminal snapshots per mode while retaining originals, active and unknown data', async t => {
  const f = await fixture(t);
  const original = await f.create({ containsUnownedOriginals: true });
  const active = await f.create({ outcome: null });
  const old = [];
  for (const mode of ['apply', 'provider-only', 'policy-only']) {
    for (let index = 0; index < 5; index++) old.push({ backup: await f.create({ mode }), mode, index });
  }
  const unknown = path.join(path.dirname(original), 'historical-backup');
  await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, 'original'), 'unknown original');
  const result = await retainManagedBackups(f.context);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.removed.length, 6);
  for (const row of old) {
    if (row.index < 2) await assert.rejects(fs.access(row.backup), { code: 'ENOENT' });
    else await fs.access(row.backup);
  }
  for (const backup of [original, active, unknown]) await fs.access(backup);
});

test('pointers, pinned snapshots, changed snapshots and incomplete rollback evidence remain protected', async t => {
  const f = await fixture(t);
  const pointer = await f.create();
  const pinned = await f.create();
  const changed = await f.create();
  for (let index = 0; index < 3; index++) await f.create();
  await fs.writeFile(path.join(f.context.stateDir, 'last-backup'), `${pointer}\n`);
  const registry = JSON.parse(await fs.readFile(f.registry, 'utf8'));
  registry.records.find(r => r.name === path.basename(pinned)).pinned = true;
  await fs.writeFile(f.registry, JSON.stringify(registry));
  await fs.appendFile(path.join(changed, 'original'), 'concurrent edit');
  const result = await retainManagedBackups(f.context);
  assert.equal(result.removed.length, 0);
  assert.match(result.warnings.join('\n'), /changed/u);
  for (const backup of [pointer, pinned, changed]) await fs.access(backup);
});

test('registration refuses old nonempty snapshots and retention never trusts a copied marker', async t => {
  const f = await fixture(t);
  const original = await f.create();
  const unknown = path.join(path.dirname(original), 'unknown');
  await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, 'data'), 'original');
  await assert.rejects(registerManagedBackup(f.context, unknown), /newly-created empty/u);
  const replacement = `${original}-replacement`;
  await fs.rename(original, replacement);
  await fs.mkdir(original);
  await fs.copyFile(path.join(replacement, '.pac-backup.json'), path.join(original, '.pac-backup.json'));
  for (let index = 0; index < 3; index++) await f.create();
  const result = await retainManagedBackups(f.context);
  assert.match(result.warnings.join('\n'), /identity changed/u);
  assert.equal(result.removed.length, 0);
  await fs.access(replacement); await fs.access(unknown); await fs.access(original);
});

test('cleanup failures are warnings and interrupted deletion fails closed', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index++) await f.create();
  const remove = fs.rm;
  t.mock.method(fs, 'rm', async (file, options) => {
    if (path.dirname(file).endsWith('backups/personal-agent-control')) throw new Error('fixture removal denied');
    return remove(file, options);
  });
  const result = await retainManagedBackups(f.context);
  assert.match(result.warnings.join('\n'), /fixture removal denied/u);
  t.mock.restoreAll();
  assert.match((await retainManagedBackups(f.context)).warnings.join('\n'), /Interrupted/u);
});

test('retention rejects symlinked backup roots and caps oversized snapshot trees', async t => {
  const f = await fixture(t);
  const backup = await f.create({ outcome: null });
  const originalOpendir = fs.opendir;
  t.mock.method(fs, 'opendir', async file => {
    if (file !== backup) return originalOpendir(file);
    return { async *[Symbol.asyncIterator]() { for (let i = 0; i < 8193; i++) yield { name: `entry-${i}` }; }, async close() {} };
  });
  const sealed = await completeManagedBackup(f.context, backup, { outcome: 'complete', containsUnownedOriginals: false });
  assert.equal(sealed.ok, false);
  assert.match(sealed.warning, /budget/u);
  t.mock.restoreAll();
  const root = path.dirname(backup);
  await fs.rename(root, `${root}-original`);
  await fs.symlink(`${root}-original`, root);
  assert.equal((await retainManagedBackups(f.context)).removed.length, 0);
  await assert.rejects(createManagedBackup(f.context, { prefix: 'apply', mode: 'apply' }), { code: 'PATH_UNSAFE' });
  await fs.access(path.join(`${root}-original`, path.basename(backup), 'original'));
});

test('failed full backup copying removes only its created directory and active registration', async t => {
  const f = await fixture(t);
  f.context.root = path.join(f.context.home, 'core');
  await fs.mkdir(f.context.root);
  const original = path.join(f.context.home, '.config/personal-agent-control/machine.json');
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.writeFile(original, 'original user configuration');
  const cp = fs.cp;
  t.mock.method(fs, 'cp', async (source, destination, options) => {
    if (source === original) throw Object.assign(new Error('fixture copy denied'), { code: 'EIO' });
    return cp(source, destination, options);
  });
  const config = { hosts: { codex: { enabled: false }, claude: { enabled: false } } };
  await assert.rejects(createBackup(f.context, config, path.join(f.context.home, '.local/share/agent-skills'), [], { activeHosts: [] }), { code: 'EIO' });
  assert.deepEqual(JSON.parse(await fs.readFile(f.registry, 'utf8')).records, []);
  assert.deepEqual(await fs.readdir(path.join(f.context.home, '.agent-work/backups/personal-agent-control')), []);
  assert.equal(await fs.readFile(original, 'utf8'), 'original user configuration');
  t.mock.restoreAll();
  const active = await f.create({ outcome: null });
  await assert.rejects(abandonManagedBackup(f.context, active), /still exists/u);
  const mkdir = fs.mkdir;
  let unknown;
  t.mock.method(fs, 'mkdir', async (file, options) => {
    if (path.dirname(file) === path.dirname(active) && file !== active) {
      unknown = file;
      await mkdir(file, options);
      await fs.writeFile(path.join(file, 'original'), 'unknown existing data');
      throw Object.assign(new Error('fixture existing directory'), { code: 'EEXIST' });
    }
    return mkdir(file, options);
  });
  await assert.rejects(createBackup(f.context, config, path.join(f.context.home, '.local/share/agent-skills'), [], { activeHosts: [] }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(unknown, 'original'), 'utf8'), 'unknown existing data');
});

test('native takeover baseline uses per-host and provider ownership rather than Skill history', async t => {
  const f = await fixture(t);
  const config = path.join(f.context.home, '.claude/settings.json');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, '{"userPreference":true}');
  await fs.mkdir(f.context.stateDir, { recursive: true });
  await fs.writeFile(path.join(f.context.stateDir, 'owned-skill-map.json'), '{"priorSkill":"owned"}');
  assert.equal(await hasUnownedNativeBaseline(f.context, ['claude'], null), true);
  await fs.writeFile(path.join(f.context.stateDir, 'owned-host-adapters.json'), JSON.stringify({ schemaVersion: 1, hosts: { claude: [{ targetRelative: '.claude/CLAUDE.md', sha256: 'a'.repeat(64) }] } }));
  assert.equal(await hasUnownedNativeBaseline(f.context, ['claude'], null), false);
  const profile = { skills: [], manifest: { providers: { enabled: ['playwright'] } } };
  assert.equal(await hasUnownedNativeBaseline(f.context, ['claude'], profile), true);
  await fs.writeFile(path.join(f.context.stateDir, 'owned-providers.json'), JSON.stringify({ schemaVersion: 1, providers: { playwright: { claude: { profileCommit: 'a'.repeat(40) } } } }));
  assert.equal(await hasUnownedNativeBaseline(f.context, ['claude'], profile), false);
  profile.skills = [{ name: 'resource-guard' }, { name: 'workspace-locator' }];
  assert.equal(await hasUnownedNativeBaseline(f.context, ['claude'], profile), true);
  await fs.writeFile(path.join(f.context.stateDir, 'scan-guard.json'), JSON.stringify({ schemaVersion: 1, hosts: { claude: { entrySha256: 'a'.repeat(64) } } }));
  assert.equal(await hasUnownedNativeBaseline(f.context, ['claude'], profile), false);
  assert.equal(await hasUnownedNativeBaseline(f.context, ['codex'], profile), false);
});
