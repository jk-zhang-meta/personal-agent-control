import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hostAdapterStatus, reconcileHostAdapters } from '../src/host-adapters.mjs';
import { composeInstructions } from '../src/instruction-composition.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = '# Personal bootstrap\n\n- A private rule.\n';

async function fixture(t, { bootstrap }) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pac-composition-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const context = { root: repo, home, stateDir: path.join(home, '.local/state/personal-agent-control') };
  const kernel = await fs.readFile(path.join(repo, 'generated/codex/AGENTS.md'));
  const target = path.join(home, '.codex/AGENTS.md');
  await fs.mkdir(path.join(home, '.codex/agents'), { recursive: true });
  await fs.mkdir(path.join(home, '.config/personal-agent-control'), { recursive: true });
  // The outer Chezmoi transaction renders the adapter before a Profile exists.
  await fs.writeFile(target, kernel);
  await fs.copyFile(
    path.join(repo, 'generated/codex/agents/independent-reviewer.toml'),
    path.join(home, '.codex/agents/independent-reviewer.toml'),
  );
  if (bootstrap !== null) {
    await fs.writeFile(path.join(home, '.config/personal-agent-control/profile-bootstrap.md'), bootstrap);
  }
  const priorMode = process.env.PAC_HOST_ADAPTER_MODE;
  process.env.PAC_HOST_ADAPTER_MODE = 'adopt';
  t.after(() => {
    if (priorMode === undefined) delete process.env.PAC_HOST_ADAPTER_MODE;
    else process.env.PAC_HOST_ADAPTER_MODE = priorMode;
  });
  return { context, kernel, target };
}

test('composition is the kernel, one newline, then the bootstrap', () => {
  assert.equal(composeInstructions('kernel\n', '# Profile\n').toString(), 'kernel\n\n# Profile\n');
  assert.equal(composeInstructions('kernel\n', null).toString(), 'kernel\n');
});

test('an adopted instruction file gains the installed Profile bootstrap', async (t) => {
  const f = await fixture(t, { bootstrap: BOOTSTRAP });
  await reconcileHostAdapters(f.context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(f.target), composeInstructions(f.kernel, BOOTSTRAP));
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o600);
  const status = await hostAdapterStatus(f.context, ['codex'], ['codex']);
  assert.equal(status.every((entry) => entry.valid), true);
  assert.equal(status.some((entry) => 'content' in entry), false);
});

test('a host without a Profile keeps the bare kernel', async (t) => {
  const f = await fixture(t, { bootstrap: null });
  await reconcileHostAdapters(f.context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(f.target), f.kernel);
  assert.equal((await hostAdapterStatus(f.context, ['codex'], ['codex'])).every((entry) => entry.valid), true);
});

test('a modified instruction file is never completed over user content', async (t) => {
  const f = await fixture(t, { bootstrap: BOOTSTRAP });
  await fs.writeFile(f.target, 'user drift\n');
  await assert.rejects(reconcileHostAdapters(f.context, ['codex'], ['codex']), { code: 'HOST_ADAPTER_INVALID' });
  assert.equal(await fs.readFile(f.target, 'utf8'), 'user drift\n');
});

test('status reports drift once the installed bootstrap changes', async (t) => {
  const f = await fixture(t, { bootstrap: BOOTSTRAP });
  await reconcileHostAdapters(f.context, ['codex'], ['codex']);
  await fs.writeFile(
    path.join(f.context.home, '.config/personal-agent-control/profile-bootstrap.md'),
    '# Personal bootstrap\n\n- A newer rule.\n',
  );
  const status = await hostAdapterStatus(f.context, ['codex'], ['codex']);
  assert.equal(status.find((entry) => entry.targetRelative === '.codex/AGENTS.md').valid, false);
});

async function realChezmoi() {
  const candidate = process.env.PAC_CHEZMOI || path.join(os.homedir(), '.local/bin/chezmoi');
  try { await fs.access(candidate, fs.constants.X_OK); return candidate; }
  catch { return null; }
}

