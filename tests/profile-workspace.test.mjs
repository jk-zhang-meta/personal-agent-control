import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { resolveContext } from '../src/config.mjs';
import { validateProfileWorkspace } from '../src/profile.mjs';
import {
  commitProfileWorkspace, ensureProfileWorkspace, loadWorkspaceDescriptor,
  publishProfileWorkspace, syncProfileWorkspace,
} from '../src/profile-workspace.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const context = resolveContext({ home });
  return { root, home, context };
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createBareRemote(root, source, name) {
  const remote = path.join(root, name);
  const cloned = spawnSync('git', ['clone', '--bare', source, remote], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr || cloned.stdout);
  return remote;
}

test('Profile workspace init is versioned, valid, and idempotent', async (t) => {
  const { context } = await fixture(t);
  const first = await ensureProfileWorkspace(context);
  assert.equal(first.created, true);
  assert.equal((await validateProfileWorkspace(first.path)).schemaVersion, 3);
  const manifest = JSON.parse(await fs.readFile(path.join(first.path, 'pac-profile.json'), 'utf8'));
  assert.deepEqual(manifest.plugins, { enabled: [], disabled: [] });
  assert.deepEqual(manifest.providers, { enabled: [] });
  const second = await ensureProfileWorkspace(context);
  assert.equal(second.created, false);
  assert.equal(second.path, first.path);
  assert.deepEqual(await loadWorkspaceDescriptor(context), { schemaVersion: 1, path: first.path });
});

test('Profile workspace commits validated local changes', async (t) => {
  const { context } = await fixture(t);
  const workspace = await ensureProfileWorkspace(context);
  const before = (await commitProfileWorkspace(context, { validate: validateProfileWorkspace })).commit;
  await fs.writeFile(path.join(workspace.path, 'bootstrap.md'), '# Personal bootstrap\n\nUse Chinese by default.\n');
  const after = (await commitProfileWorkspace(context, {
    message: 'Update bootstrap',
    validate: validateProfileWorkspace,
  })).commit;
  assert.notEqual(after, before);
});

test('cloned Profile workspace starts at the active commit on a tracked branch', async (t) => {
  const { root } = await fixture(t);
  const sourceHome = path.join(root, 'source-home');
  const targetHome = path.join(root, 'target-home');
  await Promise.all([fs.mkdir(sourceHome), fs.mkdir(targetHome)]);
  const sourceContext = resolveContext({ home: sourceHome });
  const source = await ensureProfileWorkspace(sourceContext);
  const activeCommit = git(source.path, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(source.path, 'bootstrap.md'), '# Personal bootstrap\n\nLater remote change.\n');
  const remoteCommit = (await commitProfileWorkspace(sourceContext, {
    message: 'Move remote branch',
    validate: validateProfileWorkspace,
  })).commit;
  assert.notEqual(remoteCommit, activeCommit);

  const remote = createBareRemote(root, source.path, 'profile.git');
  const targetContext = resolveContext({ home: targetHome });
  const workspacePath = path.join(targetHome, '.local/share/profile-workspace');
  const workspace = await ensureProfileWorkspace(targetContext, {
    path: workspacePath,
    repository: remote,
    ref: 'main',
    expectedCommit: activeCommit,
  });

  assert.equal(git(workspace.path, ['rev-parse', 'HEAD']), activeCommit);
  assert.equal(git(workspace.path, ['branch', '--show-current']), 'main');
  assert.equal(git(workspace.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), 'origin/main');
  assert.equal(git(workspace.path, ['rev-parse', 'origin/main']), remoteCommit);
});

