import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from './exec.mjs';
import { PacError } from './errors.mjs';

export const MATERIALIZER_EXCEPTIONS = [{
  name: 'ppt-master',
  engine: 'skills',
  engineVersion: '1.5.22',
  source: 'hugohe3/ppt-master',
  ref: 'v4.3.0',
  commit: '51cb529d00638097e70fd3e9d865a0bf061b5e19',
  skillPath: 'skills/ppt-master',
  contentSha256: '18facf0343aba4c9cabb356fdc370802c36913eaa8d52f45e62f09f84185294f',
  reason: 'APM 0.28.0 cannot safely reload the generated lock for this 12,230-file Skill.',
}];

export async function selectedMaterializerExceptions(profile) {
  const capabilitiesPath = profile?.catalogs?.capabilitiesPath;
  if (!capabilitiesPath) return [];
  const declared = new Set();
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
    for (const entry of MATERIALIZER_EXCEPTIONS) {
      if (capability.id === `skill:${entry.name}`
          && capability.delivery === `${entry.engine}-exception`) {
        declared.add(entry.name);
      }
    }
  }
  return MATERIALIZER_EXCEPTIONS.filter((entry) => declared.has(entry.name));
}

function expectedContentDigest(entry) {
  if (process.env.NODE_ENV === 'test' && process.env.PAC_TEST_PPT_CONTENT_SHA256) {
    return process.env.PAC_TEST_PPT_CONTENT_SHA256;
  }
  return entry.contentSha256;
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

async function verifyTag(context, entry) {
  const { stdout } = await run('git', [
    'ls-remote', `https://github.com/${entry.source}.git`,
    `refs/tags/${entry.ref}`, `refs/tags/${entry.ref}^{}`,
  ], { cwd: context.root, errorCode: 'MATERIALIZER_SOURCE_FAILED' });
  const rows = stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split(/\s+/u));
  const peeled = rows.find(([, ref]) => ref?.endsWith('^{}'))?.[0];
  const direct = rows.find(([, ref]) => !ref?.endsWith('^{}'))?.[0];
  if ((peeled || direct) !== entry.commit) {
    throw new PacError('MATERIALIZER_PIN_MISMATCH', `${entry.source}@${entry.ref} no longer resolves to the reviewed commit.`);
  }
}

export async function applyMaterializerExceptions(
  context,
  neutralStore,
  ownedNames = new Set(),
  entries = MATERIALIZER_EXCEPTIONS,
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
      await fs.lstat(target);
      const code = ownedNames.has(entry.name) ? 'MANAGED_DRIFT' : 'SKILL_COLLISION';
      throw new PacError(code, `${ownedNames.has(entry.name) ? 'Modified managed' : 'Unmanaged'} Skill blocks ${entry.name}: ${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const testSource = process.env.NODE_ENV === 'test' ? process.env.PAC_TEST_PPT_SOURCE : undefined;
    if (!testSource) await verifyTag(context, entry);
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
        XDG_CONFIG_HOME: path.join(neutralStore, '.config'),
        XDG_DATA_HOME: path.join(neutralStore, '.local/share'),
        XDG_CACHE_HOME: path.join(neutralStore, '.cache'),
        XDG_STATE_HOME: path.join(neutralStore, '.local/state'),
        DISABLE_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
      };
      const override = process.env.PAC_SKILLS;
      const command = override || path.join(context.home, '.local/bin/mise');
      const args = override
        ? skillArgs
        : ['--cd', context.root, 'exec', '--', 'env', ...Object.entries(isolated).map(([key, value]) => `${key}=${value}`), 'skills', ...skillArgs];
      await run(command, args, {
        cwd: override ? neutralStore : context.root,
        env: override ? { ...process.env, ...isolated } : { ...process.env, HOME: context.home },
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
