import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from './exec.mjs';
import { PacError } from './errors.mjs';

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/iu;

export const MATERIALIZER_EXCEPTIONS = [{
  name: 'ppt-master',
  engine: 'skills',
  delivery: 'vercel-skills-exception',
  engineVersion: '1.5.22',
  source: 'hugohe3/ppt-master',
  ref: 'v4.3.0',
  commit: 'f5410f968e0fadbbd1f9815539238a8dda34b4d2',
  skillPath: 'skills/ppt-master',
  contentSha256: '18facf0343aba4c9cabb356fdc370802c36913eaa8d52f45e62f09f84185294f',
  platformContentSha256: {
    win32: '5bf79890710cf55e201501f7e61b77eb530f4841b9804f5e992674cf2a61ad00',
  },
  reason: 'APM 0.28.0 cannot safely reload the generated lock for this 12,230-file Skill.',
}];

function pinFromCapability(defaults, capability) {
  const fail = (message) => {
    throw new PacError(
      'MATERIALIZER_PIN_INVALID',
      `Profile ${defaults.name} ${message}`,
    );
  };
  const hasOverride = ['source', 'ref', 'commit', 'contentSha256', 'skillPath']
    .some((field) => capability[field] !== undefined);
  if (!hasOverride) return defaults;
  if (typeof capability.commit !== 'string' || !COMMIT_PATTERN.test(capability.commit)) {
    fail('must pin a full git commit; live tags are not a version.');
  }
  if (typeof capability.contentSha256 !== 'string' || !DIGEST_PATTERN.test(capability.contentSha256)) {
    fail('must pin contentSha256 for the selected commit.');
  }
  if (capability.source !== undefined && (typeof capability.source !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(capability.source))) {
    fail('source must be an OWNER/REPOSITORY locator.');
  }
  if (capability.skillPath !== undefined && (typeof capability.skillPath !== 'string' || capability.skillPath.includes('..') || path.isAbsolute(capability.skillPath))) {
    fail('skillPath must be a relative Skill directory.');
  }
  if (capability.ref !== undefined && (typeof capability.ref !== 'string' || !capability.ref || capability.ref.length > 256)) {
    fail('ref must be a short version label when present.');
  }
  return {
    ...defaults,
    source: capability.source || defaults.source,
    ref: capability.ref || capability.commit.toLowerCase(),
    commit: capability.commit.toLowerCase(),
    contentSha256: capability.contentSha256.toLowerCase(),
    platformContentSha256: {},
    skillPath: capability.skillPath || defaults.skillPath,
  };
}

export async function selectedMaterializerExceptions(profile) {
  const capabilitiesPath = profile?.catalog?.capabilities;
  if (!capabilitiesPath) return [];
  const selected = [];
  const seen = new Set();
  const text = await fs.readFile(capabilitiesPath, 'utf8');
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let capability;
    try { capability = JSON.parse(line); }
    catch {
      throw new PacError(
        'PROFILE_CAPABILITY_INVALID',
        `Invalid Profile capability JSON on line ${index + 1}.`,
      );
    }
    for (const defaults of MATERIALIZER_EXCEPTIONS) {
      if (capability.id !== `skill:${defaults.name}` || capability.delivery !== defaults.delivery) continue;
      if (seen.has(defaults.name)) {
        throw new PacError(
          'PROFILE_CAPABILITY_INVALID',
          `Duplicate materializer capability for ${defaults.name}.`,
        );
      }
      seen.add(defaults.name);
      selected.push(pinFromCapability(defaults, capability));
    }
  }
  return selected;
}

function expectedContentDigest(entry) {
  if (process.env.NODE_ENV === 'test' && process.env.PAC_TEST_PPT_CONTENT_SHA256) {
    return process.env.PAC_TEST_PPT_CONTENT_SHA256;
  }
  return entry.platformContentSha256?.[process.platform] || entry.contentSha256;
}

