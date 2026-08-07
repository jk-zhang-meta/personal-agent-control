import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject, assertSafeManagedPath } from './path-safety.mjs';

function targetPath(context) {
  return context.profileBootstrapPath
    || path.join(context.home, '.config/personal-agent-control/profile-bootstrap.md');
}

function ownershipPath(context) {
  return context.profileBootstrapOwnershipPath
    || path.join(context.stateDir, 'profile-bootstrap.json');
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function readFileOrNull(file) {
  try { return await fs.readFile(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readOwnership(context) {
  const file = ownershipPath(context);
  await assertSafeManagedObject(context.home, file, 'Profile bootstrap ownership', 'file');
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new PacError('PROFILE_BOOTSTRAP_OWNERSHIP_INVALID', `Cannot read Profile bootstrap ownership: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || parsed.schemaVersion !== 1
      || Object.keys(parsed).sort().join(',') !== 'schemaVersion,sha256'
      || typeof parsed.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(parsed.sha256)) {
    throw new PacError('PROFILE_BOOTSTRAP_OWNERSHIP_INVALID', 'Profile bootstrap ownership is invalid.');
  }
  return parsed;
}

async function inspect(context) {
  const target = targetPath(context);
  await assertSafeManagedObject(context.home, target, 'Profile bootstrap', 'file');
  const [content, ownership] = await Promise.all([readFileOrNull(target), readOwnership(context)]);
  const actualSha256 = content === null ? null : digest(content);
  return {
    target,
    exists: content !== null,
    owned: ownership !== null,
    actualSha256,
    ownedSha256: ownership?.sha256 || null,
    valid: ownership === null ? content === null : actualSha256 === ownership.sha256,
  };
}

export async function profileBootstrapStatus(context, profile) {
  const current = await inspect(context);
  let expectedSha256 = null;
  if (profile?.bootstrap) expectedSha256 = digest(await fs.readFile(profile.bootstrap));
  const expected = expectedSha256 === null ? 'missing' : 'managed';
  return {
    ...current,
    expected,
    expectedSha256,
    valid: expectedSha256 === null
      ? (!current.exists && !current.owned)
      : current.valid && current.ownedSha256 === expectedSha256,
  };
}

export async function reconcileProfileBootstrap(context, profile) {
  const current = await inspect(context);
  const target = targetPath(context);
  const ownerFile = ownershipPath(context);
  if (!current.valid && current.exists) {
    if (current.exists && !current.owned) {
      throw new PacError('PROFILE_BOOTSTRAP_COLLISION', `Unmanaged file blocks Profile bootstrap: ${target}`);
    }
    throw new PacError(
      'PROFILE_BOOTSTRAP_DRIFT',
      `Managed Profile bootstrap was modified outside PAC: ${target}`,
      current,
    );
  }

  if (!profile?.bootstrap) {
    if (current.exists && !current.owned) {
      throw new PacError('PROFILE_BOOTSTRAP_COLLISION', `Unmanaged file blocks Profile bootstrap: ${target}`);
    }
    if (current.exists) await fs.unlink(target);
    if (current.owned) await fs.unlink(ownerFile);
    return { action: current.owned ? 'removed' : 'absent', target, sha256: null };
  }

  const content = await fs.readFile(profile.bootstrap);
  const sha256 = digest(content);
  if (current.exists && !current.owned) {
    throw new PacError('PROFILE_BOOTSTRAP_COLLISION', `Unmanaged file blocks Profile bootstrap: ${target}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(ownerFile), { recursive: true, mode: 0o700 });
  await Promise.all([
    assertSafeManagedPath(context.home, path.dirname(target), 'Profile bootstrap directory'),
    assertSafeManagedPath(context.home, path.dirname(ownerFile), 'Profile bootstrap ownership directory'),
  ]);
  await atomicWriteFile(target, content, 0o600);
  await atomicWriteFile(
    ownerFile,
    `${JSON.stringify({ schemaVersion: 1, sha256 }, null, 2)}\n`,
    0o600,
  );
  const installed = await inspect(context);
  if (!installed.valid || installed.actualSha256 !== sha256) {
    throw new PacError('PROFILE_BOOTSTRAP_INVALID', 'Profile bootstrap was not installed exactly.', installed);
  }
  return { action: current.exists ? 'updated' : 'installed', target, sha256 };
}
