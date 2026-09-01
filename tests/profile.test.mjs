import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  acquireProfile,
  hashDirectory,
  loadActiveProfile,
  loadProfileDescriptor,
  profileStatus,
  removeProfileDescriptor,
  saveProfileDescriptor,
} from '../src/profile.mjs';
import { renderManifest } from '../src/apm.mjs';

const execute = promisify(execFile);

async function git(repository, ...args) {
  return await execute('git', ['-C', repository, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pac-profile-test-')));
  const home = path.join(temporary, 'home');
  const repository = path.join(temporary, 'profile-source');
  await Promise.all([fs.mkdir(home), fs.mkdir(repository)]);
  await execute('git', ['init', '--quiet', repository], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  await git(repository, 'config', 'user.name', 'PAC Tests');
  await git(repository, 'config', 'user.email', 'pac-tests@example.invalid');
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return {
    temporary,
    home,
    repository,
    context: {
      home,
      profileConfigPath: path.join(home, '.config/personal-agent-control/profile.json'),
      profileStoreDir: path.join(home, '.local/share/personal-agent-profiles'),
    },
  };
}

async function writeProfile(repository, mutate = async () => {}) {
  const skillRoot = path.join(repository, 'skills/personal-environment');
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(
    path.join(skillRoot, 'SKILL.md'),
    '---\nname: personal-environment\ndescription: fixture\n---\n',
  );
  const manifest = {
    schemaVersion: 1,
    skills: [{
      name: 'personal-environment',
      path: 'skills/personal-environment',
      contentSha256: await hashDirectory(skillRoot),
      targets: ['codex', 'claude'],
    }],
    plugins: { enabled: [] },
  };
  await mutate({ repository, skillRoot, manifest });
  await fs.writeFile(path.join(repository, 'pac-profile.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await git(repository, 'add', '--all');
  await git(repository, 'commit', '--quiet', '-m', 'Profile fixture');
  return (await git(repository, 'rev-parse', 'HEAD')).stdout.trim();
}

test('an unconfigured Profile is absent and removal is idempotent', async (t) => {
  const { context } = await fixture(t);
  assert.equal(await loadProfileDescriptor(context), null);
  assert.deepEqual(await profileStatus(context), { configured: false, state: 'absent' });
  assert.equal(await removeProfileDescriptor(context), false);
});

test('Profile APM rejects machine-local dependencies', async (t) => {
  const { context, repository } = await fixture(t);
  const commit = await writeProfile(repository, async ({ repository: profileRoot }) => {
    const packages = path.join(profileRoot, 'packages/skills');
    await fs.mkdir(packages, { recursive: true });
    await fs.writeFile(
      path.join(packages, 'apm.yml'),
      renderManifest(['../../skills/personal-environment']),
    );
    await fs.writeFile(path.join(packages, 'apm.lock.yaml'), [
      "lockfile_version: '1'",
      "generated_at: '2026-01-01T00:00:00Z'",
      'apm_version: 0.28.0',
      'dependencies:',
      '- repo_url: _local/personal-environment',
      '  name: personal-environment',
      '  version: 0.0.0',
      '  package_type: claude_skill',
      '  source: local',
      '  local_path: ../../skills/personal-environment',
      'deployments: []',
      '',
    ].join('\n'));
  });

  await assert.rejects(
    acquireProfile(context, { repository, ref: commit, expectedCommit: commit }),
    (error) => error.code === 'PROFILE_APM_NON_PORTABLE',
  );
});

test('a valid local Profile is acquired, locked, loaded, and reported without its locator', async (t) => {
  const { context, repository } = await fixture(t);
  const sourceCommit = await writeProfile(repository);
  const acquired = await acquireProfile(context, { repository, ref: 'HEAD' });

  assert.equal(acquired.lockedCommit, sourceCommit);
  assert.equal(acquired.skills[0].name, 'personal-environment');
  assert.deepEqual(acquired.skills[0].targets, ['codex', 'claude']);
  assert.match(acquired.root, new RegExp(`${sourceCommit}$`, 'u'));
  const descriptor = await saveProfileDescriptor(context, acquired.descriptor);
  assert.deepEqual(await loadProfileDescriptor(context), descriptor);

  const active = await loadActiveProfile(context);
  assert.equal(active.root, acquired.root);
  assert.equal(active.descriptor.ref, 'HEAD');
  const status = await profileStatus(context);
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.skills, ['personal-environment']);
  assert.equal(JSON.stringify(status).includes(repository), false);
  assert.equal(await removeProfileDescriptor(context), true);
  assert.equal(await loadProfileDescriptor(context), null);
});

test('Profile schema v3 declares portable providers without per-host duplication', async (t) => {
  const { context, repository } = await fixture(t);
  const commit = await writeProfile(repository, async ({ manifest }) => {
    manifest.schemaVersion = 3;
    manifest.bootstrap = null;
    manifest.plugins = { enabled: [], disabled: [] };
    manifest.providers = { enabled: ['codegraph'] };
    manifest.skills[0].targets = ['*'];
  });
  const acquired = await acquireProfile(context, { repository, ref: commit, expectedCommit: commit });
  assert.deepEqual(acquired.manifest.providers, { enabled: ['codegraph'] });
  assert.deepEqual(acquired.skills[0].targets, ['*']);
  assert.equal(Object.hasOwn(acquired.manifest.providers, 'targets'), false);
});

test('Profile store ownership directories are repaired to mode 0700', async (t) => {
  const { context, repository } = await fixture(t);
  if (process.platform === 'win32') return;

  await writeProfile(repository);
  const acquired = await acquireProfile(context, { repository, ref: 'HEAD' });
  const repositoryCache = path.dirname(acquired.root);
  await Promise.all([
    fs.chmod(context.profileStoreDir, 0o755),
    fs.chmod(repositoryCache, 0o755),
  ]);

  await acquireProfile(context, { repository, ref: 'HEAD' });
  const [store, cache] = await Promise.all([
    fs.stat(context.profileStoreDir),
    fs.stat(repositoryCache),
  ]);
  assert.equal(store.mode & 0o777, 0o700);
  assert.equal(cache.mode & 0o777, 0o700);
});

test('an active locked Profile loads from cache while its source is offline', async (t) => {
  const { context, repository, temporary } = await fixture(t);
  await writeProfile(repository);
  const acquired = await acquireProfile(context, { repository, ref: 'HEAD' });
  await saveProfileDescriptor(context, acquired.descriptor);
  await fs.rename(repository, path.join(temporary, 'source-offline'));

  const active = await loadActiveProfile(context);
  assert.equal(active.lockedCommit, acquired.lockedCommit);
  assert.equal(active.root, acquired.root);
});

test('a missing cache is replenished by locked commit rather than the moving ref', async (t) => {
  const { context, repository } = await fixture(t);
  await writeProfile(repository);
  const acquired = await acquireProfile(context, { repository, ref: 'HEAD' });
  await saveProfileDescriptor(context, acquired.descriptor);
  await fs.rm(acquired.root, { recursive: true, force: true });

  await fs.writeFile(path.join(repository, 'README.md'), 'new moving-ref content\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '--quiet', '-m', 'Move HEAD');

  const active = await loadActiveProfile(context);
  assert.equal(active.lockedCommit, acquired.lockedCommit);
  assert.equal(active.descriptor.ref, 'HEAD');
});

test('malformed descriptors fail closed', async (t) => {
  const { context, repository } = await fixture(t);
  await fs.mkdir(path.dirname(context.profileConfigPath), { recursive: true });
  const invalid = [
    { schemaVersion: 2, repository, ref: 'HEAD', lockedCommit: 'a'.repeat(40) },
    { schemaVersion: 1, repository, ref: 'HEAD', lockedCommit: 'short' },
    {
      schemaVersion: 1,
      repository: 'https://token@example.com/private.git',
      ref: 'HEAD',
      lockedCommit: 'a'.repeat(40),
    },
    {
      schemaVersion: 1,
      repository,
      ref: 'HEAD',
      lockedCommit: 'a'.repeat(40),
      unexpected: true,
    },
  ];
  for (const descriptor of invalid) {
    await fs.writeFile(context.profileConfigPath, JSON.stringify(descriptor));
    await assert.rejects(
      loadProfileDescriptor(context),
      (error) => ['PROFILE_DESCRIPTOR_INVALID', 'PROFILE_REPOSITORY_INVALID'].includes(error.code),
    );
  }
});

test('invalid Profile manifests, paths, links, and digests are rejected', async (t) => {
  const cases = [
    {
      name: 'schema',
      mutate: async ({ manifest }) => { manifest.unexpected = true; },
      code: 'PROFILE_MANIFEST_INVALID',
    },
    {
      name: 'path',
      mutate: async ({ manifest }) => { manifest.skills[0].path = 'skills/../personal-environment'; },
      code: 'PROFILE_MANIFEST_INVALID',
    },
    {
      name: 'targets',
      mutate: async ({ manifest }) => { manifest.skills[0].targets = ['codex', 'codex']; },
      code: 'PROFILE_MANIFEST_INVALID',
    },
    {
      name: 'symlink',
      mutate: async ({ repository, skillRoot }) => {
        await fs.writeFile(path.join(repository, 'outside.md'), 'outside\n');
        await fs.rm(path.join(skillRoot, 'SKILL.md'));
        await fs.symlink('../../outside.md', path.join(skillRoot, 'SKILL.md'));
      },
      code: 'PROFILE_CONTENT_INVALID',
    },
    {
      name: 'digest',
      mutate: async ({ manifest }) => { manifest.skills[0].contentSha256 = '0'.repeat(64); },
      code: 'PROFILE_DIGEST_MISMATCH',
    },
  ];

  for (const profileCase of cases) {
    await t.test(profileCase.name, async (subtest) => {
      const value = await fixture(subtest);
      await writeProfile(value.repository, profileCase.mutate);
      await assert.rejects(
        acquireProfile(value.context, { repository: value.repository, ref: 'HEAD' }),
        (error) => error.code === profileCase.code,
      );
    });
  }
});

test('Profile root accepts only its manifest, declared content, and safe metadata', async (t) => {
  await t.test('AGENTS, README, and license metadata are allowed', async (subtest) => {
    const { context, repository } = await fixture(subtest);
    await writeProfile(repository, async ({ repository: root }) => {
      await Promise.all([
        fs.writeFile(path.join(root, 'AGENTS.md'), '# Profile contract\n'),
        fs.writeFile(path.join(root, 'README.md'), '# Private profile\n'),
        fs.writeFile(path.join(root, 'LICENSE'), 'license text\n'),
        fs.writeFile(path.join(root, 'LICENSE.md'), 'license notes\n'),
      ]);
    });
    await acquireProfile(context, { repository, ref: 'HEAD' });
  });

  const rejected = [
    {
      name: 'unknown root file',
      mutate: async ({ repository }) => {
        await fs.writeFile(path.join(repository, 'notes.txt'), 'not declarative\n');
      },
    },
    {
      name: 'unknown root directory',
      mutate: async ({ repository }) => {
        await fs.mkdir(path.join(repository, 'extras'));
        await fs.writeFile(path.join(repository, 'extras/value.txt'), 'not declarative\n');
      },
    },
    {
      name: 'root metadata symlink',
      mutate: async ({ repository }) => {
        await fs.symlink('pac-profile.json', path.join(repository, 'README.md'));
      },
    },
    {
      name: 'nested catalog object',
      mutate: async ({ repository }) => {
        await fs.mkdir(path.join(repository, 'catalog/nested'), { recursive: true });
        await fs.writeFile(path.join(repository, 'catalog/nested/value.txt'), '{}\n');
      },
    },
  ];

  for (const profileCase of rejected) {
    await t.test(profileCase.name, async (subtest) => {
      const { context, repository } = await fixture(subtest);
      await writeProfile(repository, profileCase.mutate);
      await assert.rejects(
        acquireProfile(context, { repository, ref: 'HEAD' }),
        (error) => error.code === 'PROFILE_CONTENT_INVALID',
      );
    });
  }
});

test('acquisition rejects a moving ref that no longer matches the expected commit', async (t) => {
  const { context, repository } = await fixture(t);
  const expectedCommit = await writeProfile(repository);
  await fs.writeFile(path.join(repository, 'README.md'), 'second commit\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '--quiet', '-m', 'Move ref');

  await assert.rejects(
    acquireProfile(context, { repository, ref: 'HEAD', expectedCommit }),
    (error) => error.code === 'PROFILE_COMMIT_MISMATCH',
  );
});

test('repository locators and refs reject unsafe transport forms', async (t) => {
  const { context } = await fixture(t);
  const values = [
    { repository: 'git://example.com/profile.git', ref: 'HEAD', code: 'PROFILE_REPOSITORY_INVALID' },
    { repository: 'https://user:secret@example.com/profile.git', ref: 'HEAD', code: 'PROFILE_REPOSITORY_INVALID' },
    { repository: 'ssh://git@example.com/profile.git\nnext', ref: 'HEAD', code: 'PROFILE_REPOSITORY_INVALID' },
    { repository: 'https://example.com/profile.git?token=secret', ref: 'HEAD', code: 'PROFILE_REPOSITORY_INVALID' },
    { repository: 'ssh://git@example.com/profile.git#main', ref: 'HEAD', code: 'PROFILE_REPOSITORY_INVALID' },
    { repository: 'git@example.com:owner/profile.git', ref: '--upload-pack=x', code: 'PROFILE_REF_INVALID' },
    { repository: 'git@example.com:owner/profile.git', ref: 'main:refs/heads/other', code: 'PROFILE_REF_INVALID' },
    { repository: 'git@example.com:owner/profile.git', ref: 'release/*', code: 'PROFILE_REF_INVALID' },
    { repository: 'git@example.com:owner/profile.git', ref: 'release.lock', code: 'PROFILE_REF_INVALID' },
    { repository: 'git@example.com:owner/profile.git', ref: 'HEAD~1', code: 'PROFILE_REF_INVALID' },
    { repository: 'git@example.com:owner/profile.git', ref: 'HEAD^', code: 'PROFILE_REF_INVALID' },
  ];
  for (const value of values) {
    await assert.rejects(
      acquireProfile(context, value),
      (error) => error.code === value.code,
    );
  }
});
