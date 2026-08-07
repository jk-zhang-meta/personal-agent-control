import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLock } from '../src/state.mjs';

function context(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pac-lock-test-')));
  const home = path.join(root, 'home');
  const stateDir = path.join(home, '.local/state/personal-agent-control');
  mkdirSync(home);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { home, stateDir };
}

test('only one contender acquires the PAC mutation lock', async (t) => {
  const value = context(t);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const results = await Promise.allSettled([acquireLock(value), acquireLock(value)]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason.code, 'PAC_LOCKED');
    await results.find(({ status }) => status === 'fulfilled').value();
    assert.equal(existsSync(path.join(value.stateDir, 'pac.lock')), false);
  }
});

test('stale locks fail closed and remain available for explicit recovery', async (t) => {
  const value = context(t);
  const lockDir = path.join(value.stateDir, 'pac.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ token: 'old', pid: 2147483647 }));
  await assert.rejects(acquireLock(value), (error) => error.code === 'PAC_LOCK_STALE');
  assert.equal(existsSync(lockDir), true);
});

test('one exact Chezmoi child borrows the outer lock while ordinary contenders remain blocked', async (t) => {
  const value = context(t);
  const token = 'OuterToken123';
  const backup = path.join(value.home, '.agent-work/backups/personal-agent-control/snapshot');
  const marker = path.join(value.stateDir, `chezmoi-transaction-${process.pid}`);
  const markerText = `${backup}\n${token}\n`;
  const lockDir = path.join(value.stateDir, 'pac.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    token, pid: process.pid, kind: 'chezmoi-outer',
  }));
  writeFileSync(marker, markerText);
  const outerTransaction = {
    backup, marker, markerText, token, ownerPid: process.pid,
  };

  const releaseBorrowed = await acquireLock(value, { outerTransaction });
  await assert.rejects(acquireLock(value), (error) => error.code === 'PAC_LOCKED');
  await releaseBorrowed();
  assert.equal(existsSync(lockDir), true);
  await assert.rejects(
    acquireLock(value, { outerTransaction }),
    (error) => error.code === 'PAC_CHEZMOI_TRANSACTION_USED',
  );
  assert.equal(existsSync(lockDir), true);
});

test('an orphan Chezmoi transaction marker fails closed before a new PAC lock', async (t) => {
  const value = context(t);
  mkdirSync(value.stateDir, { recursive: true });
  writeFileSync(path.join(value.stateDir, 'chezmoi-transaction-1234'), 'orphan\ntoken\n');
  await assert.rejects(acquireLock(value), (error) => error.code === 'PAC_LOCK_STALE');
  assert.equal(existsSync(path.join(value.stateDir, 'pac.lock')), false);
});
