import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { readLock, readManifestDependencies } from './apm.mjs';
import { PacError } from './errors.mjs';
import { run } from './exec.mjs';
import { assertSafeManagedObject, assertSafeManagedPath } from './path-safety.mjs';

const DESCRIPTOR_KEYS = ['lockedCommit', 'ref', 'repository', 'schemaVersion'];
const MANIFEST_KEYS_V1 = ['plugins', 'schemaVersion', 'skills'];
const MANIFEST_KEYS_V2 = ['bootstrap', 'plugins', 'schemaVersion', 'skills'];
const SKILL_KEYS = ['contentSha256', 'name', 'path', 'targets'];
const PLUGIN_KEYS_V1 = ['enabled'];
const PLUGIN_KEYS_V2 = ['disabled', 'enabled'];
const CATALOG_FILES = new Set(['capabilities.jsonl', 'plugins.tsv']);
const PROFILE_DIRECTORIES = new Set(['catalog', 'context', 'packages', 'skills']);
const PROFILE_METADATA_FILES = new Set(['LICENSE', 'LICENSE.md', 'README.md']);
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/iu;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const PROFILE_HOSTS = ['codex', 'claude'];

function profileConfigPath(context) {
  return context.profileConfigPath
    || path.join(context.home, '.config/personal-agent-control/profile.json');
}

