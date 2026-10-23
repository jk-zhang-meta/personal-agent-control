import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';

const FILE = 'backup-retention.json';
const MARKER = '.pac-backup.json';
const MAX_RECORDS = 4096;
const rootFor = (context) => path.join(context.home, '.agent-work/backups/personal-agent-control');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };

async function readRegistry(context) {
  const file = path.join(context.stateDir, FILE);
  await assertSafeManagedObject(context.home, file, 'backup retention registry', 'file');
  let bytes;
  try {
    const stat = await fs.lstat(file);
    if (stat.size > 4 * 1024 * 1024) fail('Backup registry exceeds 4 MiB.');
    bytes = await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, records: [] }; throw error; }
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== 1 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS
      || value.records.some((r) => !r || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(r.name || '') || !/^[a-f0-9-]{36}$/u.test(r.token || '')
        || !['apply', 'policy-only', 'provider-only'].includes(r.mode))
      || new Set(value.records.map((r) => r.name)).size !== value.records.length) fail('Invalid backup retention registry.');
  return value;
}

async function writeRegistry(context, registry) {
  const file = path.join(context.stateDir, FILE);
  await assertSafeManagedObject(context.home, file, 'backup retention registry', 'file');
  await atomicWriteFile(file, `${JSON.stringify(registry, null, 2)}\n`);
}

function budget() { return { entries: 0, deadline: Date.now() + 3000 }; }

