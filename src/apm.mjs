import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from './exec.mjs';
import { PacError } from './errors.mjs';
import { assertRealDirectory } from './path-safety.mjs';
import { atomicWriteFile } from './atomic-file.mjs';

const APM_VERSION = '0.28.0';

function unquote(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch { /* handled below */ }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

export async function readManifestDependencies(context) {
  const text = await fs.readFile(context.manifestPath, 'utf8');
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^  apm:\s*(?:\[\])?\s*$/u.test(line));
  const end = lines.findIndex((line, index) => index > start && /^  mcp:/u.test(line));
  if (start < 0 || end < 0) throw new PacError('MANIFEST_INVALID', 'APM manifest must contain dependencies.apm and dependencies.mcp.');
  const dependencies = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^    -\s+(.+)$/u);
    if (match) dependencies.push(unquote(match[1]));
    else if (line.trim() && !line.trimStart().startsWith('#')) {
      throw new PacError('MANIFEST_INVALID', 'PAC accepts scalar APM dependency entries only.', { line });
    }
  }
  return dependencies;
}

export function renderManifest(dependencies) {
  const entries = dependencies.map((entry) => `    - ${JSON.stringify(entry)}`).join('\n');
  const apm = entries ? `  apm:\n${entries}` : '  apm: []';
  return `name: personal-agent-control-skills
version: 1.0.0
description: Standalone Skills managed by Personal Agent Control
author: Personal Agent Control
targets:
  - agent-skills
dependencies:
${apm}
  mcp: []
includes: auto
scripts: {}
`;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === 'null') return null;
  return unquote(trimmed);
}

export async function readLock(context, file = context.lockPath) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { throw new PacError('LOCK_MISSING', `Cannot read APM lockfile ${file}: ${error.message}`); }
  const version = text.match(/^apm_version:\s*['"]?([^'"\s]+)['"]?\s*$/mu)?.[1];
  const dependencySection = text.split(/^deployments:\s*$/mu)[0];
  const blocks = dependencySection.split(/^-(?=\s+repo_url:)/mu).slice(1);
  const dependencies = blocks.map((block) => {
    const field = (name) => {
      const match = block.match(new RegExp(`^\\s{1,2}${name}:\\s*(.+)$`, 'mu'));
      return match ? parseScalar(match[1]) : null;
    };
    return {
      repoUrl: field('repo_url'),
      name: field('name'),
      host: field('host'),
      port: field('port'),
      resolvedCommit: field('resolved_commit'),
      virtualPath: field('virtual_path'),
      localPath: field('local_path'),
      contentHash: field('content_hash'),
    };
  }).filter((entry) => entry.name);
  if (dependencies.length === 0) throw new PacError('LOCK_INVALID', `No Skill dependencies found in ${file}.`);
  return { version, dependencies, text };
}

export function dependencyForName(lock, name) {
  const entry = lock.dependencies.find((dependency) => dependency.name === name);
  if (!entry) throw new PacError('SKILL_UNKNOWN', `No locked Skill named ${name}.`);
  if (entry.localPath) return entry.localPath;
  return `${entry.repoUrl}${entry.virtualPath ? `/${entry.virtualPath}` : ''}${entry.resolvedCommit ? `#${entry.resolvedCommit}` : ''}`;
}

