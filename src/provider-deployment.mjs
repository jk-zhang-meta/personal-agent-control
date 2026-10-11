import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { HOSTS } from './config.mjs';
import { PacError } from './errors.mjs';
import { verifyCanonicalPayload } from './integrity.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';
import { acquireProfile } from './profile.mjs';
import { PROVIDER_CLIENTS, providerConfigurationFiles, providerStatus, reconcileProviders } from './providers.mjs';
import { withLock } from './state.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function validateSelection(context, name, clients) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name || '') || !Array.isArray(clients)
      || !clients.length || new Set(clients).size !== clients.length
      || clients.some((client) => !PROVIDER_CLIENTS.includes(client))) {
    throw new PacError('PROVIDER_INPUT_INVALID', 'Select one provider and unique codex,claude,agy,grok clients.');
  }
  // These adapters intentionally address the native, user-level locations.
  for (const [client, variable, directory] of [['codex', 'CODEX_HOME', '.codex'], ['grok', 'GROK_HOME', '.grok'], ['claude', 'CLAUDE_CONFIG_DIR', '.claude']]) {
    if (clients.includes(client) && process.env[variable]
        && path.resolve(process.env[variable]) !== path.join(context.home, directory)) {
      throw new PacError('PROVIDER_CONFIG_OVERRIDE', `Unset ${variable} or use the native HOME configuration before provider delivery.`);
    }
  }
  if (process.env.PAC_PROVIDER_NO_VERSION_CHECK === '1') {
    throw new PacError('PROVIDER_VERSION_REQUIRED', 'Provider-only delivery requires the actual runtime version check.');
  }
}

