import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { assertSafeManagedPath } from '../src/path-safety.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pac-path-test-')));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home,
    repo,
    context: {
      root: repo,
      home,
      stateDir: path.join(home, '.local/state/personal-agent-control'),
      configPath: path.join(repo, 'pac.json'),
    },
  };
}

function validConfig() {
  return {
    schemaVersion: 1,
    neutralSkillStore: '~/.local/share/agent-skills',
    hosts: {
      codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
      claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
    },
    plugins: { enabled: [] },
  };
}

test('managed paths must stay below a real HOME without symlink ancestors', async (t) => {
  const value = fixture(t);
  await assert.doesNotReject(assertSafeManagedPath(value.home, path.join(value.home, '.agents/skills'), 'test'));
  await assert.rejects(assertSafeManagedPath(value.home, value.root, 'test'), /must be below HOME/u);

  mkdirSync(path.join(value.home, 'real'));
  symlinkSync(path.join(value.home, 'real'), path.join(value.home, 'redirect'));
  await assert.rejects(
    assertSafeManagedPath(value.home, path.join(value.home, 'redirect/skills'), 'test'),
    /symlink or non-directory component/u,
  );
});

test('configuration rejects alternate stores and host directories', async (t) => {
  const value = fixture(t);
  const config = validConfig();
  config.neutralSkillStore = '/tmp/shared-skills';
  writeFileSync(value.context.configPath, JSON.stringify(config));
  await assert.rejects(loadConfig(value.context), /neutralSkillStore must remain/u);

  config.neutralSkillStore = '~/.local/share/agent-skills';
  config.hosts.claude.skillsDirectory = '~/.other/skills';
  writeFileSync(value.context.configPath, JSON.stringify(config));
  await assert.rejects(loadConfig(value.context), /claude\.skillsDirectory must remain/u);
});

test('configuration parsing defers host-path checks to the active operation scope', async (t) => {
  const value = fixture(t);
  mkdirSync(path.join(value.home, 'shared'));
  symlinkSync(path.join(value.home, 'shared'), path.join(value.home, '.agents'));
  writeFileSync(value.context.configPath, JSON.stringify(validConfig()));
  await assert.doesNotReject(loadConfig(value.context));
  await assert.rejects(
    assertSafeManagedPath(value.home, path.join(value.home, '.agents/skills'), 'active Codex Skill directory'),
    /symlink or non-directory component/u,
  );
});
