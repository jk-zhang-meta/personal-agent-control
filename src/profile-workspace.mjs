import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { PacError } from './errors.mjs';
import { run } from './exec.mjs';
import { assertSafeManagedObject, assertSafeManagedPath } from './path-safety.mjs';

const WORKSPACE_PATHS = [
  'pac-profile.json', 'bootstrap.md', 'context', 'catalog', 'skills', 'packages',
  'README.md', 'LICENSE', 'LICENSE.md',
];

function descriptorPath(context) {
  return context.profileWorkspaceConfigPath
    || path.join(context.home, '.config/personal-agent-control/profile-workspace.json');
}

function defaultWorkspace(context) {
  return context.profileWorkspaceRoot
    || path.join(context.home, '.local/share/personal-agent-profile-workspaces/default');
}

function validateDescriptor(value) {
  if (!value || Array.isArray(value) || value.schemaVersion !== 1
      || Object.keys(value).sort().join(',') !== 'path,schemaVersion'
      || typeof value.path !== 'string' || !path.isAbsolute(value.path)) {
    throw new PacError(
      'PROFILE_WORKSPACE_DESCRIPTOR_INVALID',
      'profile-workspace.json must contain exactly schemaVersion 1 and an absolute path.',
    );
  }
  return { schemaVersion: 1, path: path.normalize(value.path) };
}

async function lstatOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function git(root, args, options = {}) {
  return await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    ...options,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(options.env || {}),
    },
    errorCode: options.errorCode || 'PROFILE_WORKSPACE_GIT_FAILED',
  });
}

function remoteBranchName(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  if (ref.startsWith('refs/') || /^[0-9a-f]{40,64}$/iu.test(ref)) return null;
  return ref;
}

async function hasRemoteBranch(root, branch) {
  if (!branch) return false;
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function checkoutProfileBase(root, { ref, expectedCommit }) {
  if (typeof ref !== 'string' || !ref || !expectedCommit) {
    throw new PacError(
      'PROFILE_WORKSPACE_BASE_INVALID',
      'Editable Profile acquisition requires both the active ref and locked commit.',
    );
  }
  const expected = String(expectedCommit).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(expected)) {
    throw new PacError('PROFILE_WORKSPACE_COMMIT_INVALID', 'Editable Profile base must be a full commit.');
  }
  await git(root, ['fetch', '--quiet', '--no-tags', 'origin', ref]);
  const actual = (await git(root, ['rev-parse', '--verify', `${expected}^{commit}`])).stdout.trim().toLowerCase();
  if (actual !== expected) {
    throw new PacError('PROFILE_WORKSPACE_COMMIT_MISMATCH', 'Editable Profile base does not match the active locked commit.', {
      expected,
      actual,
    });
  }
  const branch = remoteBranchName(ref);
  if (await hasRemoteBranch(root, branch)) {
    await git(root, ['checkout', '--quiet', '-B', branch, expected]);
    await git(root, ['branch', '--set-upstream-to', `origin/${branch}`, branch]);
  } else {
    await git(root, ['checkout', '--quiet', '-B', 'pac-profile-edit', expected]);
  }
}

async function trackedUpstream(root) {
  try {
    const upstream = (await git(root, [
      'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
    ])).stdout.trim();
    return upstream || null;
  } catch {
    return null;
  }
}

async function assertWorkspace(context, root) {
  await assertSafeManagedObject(context.home, root, 'Profile workspace', 'directory');
  const stat = await lstatOrNull(root);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PROFILE_WORKSPACE_INVALID', `Profile workspace must be a real directory: ${root}`);
  }
  const gitStat = await lstatOrNull(path.join(root, '.git'));
  if (!gitStat || !gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw new PacError('PROFILE_WORKSPACE_INVALID', `Profile workspace is not a Git worktree: ${root}`);
  }
  return root;
}

export async function loadWorkspaceDescriptor(context) {
  const file = descriptorPath(context);
  await assertSafeManagedObject(context.home, file, 'Profile workspace descriptor', 'file');
  try {
    const descriptor = validateDescriptor(JSON.parse(await fs.readFile(file, 'utf8')));
    await assertWorkspace(context, descriptor.path);
    return descriptor;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof PacError) throw error;
    throw new PacError('PROFILE_WORKSPACE_DESCRIPTOR_INVALID', `Cannot read Profile workspace descriptor: ${error.message}`);
  }
}

async function saveDescriptor(context, root) {
  const descriptor = validateDescriptor({ schemaVersion: 1, path: root });
  const file = descriptorPath(context);
  await assertSafeManagedObject(context.home, file, 'Profile workspace descriptor', 'file');
  await atomicWriteFile(file, `${JSON.stringify(descriptor, null, 2)}\n`, 0o600);
  return descriptor;
}