async function hashDirectory(root) {
  const records = [];
  async function collect(directory, relativeDirectory) {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.isDirectory()) await collect(absolute, relative);
      else if (child.isFile()) {
        const stat = await fs.lstat(absolute);
        records.push({ type: 'file', path: relative, executable: (stat.mode & 0o111) !== 0, content: await fs.readFile(absolute) });
      } else if (child.isSymbolicLink()) {
        records.push({ type: 'symlink', path: relative, target: await fs.readlink(absolute) });
      } else throw new PacError('MATERIALIZER_INTEGRITY_FAILED', `Unsupported entry in ${root}: ${relative}`);
    }
  }
  await collect(root, '');
  records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const hash = crypto.createHash('sha256');
  for (const record of records) {
    hash.update(record.type); hash.update('\0'); hash.update(record.path); hash.update('\0');
    if (record.type === 'file') {
      hash.update(record.executable ? 'x' : '-'); hash.update('\0'); hash.update(record.content);
    } else hash.update(record.target);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function materializerStatus(neutralStore, entries = MATERIALIZER_EXCEPTIONS) {
  return await Promise.all(entries.map(async (entry) => {
    const skillRoot = path.join(neutralStore, '.agents/skills', entry.name);
    try {
      const actual = await hashDirectory(skillRoot);
      return { ...entry, installed: true, valid: actual === expectedContentDigest(entry), actualSha256: actual };
    } catch (error) {
      if (error.code === 'ENOENT') return { ...entry, installed: false, valid: false, actualSha256: null };
      throw error;
    }
  }));
}

export async function applyMaterializerExceptions(
  context,
  neutralStore,
  ownedNames = new Set(),
  entries = MATERIALIZER_EXCEPTIONS,
  previousEntries = [],
) {
  await fs.mkdir(neutralStore, { recursive: true, mode: 0o700 });
  const results = [];
  for (const entry of entries) {
    const current = (await materializerStatus(neutralStore, entries)).find((item) => item.name === entry.name);
    if (current.valid) {
      results.push(current);
      continue;
    }
    const target = path.join(neutralStore, '.agents/skills', entry.name);
    try {
      const stat = await fs.lstat(target);
      const previous = previousEntries.find((item) => item.name === entry.name);
      const verified = ownedNames.has(entry.name) && previous && stat.isDirectory()
        && (await materializerStatus(neutralStore, [previous]))[0].valid;
      if (!verified) {
        const code = ownedNames.has(entry.name) ? 'MANAGED_DRIFT' : 'SKILL_COLLISION';
        throw new PacError(code, `${ownedNames.has(entry.name) ? 'Modified managed' : 'Unmanaged'} Skill blocks ${entry.name}: ${target}`);
      }
      // The caller's transaction has backed up this unchanged, previously pinned version.
      await fs.rm(target, { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const testSource = process.env.NODE_ENV === 'test' ? process.env.PAC_TEST_PPT_SOURCE : undefined;
    if (!entry.commit || !COMMIT_PATTERN.test(entry.commit)) {
      throw new PacError('MATERIALIZER_PIN_INVALID', `${entry.name} must pin a full git commit.`);
    }
    await fs.mkdir(context.stateDir, { recursive: true, mode: 0o700 });
    const checkout = testSource
      ? null
      : await fs.mkdtemp(path.join(context.stateDir, `materializer-${entry.name}-${entry.commit}-`));
    try {
      if (checkout) {
        await run('git', ['init', '--quiet', checkout], { cwd: context.root, errorCode: 'MATERIALIZER_SOURCE_FAILED' });
        await run('git', ['-C', checkout, 'remote', 'add', 'origin', `https://github.com/${entry.source}.git`], {
          cwd: context.root, errorCode: 'MATERIALIZER_SOURCE_FAILED',
        });
        await run('git', ['-C', checkout, 'fetch', '--quiet', '--depth', '1', 'origin', entry.commit], {
          cwd: context.root, errorCode: 'MATERIALIZER_SOURCE_FAILED',
        });
        await run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], {
          cwd: context.root, errorCode: 'MATERIALIZER_SOURCE_FAILED',
        });
        const resolved = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
          cwd: context.root, errorCode: 'MATERIALIZER_SOURCE_FAILED',
        })).stdout.trim();
        if (resolved !== entry.commit) {
          throw new PacError('MATERIALIZER_PIN_MISMATCH', `Fetched ${entry.source} resolved to ${resolved}, expected ${entry.commit}.`);
        }
      }
      const source = testSource || path.join(checkout, entry.skillPath);
      const skillArgs = ['add', source, '--global', '--skill', entry.name, '--yes', '--agent', 'universal'];
      const isolated = {
        HOME: neutralStore,
        ...(process.platform === 'win32' ? { USERPROFILE: neutralStore } : {}),
        XDG_CONFIG_HOME: path.join(neutralStore, '.config'),
        XDG_DATA_HOME: path.join(neutralStore, '.local/share'),
        XDG_CACHE_HOME: path.join(neutralStore, '.cache'),
        XDG_STATE_HOME: path.join(neutralStore, '.local/state'),
        DISABLE_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
      };
      const override = process.env.PAC_SKILLS;
      const windowsMiseData = process.env.LOCALAPPDATA
        || path.join(context.home, 'AppData/Local');
      const windowsSkillsRoot = path.join(
        windowsMiseData,
        'mise/installs/npm-skills',
        entry.engineVersion,
        'node_modules',
      );
      const windowsSkillsCli = path.join(
        windowsSkillsRoot,
        '.mise',
        `skills@${entry.engineVersion}`,
        'node_modules/skills/bin/cli.mjs',
      );
      const command = override
        || (process.platform === 'win32' ? process.execPath : path.join(context.home, '.local/bin/mise'));
      const args = override
        ? skillArgs
        : (process.platform === 'win32'
          ? [windowsSkillsCli, ...skillArgs]
          : ['--cd', context.root, 'exec', '--', 'env', ...Object.entries(isolated).map(([key, value]) => `${key}=${value}`), 'skills', ...skillArgs]);
      const windowsNodePath = [
        windowsSkillsRoot,
        path.join(windowsSkillsRoot, '.mise/node_modules'),
      ].join(path.delimiter);
      await run(command, args, {
        cwd: override ? neutralStore : context.root,
        env: override || process.platform === 'win32'
          ? { ...process.env, ...isolated, ...(process.platform === 'win32' ? { NODE_PATH: windowsNodePath } : {}) }
          : { ...process.env, HOME: context.home },
        errorCode: 'MATERIALIZER_APPLY_FAILED',
      });
    } finally {
      if (checkout) await fs.rm(checkout, { recursive: true, force: true });
    }
    const installed = (await materializerStatus(neutralStore, entries)).find((item) => item.name === entry.name);
    if (!installed.valid) {
      throw new PacError('MATERIALIZER_INTEGRITY_FAILED', `${entry.name} did not match its reviewed SHA-256.`, installed);
    }
    results.push(installed);
  }
  return results;
}