function profileStoreDir(context) {
  return context.profileStoreDir
    || path.join(context.home, '.local/share/personal-agent-profiles');
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PacError(code, `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PacError(code, `${label} must contain exactly: ${expected.join(', ')}.`);
  }
}

function normalizeCommit(value, code, label) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw new PacError(code, `${label} must be a full 40- or 64-character hexadecimal commit.`);
  }
  return value.toLowerCase();
}

function validateRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new PacError('PROFILE_REF_INVALID', 'Profile ref is empty or unsafe.');
  }

  if (COMMIT_PATTERN.test(value)) return value.toLowerCase();

  const components = value.split('/');
  const invalid = !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('//')
    || value.includes('..')
    || components.some((component) => component.startsWith('.')
      || component.endsWith('.lock'));
  if (invalid) {
    throw new PacError(
      'PROFILE_REF_INVALID',
      'Profile ref must be a full commit or one safe Git ref name.',
    );
  }

  return value;
}

function validateRepository(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PacError('PROFILE_REPOSITORY_INVALID', 'Profile repository locator is empty or unsafe.');
  }
  if (path.isAbsolute(value)) return path.normalize(value);
  if (/^git@[^\s/:]+:[^\s]+$/u.test(value)) {
    if (/[?#]/u.test(value)) {
      throw new PacError(
        'PROFILE_REPOSITORY_INVALID',
        'Profile repository locators may not contain a query or fragment.',
      );
    }
    return value;
  }
  let url;
  try { url = new URL(value); }
  catch {
    throw new PacError(
      'PROFILE_REPOSITORY_INVALID',
      'Profile repository must use HTTPS, SSH, git@host:path, or an absolute local path.',
    );
  }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password
      || url.search || url.hash
      || (url.protocol === 'https:' && url.username)) {
    throw new PacError(
      'PROFILE_REPOSITORY_INVALID',
      'Profile repository must use credential-free HTTPS or SSH.',
    );
  }
  return value;
}

function validateDescriptor(value) {
  exactObject(value, DESCRIPTOR_KEYS, 'PROFILE_DESCRIPTOR_INVALID', 'profile.json');
  if (value.schemaVersion !== 1) {
    throw new PacError('PROFILE_DESCRIPTOR_INVALID', 'profile.json must use schemaVersion 1.');
  }
  return {
    schemaVersion: 1,
    repository: validateRepository(value.repository),
    ref: validateRef(value.ref),
    lockedCommit: normalizeCommit(
      value.lockedCommit,
      'PROFILE_DESCRIPTOR_INVALID',
      'profile.json lockedCommit',
    ),
  };
}

async function lstatOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function requireRegularFile(target, label) {
  const stat = await lstatOrNull(target);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new PacError('PROFILE_CONTENT_INVALID', `${label} must be a regular file.`);
  }
  return stat;
}

async function requireRealDirectory(target, label) {
  const stat = await lstatOrNull(target);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PROFILE_CONTENT_INVALID', `${label} must be a real directory.`);
  }
}

async function regularFiles(root, label) {
  await requireRealDirectory(root, label);
  const files = [];

  async function walk(directory, prefix) {
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new PacError('PROFILE_CONTENT_INVALID', `${label} contains a symbolic link: ${relative}`);
      }
      if (stat.isDirectory()) {
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        files.push({ absolute, relative });
      } else {
        throw new PacError('PROFILE_CONTENT_INVALID', `${label} contains a special file: ${relative}`);
      }
    }
  }

  await walk(root, '');
  return files;
}

async function validateRootContract(root) {
  await requireRealDirectory(root, 'Profile checkout');
  const metadata = [];

  for (const name of (await fs.readdir(root)).sort()) {
    const target = path.join(root, name);
    const stat = await fs.lstat(target);

    if (name === '.git') {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new PacError(
          'PROFILE_CONTENT_INVALID',
          'Profile .git infrastructure must be a real directory.',
        );
      }
      continue;
    }

    if (name === 'pac-profile.json' || name === 'bootstrap.md' || PROFILE_METADATA_FILES.has(name)) {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new PacError(
          'PROFILE_CONTENT_INVALID',
          `Profile root ${name} must be a regular file.`,
        );
      }
      if (PROFILE_METADATA_FILES.has(name)) metadata.push(name);
      continue;
    }

    if (PROFILE_DIRECTORIES.has(name)) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new PacError(
          'PROFILE_CONTENT_INVALID',
          `Profile root ${name}/ must be a real directory.`,
        );
      }
      continue;
    }

    throw new PacError(
      'PROFILE_CONTENT_INVALID',
      `Unsupported Profile root entry: ${name}`,
    );
  }

  return metadata;
}

export async function hashDirectory(root) {
  const files = await regularFiles(path.resolve(root), `Profile tree ${root}`);
  const digest = crypto.createHash('sha256');
  digest.update('PAC-DIRECTORY-SHA256-v1\0');
  for (const file of files) {
    const content = await fs.readFile(file.absolute);
    digest.update(file.relative, 'utf8');
    digest.update('\0');
    digest.update(String(content.length), 'utf8');
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function readManifest(root) {
  const manifestPath = path.join(root, 'pac-profile.json');
  await requireRegularFile(manifestPath, 'pac-profile.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (error) {
    throw new PacError('PROFILE_MANIFEST_INVALID', `Cannot parse pac-profile.json: ${error.message}`);
  }
  if (manifest.schemaVersion === 1) {
    exactObject(manifest, MANIFEST_KEYS_V1, 'PROFILE_MANIFEST_INVALID', 'pac-profile.json');
  } else if (manifest.schemaVersion === 2) {
    exactObject(manifest, MANIFEST_KEYS_V2, 'PROFILE_MANIFEST_INVALID', 'pac-profile.json');
  } else {
    throw new PacError(
      'PROFILE_MANIFEST_INVALID',
      'pac-profile.json must use schemaVersion 1 or 2.',
    );
  }
  if (!Array.isArray(manifest.skills)) {
    throw new PacError('PROFILE_MANIFEST_INVALID', 'pac-profile.json must declare a skills array.');
  }
  const bootstrap = manifest.schemaVersion === 2 ? manifest.bootstrap : null;
  if (bootstrap !== null && bootstrap !== 'bootstrap.md') {
    throw new PacError(
      'PROFILE_MANIFEST_INVALID',
      'pac-profile.json bootstrap must be bootstrap.md.',
    );
  }
  exactObject(
    manifest.plugins,
    manifest.schemaVersion === 2 ? PLUGIN_KEYS_V2 : PLUGIN_KEYS_V1,
    'PROFILE_MANIFEST_INVALID',
    'pac-profile.json plugins',
  );
  if (!Array.isArray(manifest.plugins.enabled)
      || manifest.plugins.enabled.some((name) => typeof name !== 'string'
        || !PLUGIN_NAME_PATTERN.test(name))
      || new Set(manifest.plugins.enabled).size !== manifest.plugins.enabled.length) {
    throw new PacError(
      'PROFILE_MANIFEST_INVALID',
      'pac-profile.json plugins.enabled must contain unique Plugin names.',
    );
  }
  const disabledPlugins = manifest.schemaVersion === 2 ? manifest.plugins.disabled : [];
  if (!Array.isArray(disabledPlugins)
      || disabledPlugins.some((name) => typeof name !== 'string'
        || !PLUGIN_NAME_PATTERN.test(name))
      || new Set(disabledPlugins).size !== disabledPlugins.length
      || disabledPlugins.some((name) => manifest.plugins.enabled.includes(name))) {
    throw new PacError(
      'PROFILE_MANIFEST_INVALID',
      'pac-profile.json plugins.disabled must contain unique names disjoint from plugins.enabled.',
    );
  }

  const names = new Set();
  const normalizedSkills = [];
  for (const [index, skill] of manifest.skills.entries()) {
    exactObject(skill, SKILL_KEYS, 'PROFILE_MANIFEST_INVALID', `skills[${index}]`);
    if (typeof skill.name !== 'string' || !SKILL_NAME_PATTERN.test(skill.name)) {
      throw new PacError('PROFILE_MANIFEST_INVALID', `skills[${index}].name must be kebab-case.`);
    }
    if (names.has(skill.name)) {
      throw new PacError('PROFILE_MANIFEST_INVALID', `Duplicate Profile Skill name: ${skill.name}`);
    }
    names.add(skill.name);
    if (skill.path !== `skills/${skill.name}`) {
      throw new PacError(
        'PROFILE_MANIFEST_INVALID',
        `Profile Skill ${skill.name} path must be skills/${skill.name}.`,
      );
    }
    if (typeof skill.contentSha256 !== 'string' || !DIGEST_PATTERN.test(skill.contentSha256)) {
      throw new PacError(
        'PROFILE_MANIFEST_INVALID',
        `Profile Skill ${skill.name} contentSha256 must be a 64-character hexadecimal digest.`,
      );
    }
    if (!Array.isArray(skill.targets) || skill.targets.length === 0
        || new Set(skill.targets).size !== skill.targets.length
        || skill.targets.some((target) => !PROFILE_HOSTS.includes(target))) {
      throw new PacError(
        'PROFILE_MANIFEST_INVALID',
        `Profile Skill ${skill.name} targets must contain unique values from: ${PROFILE_HOSTS.join(', ')}.`,
      );
    }
    normalizedSkills.push({
      name: skill.name,
      path: skill.path,
      contentSha256: skill.contentSha256.toLowerCase(),
      targets: PROFILE_HOSTS.filter((target) => skill.targets.includes(target)),
    });
  }
  return {
    schemaVersion: manifest.schemaVersion,
    bootstrap,
    skills: normalizedSkills,
    plugins: {
      enabled: [...manifest.plugins.enabled],
      disabled: [...disabledPlugins],
    },
  };
}

async function validateContext(root) {
  const contextRoot = path.join(root, 'context');
  const stat = await lstatOrNull(contextRoot);
  if (!stat) return { root: null, files: [] };
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PROFILE_CONTENT_INVALID', 'Profile context/ must be a real directory.');
  }
  const files = await regularFiles(contextRoot, 'Profile context');
  const invalid = files.find(({ relative }) => !relative.endsWith('.md'));
  if (invalid) {
    throw new PacError(
      'PROFILE_CONTENT_INVALID',
      `Profile context modules must be Markdown files: context/${invalid.relative}`,
    );
  }
  return { root: contextRoot, files };
}

async function validatePackages(root) {
  const packagesRoot = path.join(root, 'packages');
  const stat = await lstatOrNull(packagesRoot);
  if (!stat) return { manifestPath: null, lockPath: null, files: [] };
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PROFILE_CONTENT_INVALID', 'Profile packages/ must be a real directory.');
  }
  const rootEntries = await fs.readdir(packagesRoot);
  if (rootEntries.length !== 1 || rootEntries[0] !== 'skills') {
    throw new PacError(
      'PROFILE_CONTENT_INVALID',
      'Profile packages/ may contain only packages/skills/.',
    );
  }
  const skillsRoot = path.join(packagesRoot, 'skills');
  await requireRealDirectory(skillsRoot, 'Profile packages/skills');
  const names = (await fs.readdir(skillsRoot)).sort();
  const allowed = new Set(['apm.lock.yaml', 'apm.yml']);
  const invalid = names.find((name) => !allowed.has(name));
  if (invalid) {
    throw new PacError(
      'PROFILE_CONTENT_INVALID',
      `Unsupported Profile package file: packages/skills/${invalid}`,
    );
  }
  if (!names.includes('apm.yml')) {
    throw new PacError('PROFILE_CONTENT_INVALID', 'Profile packages/skills/apm.yml is required.');
  }
  for (const name of names) {
    await requireRegularFile(path.join(skillsRoot, name), `Profile packages/skills/${name}`);
  }
  return {
    manifestPath: path.join(skillsRoot, 'apm.yml'),
    lockPath: names.includes('apm.lock.yaml') ? path.join(skillsRoot, 'apm.lock.yaml') : null,
    files: names.map((name) => `packages/skills/${name}`),
  };
}

async function validateCatalog(root) {
  const catalogRoot = path.join(root, 'catalog');
  const stat = await lstatOrNull(catalogRoot);
  const result = { pluginsPath: null, capabilitiesPath: null };
  if (!stat) return result;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PROFILE_CONTENT_INVALID', 'Profile catalog must be a real directory.');
  }
  for (const name of (await fs.readdir(catalogRoot)).sort()) {
    if (!CATALOG_FILES.has(name)) {
      throw new PacError('PROFILE_CONTENT_INVALID', `Unsupported Profile catalog file: ${name}`);
    }
    const target = path.join(catalogRoot, name);
    await requireRegularFile(target, `Profile catalog/${name}`);
    if (name === 'plugins.tsv') result.pluginsPath = target;
    if (name === 'capabilities.jsonl') result.capabilitiesPath = target;
  }
  return result;
}

async function validateProfileTree(root) {
  const metadata = await validateRootContract(root);
  const manifest = await readManifest(root);
  const skillsRoot = path.join(root, 'skills');
  const skillsStat = await lstatOrNull(skillsRoot);
  if (manifest.skills.length > 0 || skillsStat) {
    await requireRealDirectory(skillsRoot, 'Profile skills directory');
    const entries = (await fs.readdir(skillsRoot)).sort();
    const declared = manifest.skills.map(({ name }) => name).sort();
    if (entries.length !== declared.length || entries.some((name, index) => name !== declared[index])) {
      throw new PacError(
        'PROFILE_CONTENT_INVALID',
        'Profile skills directory must contain exactly the Skills declared by pac-profile.json.',
      );
    }
  }

  const effectiveSkills = [];
  for (const skill of manifest.skills) {
    const skillRoot = path.join(root, ...skill.path.split('/'));
    await requireRealDirectory(skillRoot, `Profile Skill ${skill.name}`);
    await requireRegularFile(path.join(skillRoot, 'SKILL.md'), `Profile Skill ${skill.name}/SKILL.md`);
    const skillText = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const frontmatter = skillText.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u)?.[1];
    const frontmatterName = frontmatter?.match(/^name:\s*['"]?([^'"\s]+)['"]?\s*$/mu)?.[1];
    if (frontmatterName !== skill.name) {
      throw new PacError(
        'PROFILE_MANIFEST_INVALID',
        `Profile Skill ${skill.name} must declare the same frontmatter name in SKILL.md.`,
      );
    }
    const actual = await hashDirectory(skillRoot);
    if (actual !== skill.contentSha256) {
      throw new PacError(
        'PROFILE_DIGEST_MISMATCH',
        `Profile Skill ${skill.name} does not match contentSha256.`,
        { expected: skill.contentSha256, actual },
      );
    }
    effectiveSkills.push({ ...skill, root: skillRoot });
  }

  let bootstrapPath = null;
  if (manifest.bootstrap) {
    bootstrapPath = path.join(root, manifest.bootstrap);
    await requireRegularFile(bootstrapPath, 'Profile bootstrap');
  } else if (await lstatOrNull(path.join(root, 'bootstrap.md'))) {
    throw new PacError(
      'PROFILE_CONTENT_INVALID',
      'bootstrap.md exists but pac-profile.json does not declare it.',
    );
  }
  const context = await validateContext(root);
  const packages = await validatePackages(root);
  let apm = null;
  if (packages.manifestPath) {
    const apmContext = {
      root,
      manifestDir: path.dirname(packages.manifestPath),
      manifestPath: packages.manifestPath,
      lockPath: packages.lockPath,
    };
    const dependencies = await readManifestDependencies(apmContext);
    if (dependencies.length > 0 && !packages.lockPath) {
      throw new PacError(
        'PROFILE_CONTENT_INVALID',
        'Profile APM dependencies require packages/skills/apm.lock.yaml.',
      );
    }
    if (dependencies.length === 0 && packages.lockPath) {
      throw new PacError(
        'PROFILE_CONTENT_INVALID',
        'Profile APM lockfile must be absent when no dependencies are declared.',
      );
    }
    const lock = packages.lockPath ? await readLock(apmContext) : null;
    const localDependencies = lock?.dependencies.filter((entry) => entry.localPath) || [];
    if (localDependencies.length) {
      throw new PacError(
        'PROFILE_APM_NON_PORTABLE',
        'Profile APM dependencies must use repository references; local paths are machine-specific.',
        { dependencies: localDependencies.map((entry) => entry.name).sort() },
      );
    }
    apm = {
      ...apmContext,
      dependencies,
      lock,
      portable: true,
    };
  }

  return {
    manifest,
    skills: effectiveSkills,
    catalogs: await validateCatalog(root),
    bootstrapPath,
    context,
    packages,
    apm,
    metadata,
  };
}

export async function validateProfileWorkspace(root) {
  const validated = await validateProfileTree(path.resolve(root));
  return {
    schemaVersion: validated.manifest.schemaVersion,
    skills: validated.skills.map(({ name }) => name),
    plugins: {
      enabled: [...validated.manifest.plugins.enabled],
      disabled: [...validated.manifest.plugins.disabled],
    },
    bootstrap: Boolean(validated.bootstrapPath),
    contexts: validated.context.files.length,
    apmDependencies: validated.apm?.dependencies.length || 0,
  };
}

function checkoutPath(context, repository, commit) {
  const repositoryKey = crypto.createHash('sha256').update(repository, 'utf8').digest('hex');
  return path.join(profileStoreDir(context), repositoryKey, commit);
}

async function assertCheckoutTarget(context, target) {
  await assertSafeManagedObject(context.home, target, 'PAC Profile checkout', 'directory');
}

function safeGitEnvironment(extra = {}) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

async function git(args, options = {}) {
  return await run('git', args, {
    ...options,
    env: options.env || safeGitEnvironment(),
    errorCode: options.errorCode || 'PROFILE_GIT_FAILED',
  });
}

async function checkoutCommit(root) {
  let output;
  try {
    ({ stdout: output } = await git([
      '-c', 'core.hooksPath=/dev/null', '-C', root, 'rev-parse', '--verify', 'HEAD^{commit}',
    ]));
  } catch (error) {
    throw new PacError('PROFILE_CACHE_INVALID', `Cannot verify cached Profile commit: ${error.message}`);
  }
  return normalizeCommit(output.trim(), 'PROFILE_CACHE_INVALID', 'Cached Profile commit');
}

async function assertTrackedAndClean(root, consumed) {
  const pathspec = [
    'pac-profile.json',
    'bootstrap.md',
    'skills',
    'catalog',
    'context',
    'packages',
    ...PROFILE_METADATA_FILES,
  ];
  let tracked;
  let status;
  try {
    ({ stdout: tracked } = await git([
      '-c', 'core.hooksPath=/dev/null', '-C', root, 'ls-files', '-z', '--', ...pathspec,
    ]));
    ({ stdout: status } = await git([
      '-c', 'core.hooksPath=/dev/null', '-C', root, 'status', '--porcelain=v1',
      '--untracked-files=all', '--', ...pathspec,
    ]));
  } catch (error) {
    throw new PacError('PROFILE_CACHE_INVALID', `Cannot verify cached Profile contents: ${error.message}`);
  }
  if (status.length > 0) {
    throw new PacError('PROFILE_CACHE_INVALID', 'Cached Profile contents differ from the locked commit.');
  }
  const trackedSet = new Set(tracked.split('\0').filter(Boolean));
  const missing = consumed.filter((relative) => !trackedSet.has(relative));
  if (missing.length > 0) {
    throw new PacError(
      'PROFILE_CACHE_INVALID',
      `Profile consumed content is not tracked by the locked commit: ${missing[0]}`,
    );
  }
}

async function consumedFiles(root, validated) {
  const result = ['pac-profile.json', ...validated.metadata];
  if (validated.bootstrapPath) result.push('bootstrap.md');
  result.push(...validated.context.files.map(({ relative }) => `context/${relative}`));
  result.push(...validated.packages.files);
  for (const skill of validated.skills) {
    const files = await regularFiles(skill.root, `Profile Skill ${skill.name}`);
    result.push(...files.map(({ relative }) => `${skill.path}/${relative}`));
  }
  if (validated.catalogs.pluginsPath) result.push('catalog/plugins.tsv');
  if (validated.catalogs.capabilitiesPath) result.push('catalog/capabilities.jsonl');
  return result;
}

async function loadCheckout(context, descriptor, root) {
  const actualCommit = await checkoutCommit(root);
  if (actualCommit !== descriptor.lockedCommit) {
    throw new PacError(
      'PROFILE_CACHE_INVALID',
      'Cached Profile checkout does not match the locked commit.',
      { expected: descriptor.lockedCommit, actual: actualCommit },
    );
  }
  const validated = await validateProfileTree(root);
  await assertTrackedAndClean(root, await consumedFiles(root, validated));
  return {
    descriptor: { ...descriptor },
    root,
    lockedCommit: descriptor.lockedCommit,
    manifest: validated.manifest,
    bootstrap: validated.bootstrapPath,
    contexts: {
      root: validated.context.root,
      files: validated.context.files.map(({ relative }) => relative),
    },
    apm: validated.apm,
    skills: validated.skills,
    plugins: {
      enabled: [...validated.manifest.plugins.enabled],
      disabled: [...validated.manifest.plugins.disabled],
      ...validated.catalogs,
    },
    catalog: {
      plugins: validated.catalogs.pluginsPath,
      capabilities: validated.catalogs.capabilitiesPath,
    },
  };
}

async function prepareStore(context) {
  const store = path.resolve(profileStoreDir(context));
  await assertSafeManagedObject(context.home, store, 'PAC Profile store', 'directory');
  await fs.mkdir(store, { recursive: true, mode: 0o700 });
  await assertSafeManagedPath(context.home, store, 'PAC Profile store');
  await fs.chmod(store, 0o700);
  return store;
}

export async function loadProfileDescriptor(context) {
  const file = path.resolve(profileConfigPath(context));
  await assertSafeManagedObject(context.home, file, 'PAC Profile descriptor', 'file');
  let content;
  try { content = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new PacError('PROFILE_DESCRIPTOR_INVALID', `Cannot read Profile descriptor: ${error.message}`);
  }
  try { return validateDescriptor(JSON.parse(content)); }
  catch (error) {
    if (error instanceof PacError) throw error;
    throw new PacError('PROFILE_DESCRIPTOR_INVALID', `Cannot parse Profile descriptor: ${error.message}`);
  }
}

export async function saveProfileDescriptor(context, descriptor) {
  const normalized = validateDescriptor(descriptor);
  const file = path.resolve(profileConfigPath(context));
  await assertSafeManagedObject(context.home, file, 'PAC Profile descriptor', 'file');
  await atomicWriteFile(file, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
  return normalized;
}

export async function removeProfileDescriptor(context) {
  const file = path.resolve(profileConfigPath(context));
  await assertSafeManagedObject(context.home, file, 'PAC Profile descriptor', 'file');
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function acquireProfile(context, { repository, ref, expectedCommit } = {}) {
  const normalizedRepository = validateRepository(repository);
  const normalizedRef = validateRef(ref);
  const normalizedExpected = expectedCommit === undefined
    ? null
    : normalizeCommit(expectedCommit, 'PROFILE_COMMIT_INVALID', 'Expected Profile commit');
  const store = await prepareStore(context);
  const repositoryKey = crypto.createHash('sha256').update(normalizedRepository, 'utf8').digest('hex');
  const repositoryRoot = path.join(store, repositoryKey);
  await fs.mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
  await assertSafeManagedPath(context.home, repositoryRoot, 'PAC Profile repository cache');
  await fs.chmod(repositoryRoot, 0o700);
  const token = crypto.randomUUID();
  const staging = path.join(repositoryRoot, `.acquire-${token}`);
  const template = path.join(repositoryRoot, `.template-${token}`);

  try {
    await fs.mkdir(template, { mode: 0o700 });
    await git(['init', '--quiet', staging], {
      env: safeGitEnvironment({ GIT_TEMPLATE_DIR: template }),
    });
    await git(['-C', staging, 'remote', 'add', 'origin', normalizedRepository]);
    const protocolArgs = path.isAbsolute(normalizedRepository)
      ? ['-c', 'protocol.file.allow=always']
      : ['-c', 'protocol.file.allow=never'];
    await git([
      ...protocolArgs, '-c', 'protocol.ext.allow=never', '-C', staging,
      'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', normalizedRef,
    ]);
    await git([
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', staging,
      'checkout', '--quiet', '--detach', 'FETCH_HEAD',
    ], {
      env: safeGitEnvironment({
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      }),
    });
    const commit = await checkoutCommit(staging);
    if (normalizedExpected && commit !== normalizedExpected) {
      throw new PacError(
        'PROFILE_COMMIT_MISMATCH',
        'Fetched Profile ref does not match the expected commit.',
        { expected: normalizedExpected, actual: commit },
      );
    }
    const descriptor = {
      schemaVersion: 1,
      repository: normalizedRepository,
      ref: normalizedRef,
      lockedCommit: commit,
    };
    await loadCheckout(context, descriptor, staging);
    const destination = checkoutPath(context, normalizedRepository, commit);
    const destinationStat = await lstatOrNull(destination);
    if (destinationStat) {
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new PacError('PROFILE_CACHE_INVALID', 'Profile cache destination is not a real directory.');
      }
      return await loadCheckout(context, descriptor, destination);
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    return await loadCheckout(context, descriptor, destination);
  } finally {
    await Promise.all([
      fs.rm(staging, { recursive: true, force: true }),
      fs.rm(template, { recursive: true, force: true }),
    ]);
  }
}

export async function loadActiveProfile(context) {
  const descriptor = await loadProfileDescriptor(context);
  if (!descriptor) return null;
  const destination = checkoutPath(context, descriptor.repository, descriptor.lockedCommit);
  await assertCheckoutTarget(context, destination);
  const stat = await lstatOrNull(destination);
  let effective;
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PacError('PROFILE_CACHE_INVALID', 'Profile cache destination is not a real directory.');
    }
    effective = await loadCheckout(context, descriptor, destination);
  } else {
    effective = await acquireProfile(context, {
      repository: descriptor.repository,
      ref: descriptor.lockedCommit,
      expectedCommit: descriptor.lockedCommit,
    });
  }
  return { ...effective, descriptor: { ...descriptor } };
}

export async function profileStatus(context) {
  const descriptor = await loadProfileDescriptor(context);
  if (!descriptor) return { configured: false, state: 'absent' };
  const destination = checkoutPath(context, descriptor.repository, descriptor.lockedCommit);
  await assertCheckoutTarget(context, destination);
  const stat = await lstatOrNull(destination);
  if (!stat) {
    return {
      configured: true,
      state: 'cache-missing',
      cached: false,
      ref: descriptor.ref,
      lockedCommit: descriptor.lockedCommit,
    };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PROFILE_CACHE_INVALID', 'Profile cache destination is not a real directory.');
  }
  const effective = await loadCheckout(context, descriptor, destination);
  return {
    configured: true,
    state: 'ready',
    cached: true,
    ref: descriptor.ref,
    lockedCommit: descriptor.lockedCommit,
    skills: effective.skills.map(({ name }) => name),
    bootstrap: Boolean(effective.bootstrap),
    contexts: effective.contexts.files.length,
    plugins: [...effective.plugins.enabled],
    disabledPlugins: [...effective.plugins.disabled],
  };
}