// ponytail: bounded lstat identities under the PAC lock; oversized trees stay protected.
async function fingerprint(directory, limits = budget()) {
  const rows = [];
  const walk = async (file, relative) => {
    if (++limits.entries > 8192 || Date.now() > limits.deadline) fail('Backup fingerprint budget exceeded.');
    const stat = await fs.lstat(file);
    const row = { path: relative, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    if (stat.isDirectory()) {
      const names = [];
      const handle = await fs.opendir(file);
      try {
        for await (const entry of handle) {
          if (names.length + limits.entries >= 8192 || Date.now() > limits.deadline) fail('Backup directory budget exceeded.');
          names.push(entry.name);
        }
      } finally { await handle.close().catch((e) => { if (e.code !== 'ERR_DIR_CLOSED') throw e; }); }
      rows.push(row);
      for (const name of names.sort()) await walk(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isSymbolicLink()) { row.link = await fs.readlink(file); rows.push(row); }
    else if (stat.isFile()) {
      rows.push(row);
    } else fail('Unsupported backup object.');
  };
  await walk(directory, '');
  return digest(JSON.stringify(rows));
}

async function ownedDirectory(context, record) {
  const backup = path.join(rootFor(context), record.name);
  await assertSafeManagedObject(context.home, backup, 'registered PAC backup', 'directory');
  const stat = await fs.lstat(backup);
  if (stat.dev !== record.dev || stat.ino !== record.ino || stat.uid !== record.uid) fail('Backup directory identity changed.');
  const marker = path.join(backup, MARKER);
  await assertSafeManagedObject(context.home, marker, 'PAC backup marker', 'file');
  if ((await fs.stat(marker)).size > 2048) fail('Backup marker exceeds its bound.');
  const expected = { schemaVersion: 1, owner: 'personal-agent-control', token: record.token, name: record.name, mode: record.mode };
  if (!same(JSON.parse(await fs.readFile(marker, 'utf8')), expected)) fail('Backup ownership marker changed.');
  return backup;
}

// Must be called under the existing PAC lock, immediately after mkdir of an empty backup.
// Existing snapshots are deliberately never adopted.
export async function registerManagedBackup(context, backup, { mode = 'apply' } = {}) {
  if (path.dirname(backup) !== rootFor(context) || !['apply', 'policy-only', 'provider-only'].includes(mode)) fail('Invalid backup registration target.');
  await assertSafeManagedObject(context.home, backup, 'new PAC backup', 'directory');
  const registry = await readRegistry(context);
  if (registry.records.length >= MAX_RECORDS) fail('Backup retention registry is full; review protected snapshots.');
  const handle = await fs.opendir(backup);
  try { if (await handle.read()) fail('Only a newly-created empty backup may be registered.'); }
  finally { await handle.close(); }
  const stat = await fs.lstat(backup);
  const name = path.basename(backup);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(name) || registry.records.some((r) => r.name === name)) fail('Invalid or duplicate backup name.');
  const token = crypto.randomUUID();
  await fs.writeFile(path.join(backup, MARKER), `${JSON.stringify({ schemaVersion: 1, owner: 'personal-agent-control', token, name, mode })}\n`, { flag: 'wx', mode: 0o600 });
  registry.records.push({ name, token, mode, dev: stat.dev, ino: stat.ino, uid: stat.uid, state: 'active', createdAt: Date.now() });
  await writeRegistry(context, registry);
  return backup;
}

export async function createManagedBackup(context, { prefix, mode }) {
  const backup = path.join(rootFor(context), `${prefix}-${Date.now()}-${crypto.randomUUID()}`);
  await assertSafeManagedObject(context.home, backup, 'new PAC backup', 'directory');
  await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await fs.mkdir(backup, { mode: 0o700 });
  return registerManagedBackup(context, backup, { mode });
}

// Forget only an active registration after the caller has removed its own failed snapshot.
// Existing bytes and terminal records are never abandoned.
export async function abandonManagedBackup(context, backup) {
  if (path.dirname(backup) !== rootFor(context)) fail('Invalid abandoned backup target.');
  const registry = await readRegistry(context);
  const record = registry.records.find((r) => path.join(rootFor(context), r.name) === backup);
  if (!record) return;
  if (record.state !== 'active') fail('Only an active failed backup may be abandoned.');
  await assertSafeManagedObject(context.home, backup, 'abandoned PAC backup', 'directory');
  try { await fs.lstat(backup); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    registry.records = registry.records.filter((r) => r !== record);
    await writeRegistry(context, registry);
    return;
  }
  fail('Cannot abandon a backup that still exists.');
}

// Sealing is advisory: failure preserves an active snapshot and cannot undo a successful install.
export async function completeManagedBackup(context, backup, { outcome, containsUnownedOriginals = true } = {}) {
  try {
    if (!['complete', 'rolled-back'].includes(outcome)) fail('Backup outcome is not terminal.');
    const registry = await readRegistry(context);
    const record = registry.records.find((r) => path.join(rootFor(context), r.name) === backup);
    if (!record || record.state !== 'active') fail('Backup is not an active registered snapshot.');
    await ownedDirectory(context, record);
    record.fingerprint = await fingerprint(backup);
    record.state = outcome;
    record.containsUnownedOriginals = containsUnownedOriginals !== false;
    record.completedAt = Date.now();
    await writeRegistry(context, registry);
    return { ok: true };
  } catch (error) { return { ok: false, warning: error.message }; }
}

// Call under the PAC lock only after authoritative deployment/rollback success.
export async function retainManagedBackups(context, { keepPerMode = 3, protectedBackups = [] } = {}) {
  const result = { removed: [], warnings: [] };
  try {
    if (!Number.isInteger(keepPerMode) || keepPerMode < 1 || keepPerMode > 100) fail('Invalid backup retention count.');
    const registry = await readRegistry(context);
    if (registry.records.some((r) => r.state === 'deleting')) fail('Interrupted backup removal requires review.');
    const protectedPaths = new Set(protectedBackups.map((p) => path.resolve(p)));
    for (const file of ['last-backup', 'policy-deployment.json']) {
      const pointer = path.join(context.stateDir, file);
      await assertSafeManagedObject(context.home, pointer, 'backup pointer', 'file');
      try {
        if ((await fs.stat(pointer)).size > 1024 * 1024) fail('Backup pointer exceeds its bound.');
        const text = await fs.readFile(pointer, 'utf8');
        const value = file.endsWith('.json') ? JSON.parse(text).backup : text.trim();
        if (value) protectedPaths.add(path.resolve(value));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const keep = new Set();
    for (const mode of ['apply', 'policy-only', 'provider-only']) {
      // Protect newest records even when incomplete; also keep useful terminal rollback points.
      const records = registry.records.filter((r) => r.mode === mode).sort((a, b) => b.createdAt - a.createdAt);
      records.slice(0, keepPerMode).forEach((r) => keep.add(r.name));
      records.filter((r) => ['complete', 'rolled-back'].includes(r.state) && r.fingerprint)
        .slice(0, keepPerMode).forEach((r) => keep.add(r.name));
    }
    const candidates = registry.records.filter((r) => !keep.has(r.name) && !r.pinned && r.containsUnownedOriginals === false
      && ['complete', 'rolled-back'].includes(r.state) && /^[a-f0-9]{64}$/u.test(r.fingerprint || '')
      && !protectedPaths.has(path.join(rootFor(context), r.name))).slice(0, 32);
    const limits = budget();
    // Verify the whole bounded batch before mutating any candidate.
    for (const record of candidates) {
      const backup = await ownedDirectory(context, record);
      if (await fingerprint(backup, limits) !== record.fingerprint) fail(`Backup changed; preserved ${record.name}.`);
    }
    for (const record of candidates) {
      record.state = 'deleting';
      await writeRegistry(context, registry);
      const backup = await ownedDirectory(context, record);
      if (await fingerprint(backup, limits) !== record.fingerprint) fail(`Backup changed; preserved ${record.name}.`);
      await fs.rm(backup, { recursive: true });
      registry.records = registry.records.filter((r) => r !== record);
      await writeRegistry(context, registry);
      result.removed.push(backup);
    }
  } catch (error) { result.warnings.push(error.message); }
  return result;
}
