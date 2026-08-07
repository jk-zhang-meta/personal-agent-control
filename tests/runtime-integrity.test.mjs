import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyRuntimeContent } from '../src/apm.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pac-runtime-test-'));
  const skill = path.join(root, '.agents/skills/demo');
  const content = '---\nname: demo\ndescription: fixture\n---\n';
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), content);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  writeFileSync(path.join(root, 'apm.lock.yaml'), `deployments:\n  agent-skills:\n    .agents/skills/demo/SKILL.md: sha256:${digest}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, skill };
}

test('runtime integrity accepts an exact regular-directory inventory', async (t) => {
  const value = fixture(t);
  assert.deepEqual(await verifyRuntimeContent(value.root), { files: 1, roots: 1 });
});

test('runtime integrity rejects a managed Skill root symlink', async (t) => {
  const value = fixture(t);
  const moved = path.join(value.root, 'moved-demo');
  renameSync(value.skill, moved);
  symlinkSync(moved, value.skill, 'dir');
  await assert.rejects(verifyRuntimeContent(value.root), /must be real directories/u);
});

test('runtime integrity rejects unexpected physical roots', async (t) => {
  const value = fixture(t);
  mkdirSync(path.join(value.root, '.agents/skills/unowned'));
  await assert.rejects(verifyRuntimeContent(value.root), (error) => {
    assert.equal(error.code, 'MANAGED_DRIFT');
    assert.deepEqual(error.details.unexpectedRoots, ['.agents/skills/unowned']);
    return true;
  });
});

test('runtime integrity rejects a symlinked deployment ancestor', async (t) => {
  const value = fixture(t);
  const moved = path.join(value.root, 'moved-agents');
  renameSync(path.join(value.root, '.agents'), moved);
  symlinkSync(moved, path.join(value.root, '.agents'), 'dir');
  await assert.rejects(verifyRuntimeContent(value.root), /must be a real directory/u);
});