async function writeTemplate(root) {
  await fs.mkdir(path.join(root, 'catalog'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, 'packages/skills'), { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.writeFile(path.join(root, 'pac-profile.json'), `${JSON.stringify({
      schemaVersion: 3,
      bootstrap: 'bootstrap.md',
      skills: [],
      plugins: { enabled: [], disabled: [] },
      providers: { enabled: [] },
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }),
    fs.writeFile(
      path.join(root, 'bootstrap.md'),
      '# Personal bootstrap\n\nAdd only short, always-on private instructions here.\n',
      { flag: 'wx', mode: 0o600 },
    ),
    fs.writeFile(path.join(root, 'catalog/capabilities.jsonl'), '', { flag: 'wx', mode: 0o600 }),
    fs.writeFile(
      path.join(root, 'catalog/plugins.tsv'),
      '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility\n',
      { flag: 'wx', mode: 0o600 },
    ),
    fs.writeFile(
      path.join(root, 'packages/skills/apm.yml'),
      `name: personal-agent-profile-skills
version: 1.0.0
description: Private Skill dependencies managed by Personal Agent Control
author: Personal Agent Control
targets:
  - agent-skills
dependencies:
  apm: []
  mcp: []
includes: auto
scripts: {}
`,
      { flag: 'wx', mode: 0o600 },
    ),
    fs.writeFile(
      path.join(root, 'README.md'),
      '# Personal Agent Profile\n\nPrivate PAC overlay. Keep the bootstrap small and route larger context modules through catalog metadata.\n',
      { flag: 'wx', mode: 0o600 },
    ),
  ]);
}

async function commit(root, message) {
  const allowed = new Set([...WORKSPACE_PATHS, '.git']);
  const unexpected = (await fs.readdir(root)).filter((name) => !allowed.has(name));
  if (unexpected.length) {
    throw new PacError('PROFILE_WORKSPACE_INVALID', `Unsupported Profile workspace entry: ${unexpected.sort()[0]}`);
  }
  await git(root, ['add', '--all', '--', '.']);
  const staged = (await git(root, ['diff', '--cached', '--name-only', '--', '.'])).stdout.trim();
  if (staged) {
    await git(root, [
      '-c', 'user.name=Personal Agent Control',
      '-c', 'user.email=pac@localhost',
      'commit', '--quiet', '-m', message, '--', '.',
    ]);
  }
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new PacError('PROFILE_WORKSPACE_GIT_FAILED', 'Profile workspace HEAD is not a full commit.');
  }
  return head;
}

export async function ensureProfileWorkspace(context, options = {}) {
  const existing = await loadWorkspaceDescriptor(context);
  if (existing) return { ...existing, created: false };
  const root = path.resolve(options.path || defaultWorkspace(context));
  await assertSafeManagedObject(context.home, root, 'Profile workspace', 'directory');
  const stat = await lstatOrNull(root);
  if (stat) {
    await assertWorkspace(context, root);
  } else {
    await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    await assertSafeManagedPath(context.home, path.dirname(root), 'Profile workspace parent');
    try {
      if (options.repository) {
        await run('git', ['clone', '--no-tags', options.repository, root], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          errorCode: 'PROFILE_WORKSPACE_GIT_FAILED',
        });
        await checkoutProfileBase(root, options);
      } else {
        await fs.mkdir(root, { mode: 0o700 });
        await run('git', ['init', '--quiet', '--initial-branch=main', root], {
          errorCode: 'PROFILE_WORKSPACE_GIT_FAILED',
        });
        await writeTemplate(root);
        await commit(root, 'Initialize personal agent profile');
      }
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  const descriptor = await saveDescriptor(context, root);
  return { ...descriptor, created: true };
}

export async function commitProfileWorkspace(context, options = {}) {
  const descriptor = await loadWorkspaceDescriptor(context);
  if (!descriptor) throw new PacError('PROFILE_WORKSPACE_MISSING', 'No editable Profile workspace is configured.');
  if (options.validate) await options.validate(descriptor.path);
  const head = await commit(descriptor.path, options.message || 'Update personal agent profile');
  return { ...descriptor, commit: head };
}

export async function profileWorkspaceRepository(context) {
  const descriptor = await loadWorkspaceDescriptor(context);
  if (!descriptor) return null;
  try {
    const repository = (await git(descriptor.path, ['remote', 'get-url', 'origin'])).stdout.trim();
    return repository || descriptor.path;
  } catch {
    return descriptor.path;
  }
}

export async function publishProfileWorkspace(context, { repository, runCommand = run } = {}) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new PacError('PROFILE_REPOSITORY_INVALID', 'Profile publication requires OWNER/REPOSITORY.');
  }
  const descriptor = await loadWorkspaceDescriptor(context);
  if (!descriptor) throw new PacError('PROFILE_WORKSPACE_MISSING', 'No editable Profile workspace is configured.');
  await runCommand('gh', [
    'repo', 'create', repository, '--private', '--source', descriptor.path, '--remote', 'origin', '--push',
  ], { cwd: descriptor.path, errorCode: 'PROFILE_PUBLISH_FAILED' });
  return { ...descriptor, repository, published: true };
}

export async function syncProfileWorkspace(context, options = {}) {
  const descriptor = await loadWorkspaceDescriptor(context);
  if (!descriptor) throw new PacError('PROFILE_WORKSPACE_MISSING', 'No editable Profile workspace is configured.');
  const remote = await profileWorkspaceRepository(context);
  if (!remote || remote === descriptor.path) {
    throw new PacError('PROFILE_REMOTE_MISSING', 'Profile workspace has no origin remote; run pac profile publish first.');
  }
  if (!await trackedUpstream(descriptor.path)) {
    throw new PacError(
      'PROFILE_WORKSPACE_UPSTREAM_REQUIRED',
      'This Profile workspace was created from a tag or commit; configure an upstream branch before syncing.',
    );
  }
  const committed = await commitProfileWorkspace(context, options);
  const runner = options.runCommand || run;
  await runner('git', ['-c', 'core.hooksPath=/dev/null', '-C', committed.path, 'pull', '--ff-only'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    errorCode: 'PROFILE_SYNC_FAILED',
  });
  await runner('git', ['-c', 'core.hooksPath=/dev/null', '-C', committed.path, 'push', 'origin', 'HEAD'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    errorCode: 'PROFILE_SYNC_FAILED',
  });
  const head = (await git(committed.path, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim().toLowerCase();
  return { ...committed, commit: head, repository: remote, synced: true };
}
