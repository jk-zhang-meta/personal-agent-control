import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashDirectory } from '../src/profile.mjs';
import {
  applyProfileSkills, profileSkillEntries, profileSkillStatus, retireProfileSkills,
} from '../src/profile-skills.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-profile-skills-'));
  const home = path.join(root, 'home');
  const neutral = path.join(home, '.local/share/agent-skills');
  const source = path.join(root, 'profile/skills/personal-environment');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), [
    '---',
    'name: personal-environment',
    'description: Fixture personal environment.',
    '---',
    '',
    '# Personal environment',
    '',
  ].join('\n'));
  await fs.mkdir(home, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = {
    skills: [{
      name: 'personal-environment',
      root: source,
      contentSha256: await hashDirectory(source),
      targets: ['codex', 'claude'],
    }],
  };
  return { context: { home }, neutral, profile };
}

test('Profile Skills are materialized once and repaired only when PAC owns the target', async (t) => {
  const { context, neutral, profile } = await fixture(t);
  const installed = await applyProfileSkills(context, neutral, profile);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].valid, true);

  const target = path.join(neutral, '.agents/skills/personal-environment/SKILL.md');
  await fs.appendFile(target, '\ndrift\n');
  assert.equal((await profileSkillStatus(neutral, profile))[0].valid, false);
  await assert.rejects(
    applyProfileSkills(context, neutral, profile),
    (error) => error.code === 'SKILL_COLLISION',
  );

  const owned = new Map([['personal-environment', {
    id: 'personal-environment', physicalName: 'personal-environment', engine: 'profile',
  }]]);
  assert.equal((await applyProfileSkills(context, neutral, profile, owned))[0].valid, true);
});

test('Profile retirement removes only prior Profile-owned physical roots', async (t) => {
  const { context, neutral, profile } = await fixture(t);
  await applyProfileSkills(context, neutral, profile);
  const unrelated = path.join(neutral, '.agents/skills/unrelated');
  await fs.mkdir(unrelated, { recursive: true });
  await fs.writeFile(path.join(unrelated, 'SKILL.md'), 'unmanaged\n');
  const owned = new Map([['personal-environment', {
    id: 'personal-environment', physicalName: 'personal-environment', engine: 'profile',
  }]]);
  assert.deepEqual(await retireProfileSkills(context, neutral, owned, []), ['personal-environment']);
  await assert.rejects(fs.access(path.join(neutral, '.agents/skills/personal-environment')));
  await fs.access(unrelated);
});

test('Profile APM Skills preserve a physical directory name distinct from frontmatter identity', async (t) => {
  const { context, neutral, profile } = await fixture(t);
  profile.skills = [{
    ...profile.skills[0],
    name: 'vercel-composition-patterns',
    physicalName: 'composition-patterns',
    engine: 'profile-apm',
  }];

  assert.deepEqual(profileSkillEntries(profile).map(({ id, physicalName, engine }) => ({
    id, physicalName, engine,
  })), [{
    id: 'vercel-composition-patterns',
    physicalName: 'composition-patterns',
    engine: 'profile-apm',
  }]);
  const installed = await applyProfileSkills(context, neutral, profile);
  assert.equal(installed[0].physicalName, 'composition-patterns');
  await fs.access(path.join(neutral, '.agents/skills/composition-patterns/SKILL.md'));
  await assert.rejects(fs.access(path.join(neutral, '.agents/skills/vercel-composition-patterns')));
});