test('tag-only and raw-SHA Profile bases stay locked and require an explicit upstream', async (t) => {
  const { root } = await fixture(t);
  const sourceHome = path.join(root, 'detached-source-home');
  await fs.mkdir(sourceHome);
  const sourceContext = resolveContext({ home: sourceHome });
  const source = await ensureProfileWorkspace(sourceContext);
  git(source.path, ['checkout', '--orphan', 'tag-only']);
  await fs.writeFile(path.join(source.path, 'bootstrap.md'), '# Personal bootstrap\n\nTag-only base.\n');
  const tagCommit = (await commitProfileWorkspace(sourceContext, {
    message: 'Create tag-only base',
    validate: validateProfileWorkspace,
  })).commit;
  git(source.path, ['tag', 'v1-profile', tagCommit]);
  git(source.path, ['checkout', 'main']);
  git(source.path, ['branch', '-D', 'tag-only']);
  const remote = createBareRemote(root, source.path, 'detached-profile.git');

  for (const [name, ref] of [['tag', 'v1-profile'], ['sha', tagCommit]]) {
    await t.test(name, async (subtest) => {
      const home = path.join(root, `${name}-home`);
      await fs.mkdir(home);
      const context = resolveContext({ home });
      const workspace = await ensureProfileWorkspace(context, {
        repository: remote,
        ref,
        expectedCommit: tagCommit,
      });
      assert.equal(git(workspace.path, ['rev-parse', 'HEAD']), tagCommit);
      assert.equal(git(workspace.path, ['branch', '--show-current']), 'pac-profile-edit');
      await assert.rejects(
        syncProfileWorkspace(context, { validate: validateProfileWorkspace }),
        (error) => error.code === 'PROFILE_WORKSPACE_UPSTREAM_REQUIRED',
      );
      subtest.after(() => fs.rm(home, { recursive: true, force: true }));
    });
  }
});

test('failed locked acquisition removes the partial workspace and descriptor', async (t) => {
  const { root, context } = await fixture(t);
  const sourceHome = path.join(root, 'failure-source-home');
  await fs.mkdir(sourceHome);
  const sourceContext = resolveContext({ home: sourceHome });
  const source = await ensureProfileWorkspace(sourceContext);
  const remote = createBareRemote(root, source.path, 'failure-profile.git');
  const workspacePath = path.join(context.home, '.local/share/failed-profile-workspace');

  await assert.rejects(
    ensureProfileWorkspace(context, {
      path: workspacePath,
      repository: remote,
      ref: 'missing-tag',
      expectedCommit: 'f'.repeat(40),
    }),
    (error) => error.code === 'PROFILE_WORKSPACE_GIT_FAILED',
  );
  await assert.rejects(fs.access(workspacePath));
  assert.equal(await loadWorkspaceDescriptor(context), null);
});

test('Profile sync commits, fast-forwards safely, and pushes its tracked branch', async (t) => {
  const { root } = await fixture(t);
  const sourceHome = path.join(root, 'sync-source-home');
  const targetHome = path.join(root, 'sync-target-home');
  await Promise.all([fs.mkdir(sourceHome), fs.mkdir(targetHome)]);
  const sourceContext = resolveContext({ home: sourceHome });
  const source = await ensureProfileWorkspace(sourceContext);
  const base = git(source.path, ['rev-parse', 'HEAD']);
  const remote = createBareRemote(root, source.path, 'sync-profile.git');

  const targetContext = resolveContext({ home: targetHome });
  const workspace = await ensureProfileWorkspace(targetContext, {
    path: path.join(targetHome, '.local/share/profile-workspace'),
    repository: remote,
    ref: 'main',
    expectedCommit: base,
  });
  await fs.writeFile(path.join(workspace.path, 'bootstrap.md'), '# Personal bootstrap\n\nSynchronized change.\n');
  const synced = await syncProfileWorkspace(targetContext, {
    message: 'Synchronize fixture Profile',
    validate: validateProfileWorkspace,
  });

  assert.equal(synced.synced, true);
  assert.notEqual(synced.commit, base);
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), synced.commit);
});

test('Profile publication delegates exactly to gh private repository creation', async (t) => {
  const { context } = await fixture(t);
  const workspace = await ensureProfileWorkspace(context);
  const calls = [];
  const result = await publishProfileWorkspace(context, {
    repository: 'owner/private-profile',
    runCommand: async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  });
  assert.equal(result.published, true);
  assert.deepEqual(calls[0][0], 'gh');
  assert.deepEqual(calls[0][1], [
    'repo', 'create', 'owner/private-profile', '--private', '--source', workspace.path,
    '--remote', 'origin', '--push',
  ]);
});
