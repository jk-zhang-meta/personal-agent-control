import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashDirectory } from '../src/profile.mjs';
import { policyStatus, synchronizePolicy } from '../src/policy-deployment.mjs';

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pac-policy-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home');
  const root = path.join(temporary, 'core');
  const repository = path.join(temporary, 'profile');
  await Promise.all([home, root, repository].map((p) => fs.mkdir(p)));
  const files = {
    'catalog/capabilities.jsonl': '',
    'catalog/taxonomy.json': '{}\n',
    'payload/skills/capability-resolver/SKILL.md': '---\nname: capability-resolver\ndescription: fixture\n---\n',
    'payload/skills/graph-workflow/SKILL.md': '---\nname: graph-workflow\ndescription: fixture\n---\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await fs.writeFile(path.join(root, 'catalog/files.sha256'), Object.entries(files)
    .map(([name, content]) => `${sha(content)}  ${name}\n`).join(''));
  for (const [host, name] of [['codex', 'AGENTS.md'], ['claude', 'CLAUDE.md']]) {
    await fs.mkdir(path.join(root, 'generated', host), { recursive: true });
    await fs.writeFile(path.join(root, 'generated', host, name), '# Shared kernel\n');
  }
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'PAC Tests');
  git('config', 'user.email', 'pac-tests@example.invalid');
  git('config', 'core.autocrlf', 'false');
  const commit = async (version) => {
    const skill = path.join(repository, 'skills/personal-environment');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), `---\nname: personal-environment\ndescription: fixture\n---\nVersion ${version}\n`);
    await fs.writeFile(path.join(repository, 'bootstrap.md'), `# Bootstrap ${version}\n`);
    await fs.writeFile(path.join(repository, 'pac-profile.json'), JSON.stringify({
      schemaVersion: 2, bootstrap: 'bootstrap.md',
      skills: [{ name: 'personal-environment', path: 'skills/personal-environment',
        contentSha256: await hashDirectory(skill), targets: ['codex', 'claude'] }],
      plugins: { enabled: [], disabled: [] },
    }));
    git('add', '.');
    git('commit', '--quiet', '-m', `Fixture ${version}`);
    return git('rev-parse', 'HEAD');
  };
  return { home, root, repository, commit, context: { home, root,
    stateDir: path.join(home, '.local/state/personal-agent-control') } };
}

test('policy delivery upgrades verified files, preserves unrelated state and detects drift', async (t) => {
  const f = await fixture(t);
  const first = await f.commit(1);
  const options = { repository: f.repository, baseline: first, commit: first };
  const unrelated = path.join(f.home, '.claude/settings.json');
  await fs.mkdir(path.dirname(unrelated));
  await fs.writeFile(unrelated, '{"customPreference":true}\n');
  const installed = await synchronizePolicy(f.context, options);
  assert.equal(installed.ok, true);
  assert.equal((await policyStatus(f.context)).ok, true);
  const second = await f.commit(2);
  const upgraded = await synchronizePolicy(f.context, { ...options, commit: second });
  assert.equal(upgraded.ok, true);
  assert.equal(await fs.readFile(unrelated, 'utf8'), '{"customPreference":true}\n');
  for (const host of ['.agents', '.codex', '.claude', '.grok', '.gemini/antigravity-cli', '.gemini/config']) {
    assert.match(await fs.readFile(path.join(f.home, host, 'skills/personal-environment/SKILL.md'), 'utf8'), /Version 2/);
  }
  assert.match(await fs.readFile(path.join(upgraded.backup, 'journal.json'), 'utf8'), /"moved": true/);
  assert.equal((await synchronizePolicy(f.context, { ...options, commit: second })).changed, 0);
  await fs.writeFile(path.join(f.home, '.agents/skills/personal-environment/SKILL.md'), 'User change\n');
  await assert.rejects(synchronizePolicy(f.context, { ...options, commit: second }), { code: 'POLICY_DRIFT' });
  assert.equal((await policyStatus(f.context)).ok, false);
});

test('policy delivery rolls back after a later replacement fails', async (t) => {
  const f = await fixture(t);
  const first = await f.commit(1);
  const options = { repository: f.repository, baseline: first, commit: first };
  await synchronizePolicy(f.context, options);
  const before = await policyStatus(f.context);
  const second = await f.commit(2);
  const target = path.join(f.home, '.config/personal-agent-control/profile-bootstrap.md');
  const rename = fs.rename;
  let injected = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!injected && to === target && path.basename(from).startsWith('.pac-policy-')) {
      injected = true;
      throw Object.assign(new Error('fixture replacement failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(synchronizePolicy(f.context, { ...options, commit: second }), { code: 'EIO' });
  assert.equal(injected, true);
  assert.match(await fs.readFile(target, 'utf8'), /Bootstrap 1/);
  assert.deepEqual(await policyStatus(f.context), before);
});

test('policy delivery refuses a destination with a symlinked ancestor', async (t) => {
  const f = await fixture(t);
  const first = await f.commit(1);
  const outside = path.join(f.root, 'unrelated');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.home, '.gemini'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(synchronizePolicy(f.context, { repository: f.repository,
    baseline: first, commit: first }), { code: 'PATH_UNSAFE' });
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.access(path.join(f.home, '.config/personal-agent-control/profile-bootstrap.md')));
});

test('policy delivery accepts a compatibility Skill root that aliases the exact neutral store', async (t) => {
  const f = await fixture(t);
  const first = await f.commit(1);
  const neutral = path.join(f.home, '.local/share/agent-skills/.agents/skills');
  const alias = path.join(f.home, '.gemini/config/skills');
  await fs.mkdir(neutral, { recursive: true });
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.symlink(neutral, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await fs.realpath(alias);
  const installed = await synchronizePolicy(f.context, { repository: f.repository,
    baseline: first, commit: first });
  assert.equal(installed.ok, true);
  assert.equal(await fs.realpath(alias), before);
  assert.match(await fs.readFile(path.join(alias, 'personal-environment/SKILL.md'), 'utf8'), /Version 1/);
});
