import fs from 'node:fs/promises';
import path from 'node:path';
import { PacError } from './errors.mjs';

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function assertRealHome(home) {
  const absolute = path.resolve(home);
  if (absolute === path.parse(absolute).root) {
    throw new PacError('UNSAFE_HOME', `Refusing to use filesystem root as HOME: ${absolute}`);
  }
  let actual;
  try { actual = await fs.realpath(absolute); }
  catch (error) { throw new PacError('UNSAFE_HOME', `HOME must be an existing real directory: ${absolute}`, { cause: error.message }); }
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || actual !== absolute) {
    throw new PacError('UNSAFE_HOME', `HOME must not contain a symlinked path component: ${absolute}`, { actual });
  }
}

export async function assertSafeManagedObject(home, target, label, finalType = 'any') {
  if (!['any', 'directory', 'file'].includes(finalType)) {
    throw new PacError('PATH_UNSAFE', `Unsupported managed object type: ${finalType}`);
  }
  const trusted = path.resolve(home);
  const absolute = path.resolve(target);
  await assertRealHome(trusted);
  if (!inside(trusted, absolute)) {
    throw new PacError('PATH_UNSAFE', `${label} must be below HOME: ${absolute}`);
  }
  const relative = path.relative(trusted, absolute);
  let current = trusted;
  const components = relative.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const ancestor = index < components.length - 1;
    if (ancestor && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new PacError('PATH_UNSAFE', `${label} has a symlink or non-directory component: ${current}`);
    }
    if (!ancestor && finalType === 'directory' && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new PacError('PATH_UNSAFE', `${label} must be a real directory: ${current}`);
    }
    if (!ancestor && finalType === 'file' && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new PacError('PATH_UNSAFE', `${label} must be a regular file: ${current}`);
    }
  }
}

export async function assertSafeManagedPath(home, target, label) {
  await assertSafeManagedObject(home, target, label, 'directory');
}

export async function assertRealDirectory(directory, label) {
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) {
    if (error.code === 'ENOENT') throw new PacError('PATH_UNSAFE', `${label} is missing: ${directory}`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PATH_UNSAFE', `${label} must be a real directory: ${directory}`);
  }
}
