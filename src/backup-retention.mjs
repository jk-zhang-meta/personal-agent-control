import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';

const FILE = 'backup-retention.json';
const MARKER = '.pac-backup.json';
const MAX_RECORDS = 4096;
// A real apply snapshot holds tens of thousands of entries: the Skill store
// alone exceeds 12,000. A budget below that never seals, so nothing is pruned.
const MAX_TREE_ENTRIES = 262144;
const MAX_REMOVALS_PER_RUN = 8;
export const pendingRetirement = Symbol('pending snapshot retirement');
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

// ponytail: bounded lstat identities under the PAC lock; oversized trees stay protected.
async function fingerprint(directory) {
  let entries = 0;
  const rows = [];
  const walk = async (file, relative) => {
    if (++entries > MAX_TREE_ENTRIES) fail('Backup fingerprint budget exceeded.');
    const stat = await fs.lstat(file);
    const row = { path: relative, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    if (stat.isDirectory()) {
      const names = [];
      const handle = await fs.opendir(file);
      try {
        for await (const entry of handle) {
          if (names.length + entries >= MAX_TREE_ENTRIES) fail('Backup directory budget exceeded.');
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
    if (!['complete', 'rolled-back', 'awaiting-commit'].includes(outcome)) fail('Invalid backup outcome.');
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
  return pruneSnapshots(context, keepPerMode, protectedBackups, null);
}

async function healthyApplyReceipts(context) {
  const directory = path.join(context.stateDir, 'receipts');
  const healthy = new Set();
  const unverified = new Set();
  await assertSafeManagedObject(context.home, directory, 'PAC receipts', 'directory');
  let handle;
  try { handle = await fs.opendir(directory); }
  catch (error) { if (error.code === 'ENOENT') return healthy; throw error; }
  let scanned = 0;
  for await (const entry of handle) {
    if (++scanned > MAX_RECORDS) break;
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    await assertSafeManagedObject(context.home, file, 'PAC receipt', 'file');
    if ((await fs.stat(file)).size > 128 * 1024) continue;
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (receipt?.operation !== 'apply' || !receipt.backup) continue;
    if (receipt.verification?.healthy === true && receipt.verification.state === 'healthy') healthy.add(receipt.backup);
    else unverified.add(receipt.backup);
  }
  for (const backup of unverified) healthy.delete(backup);
  return healthy;
}

async function pruneSnapshots(context, keepPerMode, protectedBackups, completedTransaction) {
  const result = { removed: [], warnings: [] };
  try {
    if (!Number.isInteger(keepPerMode) || keepPerMode < 0 || keepPerMode > 100) fail('Invalid backup retention count.');
    const registry = await readRegistry(context);
    if (registry.records.some((r) => r.state === 'deleting')) fail('Interrupted backup removal requires review.');
    const protectedPaths = new Set(protectedBackups.map((p) => path.resolve(p)));
    const matchingPointers = [];
    for (const file of ['last-backup', 'policy-deployment.json']) {
      const pointer = path.join(context.stateDir, file);
      await assertSafeManagedObject(context.home, pointer, 'backup pointer', 'file');
      try {
        if ((await fs.stat(pointer)).size > 1024 * 1024) fail('Backup pointer exceeds its bound.');
        const text = await fs.readFile(pointer, 'utf8');
        const value = file.endsWith('.json') ? JSON.parse(text).backup : text.trim();
        if (value && path.resolve(value) === completedTransaction) matchingPointers.push({ file, pointer, text });
        else if (value) protectedPaths.add(path.resolve(value));
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
    const healthy = completedTransaction ? null : await healthyApplyReceipts(context);
    const candidates = registry.records.filter((r) => !r.pinned
      && (!healthy || r.mode !== 'apply' || healthy.has(path.join(rootFor(context), r.name))) &&
      (completedTransaction ? path.join(rootFor(context), r.name) === completedTransaction && r.state === 'awaiting-commit'
        : !keep.has(r.name) && r.containsUnownedOriginals === false
          && (r.state === 'complete' || (keepPerMode > 0 && r.state === 'rolled-back')))
      && /^[a-f0-9]{64}$/u.test(r.fingerprint || '')
      && !protectedPaths.has(path.join(rootFor(context), r.name))).slice(0, MAX_REMOVALS_PER_RUN);
    // Verify the whole bounded batch before mutating any candidate. Each tree
    // gets its own budget; a shared one would starve the later candidates.
    // A candidate that changed or cannot be verified is preserved and reported;
    // it must not stop the others, or one altered snapshot would end pruning
    // for good.
    const verified = [];
    for (const record of candidates) {
      try {
        const backup = await ownedDirectory(context, record);
        if (await fingerprint(backup) !== record.fingerprint) fail(`Backup changed; preserved ${record.name}.`);
        verified.push(record);
      } catch (error) { result.warnings.push(error.message); }
    }
    for (const record of verified) {
      const backup = await ownedDirectory(context, record);
      // Re-check before recording intent: a registry left in `deleting` blocks
      // every later run until someone reviews it.
      if (await fingerprint(backup) !== record.fingerprint) {
        result.warnings.push(`Backup changed; preserved ${record.name}.`);
        continue;
      }
      for (const { file, pointer, text } of matchingPointers) {
        if (await fs.readFile(pointer, 'utf8') !== text) fail('Backup pointer changed before cleanup.');
        if (file === 'last-backup') await fs.unlink(pointer);
        else await atomicWriteFile(pointer, JSON.stringify({ ...JSON.parse(text), backup: null }, null, 2));
      }
      record.state = 'deleting';
      await writeRegistry(context, registry);
      await fs.rm(backup, { recursive: true });
      registry.records = registry.records.filter((r) => r !== record);
      await writeRegistry(context, registry);
      result.removed.push(backup);
    }
  } catch (error) { result.warnings.push(error.message); }
  return result;
}

// Only the freshly sealed result of this successful operation can use its
// Profile's transaction-only override. Historical prune never takes this path.
export async function finishManagedBackup(context, backup, profile, containsUnownedOriginals) {
  const transient = profile?.manifest?.backupRetention === 'transaction-only';
  const sealed = await completeManagedBackup(context, backup, { outcome: transient ? 'awaiting-commit' : 'complete', containsUnownedOriginals });
  if (!sealed.ok) return { removed: [], warnings: [sealed.warning] };
  if (transient) return { removed: [], warnings: [], [pendingRetirement]: backup };
  return await retainManagedBackups(context, { protectedBackups: [backup] });
}

// The owner calls this after its callback, receipt and lock release have all
// succeeded. A fresh lock serializes pointer changes with other PAC commands.
export async function retireAfterCommit(context, result, acquire) {
  const backup = result?.retention?.[pendingRetirement];
  if (!backup) return;
  delete result.retention[pendingRetirement];
  try {
    const release = await acquire(context);
    try {
      result.retention = await pruneSnapshots(context, 3, [], backup);
      if (result.retention.removed.includes(backup)) result.backup = null;
      else if (!result.retention.warnings.length) result.retention.warnings.push('Transaction snapshot remains protected.');
    } finally { await release(); }
  } catch (error) { result.retention.warnings.push(error.message); }
}

// Chezmoi takes its snapshot before Node is installed. Its own still-held
// transaction lock and a token written at creation bind the two shell phases.
export async function outerBackupProof(context, backup, token) {
  if (path.dirname(backup) !== rootFor(context) || !/^[a-zA-Z0-9]+$/u.test(token || '')) fail('Invalid outer backup identity.');
  const marker = path.join(backup, '.pac-outer-token');
  await assertSafeManagedObject(context.home, marker, 'current outer snapshot', 'file');
  if (await fs.readFile(marker, 'utf8') !== token + '\n') fail('Outer backup token changed.');
  return await fingerprint(backup);
}

export async function retireOuterBackup(context, backup, token, proof) {
  if (await outerBackupProof(context, backup, token) !== proof) fail('Outer backup changed after verification.');
  const last = path.join(context.stateDir, 'last-backup');
  await assertSafeManagedObject(context.home, last, 'outer backup pointer', 'file');
  if (await fs.readFile(last, 'utf8') !== backup + '\n') fail('Outer backup pointer changed.');
  await fs.unlink(last);
  await fs.rm(backup, { recursive: true });
}
