import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { installFrozen, verifyRuntimeContent } from './apm.mjs';
import { HOSTS } from './config.mjs';
import { PacError } from './errors.mjs';
import { hashDirectory } from './profile.mjs';
import { assertSafeManagedObject, assertSafeManagedPath } from './path-safety.mjs';
import { discoverApmSkills } from './state.mjs';

const TARGETS = HOSTS;

function runtimeRoot(context, profile) {
  const base = context.profileRuntimeStoreDir
    || path.join(context.home, '.local/share/personal-agent-profile-runtimes');
  const repository = profile.descriptor?.repository || profile.root;
  const key = crypto.createHash('sha256')
    .update(`${repository}\0${profile.lockedCommit}`, 'utf8')
    .digest('hex');
  return path.join(base, key);
}

function apmContext(context, profile) {
  if (!profile?.apm) return null;
  return {
    ...context,
    root: profile.root,
    manifestDir: profile.apm.manifestDir,
    manifestPath: profile.apm.manifestPath,
    lockPath: profile.apm.lockPath,
  };
}

export function profileApmProvisionalEntries(profile) {
  return (profile?.apm?.lock?.dependencies || []).map((entry) => ({
    id: entry.name,
    physicalName: entry.virtualPath ? path.posix.basename(entry.virtualPath) : entry.name,
    engine: 'profile-apm',
    targets: [...TARGETS],
  }));
}

async function installedEntries(context, profile) {
  const root = runtimeRoot(context, profile);
  const lock = profile.apm.lock;
  const discovered = await discoverApmSkills(root, lock);
  return await Promise.all(discovered.map(async (entry) => {
    const sourceRoot = path.join(root, '.agents/skills', entry.physicalName);
    return {
      name: entry.id,
      physicalName: entry.physicalName,
      path: null,
      root: sourceRoot,
      contentSha256: await hashDirectory(sourceRoot),
      targets: [...TARGETS],
      engine: 'profile-apm',
    };
  }));
}

export async function installProfileApm(context, profile) {
  if (!profile?.apm || profile.apm.dependencies.length === 0) {
    return { configured: false, valid: true, skills: [], runtimeStore: null };
  }
  if (!profile.apm.lockPath || !profile.apm.lock) {
    throw new PacError('PROFILE_APM_LOCK_MISSING', 'Profile APM dependencies are not locked.');
  }
  const root = runtimeRoot(context, profile);
  await assertSafeManagedObject(context.home, root, 'Profile APM runtime', 'directory');
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await assertSafeManagedPath(context.home, path.dirname(root), 'Profile APM runtime directory');
  await installFrozen(apmContext(context, profile), root);
  const verification = await verifyRuntimeContent(root);
  const skills = await installedEntries(context, profile);
  return {
    configured: true,
    valid: true,
    runtimeStore: root,
    dependencies: profile.apm.lock.dependencies.length,
    verification,
    skills,
  };
}

export async function profileApmStatus(context, profile) {
  if (!profile?.apm || profile.apm.dependencies.length === 0) {
    return { configured: false, valid: true, skills: [], runtimeStore: null };
  }
  const root = runtimeRoot(context, profile);
  try {
    await assertSafeManagedObject(context.home, root, 'Profile APM runtime', 'directory');
    try { await fs.lstat(root); }
    catch (error) {
      if (error.code === 'ENOENT') {
        return {
          configured: true,
          valid: false,
          state: 'missing',
          runtimeStore: root,
          dependencies: profile.apm.lock?.dependencies.length || 0,
          skills: [],
        };
      }
      throw error;
    }
    const verification = await verifyRuntimeContent(root);
    const skills = await installedEntries(context, profile);
    const expected = profileApmProvisionalEntries(profile).map(({ id }) => id).sort();
    const actual = skills.map(({ name }) => name).sort();
    return {
      configured: true,
      valid: JSON.stringify(actual) === JSON.stringify(expected),
      state: 'ready',
      runtimeStore: root,
      dependencies: expected.length,
      verification,
      skills,
    };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      state: 'invalid',
      runtimeStore: root,
      dependencies: profile.apm.lock?.dependencies.length || 0,
      skills: [],
      code: error.code || 'PROFILE_APM_INVALID',
      error: error.message,
      details: error.details,
    };
  }
}
