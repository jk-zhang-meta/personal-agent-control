import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isKnownRuntimeMutation } from '../src/plugin-source-state.mjs';

const PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';

function git(directory, args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-plugin-state-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), `${JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    mcpServers: {
      fixture: { command: 'node', args: [`${PLACEHOLDER}/start.mjs`] },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'hooks/hooks.json'), `${JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{
        type: 'command', command: `node "${PLACEHOLDER}/hooks/sessionstart.mjs"`,
      }] }],
    },
  }, null, 2)}\n`);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'pac-test@example.invalid']);
  git(root, ['config', 'user.name', 'PAC test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function normalizedFixture(root) {
  const absolute = root.replaceAll('\\', '/');
  const pluginPath = path.join(root, '.claude-plugin/plugin.json');
  const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
  plugin.mcpServers.fixture.command = '/usr/bin/node';
  plugin.mcpServers.fixture.args[0] = `${absolute}/start.mjs`;
  fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2));

  const hooksPath = path.join(root, 'hooks/hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  hooks.hooks.SessionStart[0].hooks[0].command =
    `"/usr/bin/node" "${absolute}/hooks/sessionstart.mjs"`;
  fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
}

test('clean pinned Plugin source is not classified as runtime mutation', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(isKnownRuntimeMutation(root), false);
});

test('accepts only the exact native manifest normalization', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  normalizedFixture(root);
  assert.equal(isKnownRuntimeMutation(root), true);
});

test('rejects semantic edits, index changes, and untracked files', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginPath = path.join(root, '.claude-plugin/plugin.json');
  const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
  plugin.version = '9.9.9';
  fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2));
  assert.equal(isKnownRuntimeMutation(root), false);

  fs.writeFileSync(path.join(root, 'untracked.txt'), 'not allowed\n');
  assert.equal(isKnownRuntimeMutation(root), false);

  git(root, ['restore', '.']);
  fs.rmSync(path.join(root, 'untracked.txt'), { force: true });
  const staged = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
  staged.mcpServers.fixture.command = '/usr/bin/node';
  staged.mcpServers.fixture.args[0] = `${root.replaceAll('\\', '/')}/start.mjs`;
  fs.writeFileSync(pluginPath, JSON.stringify(staged, null, 2));
  git(root, ['add', pluginPath]);
  assert.equal(isKnownRuntimeMutation(root), false);
});
