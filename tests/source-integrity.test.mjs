import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyCanonicalPayload } from '../src/integrity.mjs';

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pac-source-test-'));
  const files = {
    'payload/skills/demo/SKILL.md': '---\nname: demo\ndescription: fixture\n---\n',
    'catalog/capabilities.jsonl': '{"id":"skill:demo"}\n',
    'catalog/taxonomy.json': '{}\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  writeFileSync(path.join(root, 'catalog/files.sha256'), `${Object.entries(files)
    .map(([relative, content]) => `${sha(content)}  ${relative}`).join('\n')}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root };
}

test('canonical payload integrity enforces exact files and digests', async (t) => {
  const value = fixture(t);
  assert.equal((await verifyCanonicalPayload(value)).files, 3);
  writeFileSync(path.join(value.root, 'payload/skills/demo/extra.md'), 'not declared\n');
  await assert.rejects(verifyCanonicalPayload(value), (error) => {
    assert.equal(error.code, 'SOURCE_INTEGRITY_INVALID');
    assert.deepEqual(error.details.added, ['payload/skills/demo/extra.md']);
    return true;
  });
});

test('canonical payload integrity rejects tampering and symlinks', async (t) => {
  const value = fixture(t);
  const skill = path.join(value.root, 'payload/skills/demo/SKILL.md');
  writeFileSync(skill, 'tampered\n');
  await assert.rejects(verifyCanonicalPayload(value), /differs from its reviewed digest/u);

  rmSync(skill);
  symlinkSync(path.join(value.root, 'catalog/taxonomy.json'), skill);
  await assert.rejects(verifyCanonicalPayload(value), /unsupported or symlinked entry/u);
});

test('canonical payload integrity rejects a symlinked Skill payload root', async (t) => {
  const value = fixture(t);
  const skills = path.join(value.root, 'payload/skills');
  const external = path.join(value.root, 'external-skills');
  renameSync(skills, external);
  symlinkSync(external, skills, 'dir');
  await assert.rejects(verifyCanonicalPayload(value), (error) => error.code === 'SOURCE_INTEGRITY_INVALID');
});

test('canonical payload integrity rejects a symlinked catalog root', async (t) => {
  const value = fixture(t);
  const catalog = path.join(value.root, 'catalog');
  const external = path.join(value.root, 'external-catalog');
  renameSync(catalog, external);
  symlinkSync(external, catalog, 'dir');
  await assert.rejects(verifyCanonicalPayload(value), (error) => error.code === 'SOURCE_INTEGRITY_INVALID');
});
