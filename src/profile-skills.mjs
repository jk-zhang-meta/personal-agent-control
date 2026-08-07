import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PacError } from './errors.mjs';
import { hashDirectory } from './profile.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';

function physicalRoot(neutralStore) {
  return path.join(neutralStore, '.agents/skills');
}

export function profileSkillEntries(profile) {
  return (profile?.skills || []).map((skill) => ({
    id: skill.name,
    physicalName: skill.physicalName || skill.name,
    engine: skill.engine || 'profile',
    contentSha256: skill.contentSha256,
    sourceRoot: skill.root,
    targets: [...skill.targets],
  }));
}

async function existingStatus(neutralStore, entry) {
  const target = path.join(physicalRoot(neutralStore), entry.physicalName);
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...entry, installed: false, valid: false, actualSha256: null };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ...entry, installed: true, valid: false, actualSha256: null, unsafe: true };
  }
  const actualSha256 = await hashDirectory(target);
  return {
    ...entry,
    installed: true,
    valid: actualSha256 === entry.contentSha256,
    actualSha256,
  };
}

export async function profileSkillStatus(neutralStore, profile) {
  return await Promise.all(profileSkillEntries(profile).map((entry) => existingStatus(neutralStore, entry)));
}

export async function applyProfileSkills(context, neutralStore, profile, ownedMap = new Map()) {
  const root = physicalRoot(neutralStore);
  await assertSafeManagedObject(context.home, root, 'Profile Skill store', 'directory');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const results = [];

  for (const entry of profileSkillEntries(profile)) {
    const current = await existingStatus(neutralStore, entry);
    if (current.valid) {
      results.push(current);
      continue;
    }
    const target = path.join(root, entry.physicalName);
    if (current.installed && !ownedMap.has(entry.id)) {
      throw new PacError('SKILL_COLLISION', `Unmanaged Skill blocks Profile Skill ${entry.id}: ${target}`);
    }

    const token = crypto.randomUUID();
    const staging = path.join(root, `.profile-${entry.physicalName}.new-${token}`);
    const prior = path.join(root, `.profile-${entry.physicalName}.old-${token}`);
    try {
      await fs.cp(entry.sourceRoot, staging, {
        recursive: true,
        dereference: false,
        preserveTimestamps: false,
        errorOnExist: true,
        force: false,
      });
      const stagedDigest = await hashDirectory(staging);
      if (stagedDigest !== entry.contentSha256) {
        throw new PacError('PROFILE_DIGEST_MISMATCH', `Staged Profile Skill ${entry.id} differs from its manifest digest.`);
      }
      if (current.installed) await fs.rename(target, prior);
      try {
        await fs.rename(staging, target);
      } catch (error) {
        if (current.installed) await fs.rename(prior, target);
        throw error;
      }
      if (current.installed) await fs.rm(prior, { recursive: true, force: true });
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(prior, { recursive: true, force: true });
    }
    const installed = await existingStatus(neutralStore, entry);
    if (!installed.valid) {
      throw new PacError('PROFILE_DIGEST_MISMATCH', `Installed Profile Skill ${entry.id} differs from its manifest digest.`, installed);
    }
    results.push(installed);
  }
  return results;
}

export async function retireProfileSkills(context, neutralStore, priorOwnedMap, desiredSkills) {
  const desiredPhysical = new Set(desiredSkills.map(({ physicalName }) => physicalName));
  const retired = [];
  for (const [id, mapping] of priorOwnedMap) {
    if (!['profile', 'profile-apm'].includes(mapping.engine)
        || desiredPhysical.has(mapping.physicalName)) continue;
    const target = path.join(physicalRoot(neutralStore), mapping.physicalName);
    await assertSafeManagedObject(context.home, target, `retired Profile Skill ${id}`, 'directory');
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PacError('SKILL_UNSAFE', `Retired Profile Skill must be a real directory: ${target}`);
    }
    await fs.rm(target, { recursive: true });
    retired.push(id);
  }
  return retired.sort();
}