async function copyIfExists(source, target) {
  try { await fs.copyFile(source, target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function withManifestStage(context, callback) {
  await fs.mkdir(context.stateDir, { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(context.stateDir, 'manifest-stage-'));
  const stageRoot = path.join(stage, 'repo');
  const stageManifestDir = path.join(stageRoot, 'packages/skills');
  await fs.mkdir(stageManifestDir, { recursive: true });
  await fs.symlink(path.join(context.root, 'payload'), path.join(stageRoot, 'payload'), 'dir');
  await fs.copyFile(context.manifestPath, path.join(stageManifestDir, 'apm.yml'));
  await copyIfExists(context.lockPath, path.join(stageManifestDir, 'apm.lock.yaml'));
  try {
    return await callback({ stage, manifestDir: stageManifestDir });
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function replaceFile(source, target) {
  const [content, stat] = await Promise.all([fs.readFile(source), fs.stat(source)]);
  await atomicWriteFile(target, content, stat.mode & 0o777);
}

async function stagedSkillNames(manifestDir) {
  const modules = path.join(manifestDir, 'apm_modules');
  const names = new Map();
  async function collect(directory) {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) await collect(absolute);
      else if (child.isFile() && child.name === 'SKILL.md') {
        const text = await fs.readFile(absolute, 'utf8');
        const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u)?.[1];
        const name = frontmatter?.match(/^name:\s*['"]?([^'"\s]+)['"]?\s*$/mu)?.[1];
        if (!name || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)) {
          throw new PacError('SKILL_INVALID', `Staged Skill has an invalid frontmatter name: ${absolute}`);
        }
        if (names.has(name)) {
          throw new PacError('SKILL_DUPLICATE_NAME', `Multiple staged Skills declare ${name}.`, {
            first: names.get(name), second: absolute,
          });
        }
        names.set(name, absolute);
      }
    }
  }
  try { await collect(modules); }
  catch (error) {
    if (error.code === 'ENOENT') throw new PacError('APM_STAGE_INVALID', `APM did not materialize staged modules: ${modules}`);
    throw error;
  }
  if (names.size === 0) throw new PacError('APM_STAGE_INVALID', 'APM staged no Skill frontmatter identities.');
  return [...names.keys()].sort();
}

export async function stageDependencies(context, dependencies, options = {}) {
  const unique = [...new Set(dependencies)];
  if (unique.length !== dependencies.length) throw new PacError('SKILL_DUPLICATE', 'The Skill dependency list contains duplicates.');
  for (const dependency of unique) {
    if (!dependency || /[\r\n\0]/u.test(dependency) || dependency.startsWith('-')) {
      throw new PacError('SKILL_REFERENCE_INVALID', `Unsafe APM dependency reference: ${JSON.stringify(dependency)}`);
    }
  }

  if (unique.length === 0) {
    await atomicWriteFile(context.manifestPath, renderManifest([]), 0o600);
    try { await fs.unlink(context.lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { version: APM_VERSION, dependencies: [], text: '', skillNames: [] };
  }

  return await withManifestStage(context, async ({ manifestDir }) => {
    await fs.writeFile(path.join(manifestDir, 'apm.yml'), renderManifest(unique), { mode: 0o600 });
    const args = options.update
      ? ['update', ...(options.package ? [options.package] : []), '--yes', '--target', 'agent-skills']
      : ['lock', '--target', 'agent-skills'];
    await run(context.apm, args, { cwd: manifestDir, errorCode: 'APM_LOCK_FAILED' });
    const stagedLock = path.join(manifestDir, 'apm.lock.yaml');
    const parsed = await readLock(context, stagedLock);
    if (parsed.version !== APM_VERSION) {
      throw new PacError('APM_VERSION_MISMATCH', `Lockfile was generated by APM ${parsed.version}; expected ${APM_VERSION}.`);
    }
    const skillNames = await stagedSkillNames(manifestDir);
    await replaceFile(path.join(manifestDir, 'apm.yml'), context.manifestPath);
    await replaceFile(stagedLock, context.lockPath);
    return { ...parsed, skillNames };
  });
}

export async function apmVersion(context) {
  const { stdout, stderr } = await run(context.apm, ['--version'], { errorCode: 'APM_UNAVAILABLE' });
  const output = `${stdout}\n${stderr}`.trim();
  const version = output.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  return { expected: APM_VERSION, actual: version, output, matches: version === APM_VERSION };
}

export async function installFrozen(context, neutralStore) {
  const version = await apmVersion(context);
  if (!version.matches) {
    throw new PacError('APM_VERSION_MISMATCH', `PAC requires APM ${APM_VERSION}; found ${version.actual || version.output}.`);
  }
  const lock = await readLock(context);
  if (lock.version !== APM_VERSION) {
    throw new PacError('APM_VERSION_MISMATCH', `Canonical lockfile uses APM ${lock.version}; expected ${APM_VERSION}.`);
  }
  await fs.mkdir(neutralStore, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(neutralStore);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('STORE_UNSAFE', `Neutral Skill store must be a real directory: ${neutralStore}`);
  }
  await run(context.apm, ['install', '--frozen', '--root', neutralStore, '--target', 'agent-skills'], {
    cwd: context.manifestDir,
    errorCode: 'APM_APPLY_FAILED',
  });
  return lock;
}

export async function verifyRuntimeContent(neutralStore, allowedPhysicalNames = []) {
  const lockPath = path.join(neutralStore, 'apm.lock.yaml');
  await assertRealDirectory(neutralStore, 'neutral Skill store');
  await assertRealDirectory(path.join(neutralStore, '.agents'), 'APM deployment directory');
  await assertRealDirectory(path.join(neutralStore, '.agents/skills'), 'APM Skill root');
  const lockStat = await fs.lstat(lockPath).catch((error) => {
    if (error.code === 'ENOENT') throw new PacError('RUNTIME_LOCK_INVALID', `Runtime APM lock is missing: ${lockPath}`);
    throw error;
  });
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    throw new PacError('RUNTIME_LOCK_UNSAFE', `Runtime APM lock must be a regular file: ${lockPath}`);
  }
  const text = await fs.readFile(lockPath, 'utf8');
  const expected = new Map();
  for (const match of text.matchAll(/^    (\.agents\/skills\/[^:\r\n]+): sha256:([0-9a-f]{64})\s*$/gmu)) {
    const relative = match[1];
    if (path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new PacError('RUNTIME_LOCK_UNSAFE', `Unsafe deployed path in runtime APM lock: ${relative}`);
    }
    expected.set(relative, match[2]);
  }
  if (expected.size === 0) throw new PacError('RUNTIME_LOCK_INVALID', `Runtime APM lock has no deployed file hashes: ${lockPath}`);
  const roots = new Set([...expected.keys()].map((relative) => relative.split('/').slice(0, 3).join('/')));
  const allowedRoots = new Set([
    ...roots,
    ...allowedPhysicalNames.map((name) => `.agents/skills/${name}`),
  ]);
  const skillRoot = path.join(neutralStore, '.agents/skills');
  let rootEntries;
  try { rootEntries = await fs.readdir(skillRoot, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') throw new PacError('MANAGED_DRIFT', `Managed APM Skill root is missing: ${skillRoot}`);
    throw error;
  }
  const unsafeRoots = rootEntries.filter((entry) => !entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => `.agents/skills/${entry.name}`);
  if (unsafeRoots.length) {
    throw new PacError('MANAGED_DRIFT', 'Managed Skill roots must be real directories.', {
      unsafeRoots: unsafeRoots.sort(),
    });
  }
  const unexpectedRoots = rootEntries
    .map((entry) => `.agents/skills/${entry.name}`)
    .filter((relative) => !allowedRoots.has(relative));
  if (unexpectedRoots.length) {
    throw new PacError('MANAGED_DRIFT', 'Managed Skill store contains roots absent from the runtime lock.', {
      unexpectedRoots: unexpectedRoots.sort(),
    });
  }
  const actual = new Set();
  async function collect(absolute, relative) {
    const children = await fs.readdir(absolute, { withFileTypes: true });
    for (const child of children) {
      const childAbsolute = path.join(absolute, child.name);
      const childRelative = `${relative}/${child.name}`;
      if (child.isDirectory()) await collect(childAbsolute, childRelative);
      else if (child.isFile()) actual.add(childRelative);
      else throw new PacError('MANAGED_DRIFT', `Managed APM content contains an unsupported entry: ${childRelative}`);
    }
  }
  for (const root of roots) {
    const absoluteRoot = path.join(neutralStore, ...root.split('/'));
    try {
      await assertRealDirectory(absoluteRoot, `managed APM Skill ${root}`);
      await collect(absoluteRoot, root);
    }
    catch (error) {
      if (error.code === 'ENOENT') throw new PacError('MANAGED_DRIFT', `Managed APM Skill is missing: ${root}`);
      throw error;
    }
  }
  const missing = [...expected.keys()].filter((relative) => !actual.has(relative));
  const added = [...actual].filter((relative) => !expected.has(relative));
  if (missing.length || added.length) {
    throw new PacError('MANAGED_DRIFT', 'Managed APM file inventory differs from the runtime lock.', { missing, added });
  }
  for (const [relative, digest] of expected) {
    const content = await fs.readFile(path.join(neutralStore, ...relative.split('/')));
    const actualDigest = crypto.createHash('sha256').update(content).digest('hex');
    if (actualDigest !== digest) {
      throw new PacError('MANAGED_DRIFT', `Managed APM file differs from the runtime lock: ${relative}`, {
        relative, expected: digest, actual: actualDigest,
      });
    }
  }
  return { files: expected.size, roots: roots.size };
}

export { APM_VERSION };
