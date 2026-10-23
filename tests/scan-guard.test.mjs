import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookDecision, inspectCommand, hookFailure } from '../src/scan-guard-policy.mjs';
import { reconcileScanGuard, scanGuardStatus, scanGuardManagedPaths, hasPriorScanGuardState } from '../src/scan-guard.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-retire-hooks-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, root: home, stateDir: path.join(home, '.local/state/personal-agent-control') };
}

async function put(context, relative, content) {
  const file = path.join(context.home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

const pac = { type: 'command', command: 'node scan-guard-hook.mjs --pac-scan-guard-v2' };
const other = { type: 'command', command: 'preserve-plugin-hook' };
const selected = { skills: [{ name: 'resource-guard' }, { name: 'workspace-locator' }] };

test('retired policy never inspects or blocks research tools, including malformed input', () => {
  for (const input of [null, {}, { tool_name: 'Bash', tool_input: { command: 'find / -name paper.pdf' } },
    { tool_name: 'mcp__context_mode__ctx_execute', tool_input: { code: 'runResearch()' } }]) {
    assert.equal(hookDecision(input, { mode: 'strict' }), null);
    assert.equal(hookDecision(input, { mode: 'balanced' }), null);
  }
  assert.deepEqual(inspectCommand('arbitrary research command'), []);
  assert.deepEqual(hookFailure('missing helper or registry'), {});
  const result = spawnSync(process.execPath, [new URL('../src/scan-guard-policy.mjs', import.meta.url).pathname,
    '--hook', '--unknown-old-option'], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('apply never installs hooks even when both helpers or only one helper are selected', async (t) => {
  const context = await fixture(t);
  for (const profile of [selected, { skills: [{ name: 'resource-guard' }] }, null]) {
    const result = await reconcileScanGuard(context, ['codex', 'claude'], ['codex', 'claude'], profile);
    assert.deepEqual(result.hosts.map((entry) => entry.action), ['absent', 'absent']);
    assert.equal((await scanGuardStatus(context, ['codex', 'claude'], ['codex', 'claude'], profile))
      .every((entry) => entry.valid && entry.state === 'inactive'), true);
  }
  assert.deepEqual(await fs.readdir(context.home), []);
});

test('retire PAC handlers in current and legacy configs, preserve plugin hooks and host settings', async (t) => {
  const context = await fixture(t);
  const toml = '[features]\nhooks = true\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n'
    + '[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node --pac-scan-guard-v2"\n\n'
    + '[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "preserve-plugin-hook"\n\n'
    + '[host_settings]\nkeep = "yes"\n';
  const codex = await put(context, '.codex/config.toml', toml);
  const settings = { permissions: { keep: true }, hooks: { SessionStart: [{ hooks: [other] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [pac, other] }, { matcher: 'Read', hooks: [pac] }] } };
  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    await put(context, relative, JSON.stringify(settings));
  }
  await put(context, '.local/state/personal-agent-control/scan-guard.json', JSON.stringify({
    schemaVersion: 4, hosts: { codex: { entrySha256: 'drifted' }, claude: { entrySha256: 'drifted' } },
    runtimeRelative: `.agent-work/runtime/pac/scan-guard-hook-${'a'.repeat(64)}.mjs`,
  }));
  assert.equal(await hasPriorScanGuardState(context, 'codex'), true);
  assert.equal(scanGuardManagedPaths(context).includes(`.agent-work/runtime/pac/scan-guard-hook-${'a'.repeat(64)}.mjs`), true);
  assert.equal((await scanGuardStatus(context, ['codex'], ['codex']))[0].state, 'pending-removal');
  const result = await reconcileScanGuard(context, ['codex', 'claude'], ['codex', 'claude'], selected);
  assert.deepEqual(result.hosts.map((entry) => entry.action), ['retired', 'retired']);
  const text = await fs.readFile(codex, 'utf8');
  assert.doesNotMatch(text, /--pac-scan-guard/u);
  assert.match(text, /preserve-plugin-hook/u);
  assert.match(text, /\[host_settings\]\nkeep = "yes"/u);
  assert.equal((await fs.stat(codex)).mode & 0o777, 0o600);
  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(await fs.readFile(path.join(context.home, relative), 'utf8'));
    assert.deepEqual(config.permissions, settings.permissions);
    assert.deepEqual(config.hooks.SessionStart, settings.hooks.SessionStart);
    assert.deepEqual(config.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other] }]);
  }
  assert.equal(await hasPriorScanGuardState(context, 'codex'), false);
  const before = await fs.readFile(codex, 'utf8');
  await reconcileScanGuard(context, ['codex', 'claude'], ['codex', 'claude'], selected);
  assert.equal(await fs.readFile(codex, 'utf8'), before);
});

test('remove a standalone CRLF TOML gate without changing adjacent sections or unrelated hook groups', async (t) => {
  const context = await fixture(t);
  const prefix = '# user settings\r\nmodel = "keep"\r\n';
  const gate = '[[hooks.PreToolUse]]\r\nmatcher = "Bash"\r\n[[hooks.PreToolUse.hooks]]\r\ntype = "command"\r\ncommand_windows = "node --pac-scan-guard-v2"\r\n';
  const suffix = '[[hooks.PreToolUse]]\r\nmatcher = "Read"\r\n[[hooks.PreToolUse.hooks]]\r\ntype = "command"\r\ncommand = "preserve-plugin-hook"\r\n[permissions]\r\nkeep = true\r\n';
  const file = await put(context, '.codex/config.toml', prefix + gate + suffix);
  await reconcileScanGuard(context, ['codex'], ['codex'], selected);
  assert.equal(await fs.readFile(file, 'utf8'), prefix + suffix);
});

test('scoped retirement leaves the unselected host untouched', async (t) => {
  const context = await fixture(t);
  const text = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [pac] }] } });
  const file = await put(context, '.claude/settings.json', text);
  await reconcileScanGuard(context, ['codex'], ['codex'], selected);
  assert.equal(await fs.readFile(file, 'utf8'), text);
});

test('TOML hook examples in multiline instructions and marker comments remain byte-identical', async (t) => {
  const context = await fixture(t);
  for (const delimiter of ['"""', "'''"]) {
    const text = `developer_instructions = ${delimiter}\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ncommand = "echo --pac-scan-guard-v2"\n${delimiter}\nmodel = "keep-user-model"\n`
      + '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ncommand = "preserve-plugin-hook" # --pac-scan-guard-v2\n';
    const file = await put(context, '.codex/config.toml', text);
    await reconcileScanGuard(context, ['codex'], ['codex'], selected);
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
});

test('retire multiline TOML PAC commands while retaining adjacent plugin handlers', async (t) => {
  const context = await fixture(t);
  for (const delimiter of ['"""', "'''", '"', "'"]) {
    const command = delimiter.length === 3 ? `${delimiter}\nnode --pac-scan-guard-v2\n${delimiter}`
      : `${delimiter}node --pac-scan-guard-v2${delimiter}`;
    const prefix = '[[hooks.PreToolUse]]\nmatcher = "Bash"\n';
    const pacBlock = `[[hooks.PreToolUse.hooks]]\ncommand = ${command}\n`;
    const suffix = '[[hooks.PreToolUse.hooks]]\ncommand = "preserve-plugin-hook"\n[permissions]\nkeep = true\n';
    const file = await put(context, '.codex/config.toml', prefix + pacBlock + suffix);
    await reconcileScanGuard(context, ['codex'], ['codex'], selected);
    assert.equal(await fs.readFile(file, 'utf8'), prefix + suffix);
  }
});