async function identity(context, file) {
  await assertSafeManagedObject(context.home, file, 'provider transaction file', 'file');
  let stat;
  try { stat = await fs.stat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.size > 2 * 1024 * 1024) throw new PacError('PROVIDER_CONFIG_INVALID', `Provider file exceeds 2 MiB: ${file}`);
  return { sha256: sha(await fs.readFile(file)), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid,
    size: stat.size, ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function metadata(file, before) {
  if (!before) return;
  if (process.platform !== 'win32') await fs.chown(file, before.uid, before.gid);
  await fs.chmod(file, before.mode);
}

export async function providerDeploymentStatus(context, { name, clients = HOSTS }) {
  validateSelection(context, name, clients);
  await verifyCanonicalPayload(context);
  await providerConfigurationFiles(context, name, clients);
  const providers = await providerStatus(context, { manifest: { providers: { enabled: [name] } } }, clients, clients, [name]);
  return { mode: 'provider-only', ok: providers.length === clients.length && providers.every((entry) => entry.valid && entry.owned),
    provider: name, clients, providers };
}

export async function synchronizeProvider(context, { name, repository, commit, clients = HOSTS }) {
  validateSelection(context, name, clients);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit || '')) {
    throw new PacError('PROVIDER_INPUT_INVALID', 'Provider sync requires an exact Profile commit.');
  }
  const owner = await fs.stat(context.home);
  if (process.geteuid && owner.uid !== process.geteuid()) {
    throw new PacError('PROVIDER_HOME_OWNER', 'Run provider sync as the target HOME owner; --home does not change the operating-system user.');
  }
  return withLock(context, async () => {
    await verifyCanonicalPayload(context);
    const profile = await acquireProfile(context, { repository, ref: commit, expectedCommit: commit });
    if (!profile.manifest.providers.enabled.includes(name)) {
      throw new PacError('PROVIDER_NOT_SELECTED', `${name} is not enabled by the verified Profile commit.`);
    }
    const files = [...new Set([...await providerConfigurationFiles(context, name, clients), path.join(context.stateDir, 'owned-providers.json')])];
    const snapshots = new Map();
    for (const file of files) {
      const before = await identity(context, file);
      if (before && process.geteuid && before.uid !== process.geteuid()) {
        throw new PacError('PROVIDER_FILE_OWNER', `Provider file is not owned by the current user: ${file}`);
      }
      snapshots.set(file, { before, times: before ? await fs.stat(file) : null });
    }
    const backup = path.join(context.home, '.agent-work/backups/personal-agent-control', `provider-${Date.now()}-${crypto.randomUUID()}`);
    await assertSafeManagedObject(context.home, backup, 'provider backup', 'directory');
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    const journal = { schemaVersion: 1, mode: 'provider-only', provider: name, clients, profileCommit: commit, state: 'prepared', entries: [] };
    const journalFile = path.join(backup, 'journal.json');
    for (const [index, [file, snapshot]] of [...snapshots.entries()].entries()) {
      snapshot.prior = snapshot.before ? path.join(backup, `${index}.original`) : null;
      if (snapshot.prior) {
        await fs.copyFile(file, snapshot.prior, fs.constants.COPYFILE_EXCL);
        await fs.chmod(snapshot.prior, 0o600);
        if (sha(await fs.readFile(snapshot.prior)) !== snapshot.before.sha256 || !same(await identity(context, file), snapshot.before)) {
          throw new PacError('PROVIDER_RACE', `Provider file changed during backup: ${file}`);
        }
      }
      journal.entries.push({ file, prior: snapshot.prior, before: snapshot.before,
        atimeMs: snapshot.times?.atimeMs, mtimeMs: snapshot.times?.mtimeMs, installed: false });
    }
    await atomicWriteFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
    const write = async (file, content) => {
      const snapshot = snapshots.get(file);
      if (!snapshot) throw new PacError('PROVIDER_WRITE_SCOPE', `Provider write is outside the selected files: ${file}`);
      if (!same(await identity(context, file), snapshot.before)) throw new PacError('PROVIDER_RACE', `Provider file changed after preflight: ${file}`);
      if (snapshot.before?.sha256 === sha(content)) return;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const staging = path.join(path.dirname(file), `.pac-provider-${crypto.randomUUID()}`);
      const entry = journal.entries.find((row) => row.file === file);
      try {
        await fs.writeFile(staging, content, { flag: 'wx', mode: 0o600 });
        await metadata(staging, snapshot.before);
        entry.after = await identity(context, staging);
        await atomicWriteFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
        if (!same(await identity(context, file), snapshot.before)) throw new PacError('PROVIDER_RACE', `Provider file changed before replacement: ${file}`);
        await fs.rename(staging, file);
        entry.installed = true;
        await atomicWriteFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
        if (!same(await identity(context, file), entry.after)) throw new PacError('PROVIDER_RACE', `Provider file changed after replacement: ${file}`);
      } finally {
        await fs.unlink(staging).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    };
    try {
      const result = await reconcileProviders(context, profile, clients, clients, 'apply', {
        names: [name], write, installRuntime: false, profileCommit: commit,
      });
      for (const entry of journal.entries) {
        if (!same(await identity(context, entry.file), entry.installed ? entry.after : entry.before)) {
          throw new PacError('PROVIDER_RACE', `Provider file changed during verification: ${entry.file}`);
        }
      }
      journal.state = 'complete';
      await atomicWriteFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
      return { mode: 'provider-only', ok: result.valid, provider: name, clients, profileCommit: commit,
        backup, changed: journal.entries.filter((entry) => entry.installed).length, providers: result.providers };
    } catch (error) {
      const failures = [];
      for (const entry of [...journal.entries].reverse().filter((row) => row.installed)) {
        try {
          if (!same(await identity(context, entry.file), entry.after)) throw new PacError('PROVIDER_RACE', `Preserving concurrent changes during rollback: ${entry.file}`);
          if (entry.prior) {
            const staging = path.join(path.dirname(entry.file), `.pac-provider-${crypto.randomUUID()}`);
            try {
              await fs.copyFile(entry.prior, staging, fs.constants.COPYFILE_EXCL);
              await metadata(staging, entry.before);
              await fs.utimes(staging, entry.atimeMs / 1000, entry.mtimeMs / 1000);
              await fs.rename(staging, entry.file);
            } finally { await fs.unlink(staging).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
          } else await fs.unlink(entry.file);
          entry.restored = true;
        } catch (failure) { failures.push({ file: entry.file, code: failure.code, message: failure.message }); }
      }
      journal.state = failures.length ? 'rollback-incomplete' : 'rolled-back';
      await atomicWriteFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
      if (failures.length) throw new PacError('PROVIDER_ROLLBACK_FAILED', 'Provider sync failed and concurrent or inaccessible files require recovery from the backup.', { backup, cause: error.message, failures });
      throw error;
    }
  });
}