test('Chezmoi renders, updates and protects the composed instruction file', async (t) => {
  const chezmoi = await realChezmoi();
  if (!chezmoi) return t.skip('Chezmoi is not installed');
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pac-composition-real-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const context = { root: repo, home, stateDir: path.join(home, '.local/state/personal-agent-control') };
  const kernel = await fs.readFile(path.join(repo, 'generated/codex/AGENTS.md'));
  const target = path.join(home, '.codex/AGENTS.md');
  const bootstrap = path.join(home, '.config/personal-agent-control/profile-bootstrap.md');
  await fs.mkdir(path.dirname(bootstrap), { recursive: true });
  await fs.mkdir(context.stateDir, { recursive: true });
  const prior = { mode: process.env.PAC_HOST_ADAPTER_MODE, chezmoi: process.env.PAC_CHEZMOI };
  delete process.env.PAC_HOST_ADAPTER_MODE;
  process.env.PAC_CHEZMOI = chezmoi;
  t.after(() => {
    for (const [name, value] of [['PAC_HOST_ADAPTER_MODE', prior.mode], ['PAC_CHEZMOI', prior.chezmoi]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  await reconcileHostAdapters(context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(target), kernel, 'no Profile: the bare kernel');

  await fs.writeFile(bootstrap, BOOTSTRAP);
  await reconcileHostAdapters(context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(target), composeInstructions(kernel, BOOTSTRAP), 'Profile added');

  const newer = '# Personal bootstrap\n\n- A newer rule.\n';
  await fs.writeFile(bootstrap, newer);
  await reconcileHostAdapters(context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(target), composeInstructions(kernel, newer), 'Profile updated');

  await fs.unlink(bootstrap);
  await reconcileHostAdapters(context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(target), kernel, 'Profile removed');

  await fs.writeFile(bootstrap, BOOTSTRAP);
  await fs.writeFile(target, 'user drift\n');
  await assert.rejects(reconcileHostAdapters(context, ['codex'], ['codex']));
  assert.equal(await fs.readFile(target, 'utf8'), 'user drift\n', 'user content is preserved');
});

test('Chezmoi replaces an instruction file that PAC completed outside it', async (t) => {
  const chezmoi = await realChezmoi();
  if (!chezmoi) return t.skip('Chezmoi is not installed');
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pac-composition-seed-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const context = { root: repo, home, stateDir: path.join(home, '.local/state/personal-agent-control') };
  const kernel = await fs.readFile(path.join(repo, 'generated/codex/AGENTS.md'));
  const target = path.join(home, '.codex/AGENTS.md');
  const bootstrap = path.join(home, '.config/personal-agent-control/profile-bootstrap.md');
  await fs.mkdir(path.dirname(bootstrap), { recursive: true });
  await fs.mkdir(context.stateDir, { recursive: true });
  const prior = { mode: process.env.PAC_HOST_ADAPTER_MODE, chezmoi: process.env.PAC_CHEZMOI };
  process.env.PAC_CHEZMOI = chezmoi;
  t.after(() => {
    for (const [name, value] of [['PAC_HOST_ADAPTER_MODE', prior.mode], ['PAC_CHEZMOI', prior.chezmoi]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // First installation: Chezmoi writes the bare kernel, then the nested
  // `pac apply` installs the bootstrap and completes the file itself.
  delete process.env.PAC_HOST_ADAPTER_MODE;
  await reconcileHostAdapters(context, ['codex'], ['codex']);
  await fs.writeFile(bootstrap, BOOTSTRAP);
  process.env.PAC_HOST_ADAPTER_MODE = 'adopt';
  await reconcileHostAdapters(context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(target), composeInstructions(kernel, BOOTSTRAP));

  // A later Profile update goes through Chezmoi, whose own record still
  // holds the bare kernel.
  const newer = '# Personal bootstrap\n\n- A newer rule.\n';
  await fs.writeFile(bootstrap, newer);
  delete process.env.PAC_HOST_ADAPTER_MODE;
  await reconcileHostAdapters(context, ['codex'], ['codex']);
  assert.deepEqual(await fs.readFile(target), composeInstructions(kernel, newer));
});
