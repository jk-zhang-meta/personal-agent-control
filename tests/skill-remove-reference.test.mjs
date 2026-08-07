import assert from 'node:assert/strict';
import test from 'node:test';

import { removeSkillDependency } from '../src/commands.mjs';

const COMMIT = 'a'.repeat(40);
const SOURCE = 'example/skills/skills/demo-skill';
const SURVIVOR = 'other/repository/skills/other-skill#main';
const lock = {
  dependencies: [{
    name: 'demo-skill',
    repoUrl: 'example/skills',
    host: 'github.com',
    virtualPath: 'skills/demo-skill',
    resolvedCommit: COMMIT,
    localPath: null,
  }],
};

test('Skill name removal recovers manifest references independently of ref form', () => {
  for (const reference of [
    SOURCE,
    `${SOURCE}#main`,
    `${SOURCE}#v1.2.3`,
    `${SOURCE}#${COMMIT}`,
  ]) {
    assert.deepEqual(
      removeSkillDependency([reference, SURVIVOR], lock, 'demo-skill'),
      [SURVIVOR],
      reference,
    );
  }
});

test('repository identity recognizes APM shorthand, FQDN, HTTPS, and SSH forms', () => {
  const rootLock = {
    dependencies: [{
      name: 'root-skill',
      repoUrl: 'example/skills',
      host: 'github.com',
      virtualPath: null,
      resolvedCommit: COMMIT,
      localPath: null,
    }],
  };
  for (const reference of [
    'example/skills#main',
    'github.com/example/skills#v1.2.3',
    `https://github.com/example/skills.git#${COMMIT}`,
    'git@github.com:example/skills.git#main',
    'ssh://git@github.com/example/skills.git#main',
  ]) {
    assert.deepEqual(removeSkillDependency([reference, SURVIVOR], rootLock, 'root-skill'), [SURVIVOR]);
  }

  const equivalent = [
    'example/skills#main',
    'https://github.com/example/skills.git#v1.2.3',
  ];
  assert.throws(
    () => removeSkillDependency(equivalent, rootLock, 'root-skill'),
    (error) => error.code === 'SKILL_REFERENCE_AMBIGUOUS',
  );
  assert.throws(
    () => removeSkillDependency(['gitlab.com/example/skills#main'], rootLock, 'root-skill'),
    (error) => error.code === 'SKILL_UNKNOWN',
  );
  assert.throws(
    () => removeSkillDependency(['example/skills/skills/Demo-skill#main'], lock, 'demo-skill'),
    (error) => error.code === 'SKILL_UNKNOWN',
  );
});

test('ambiguous Skill name removal requires one exact manifest reference', () => {
  const branch = `${SOURCE}#main`;
  const tag = `${SOURCE}#v1.2.3`;
  const dependencies = [branch, tag, SURVIVOR];

  assert.throws(
    () => removeSkillDependency(dependencies, lock, 'demo-skill'),
    (error) => error.code === 'SKILL_REFERENCE_AMBIGUOUS'
      && /full dependency reference/u.test(error.message)
      && error.details.references.join('\n') === `${branch}\n${tag}`,
  );
  assert.deepEqual(removeSkillDependency(dependencies, lock, branch), [tag, SURVIVOR]);
});

test('local-path and unknown Skill removal behavior is preserved', () => {
  const local = '/private/profile/skills/local-skill';
  const localLock = {
    dependencies: [{
      name: 'local-skill',
      repoUrl: '_local/local-skill',
      virtualPath: null,
      resolvedCommit: null,
      localPath: local,
    }],
  };

  assert.deepEqual(removeSkillDependency([local, SURVIVOR], localLock, 'local-skill'), [SURVIVOR]);
  assert.throws(
    () => removeSkillDependency([SURVIVOR], lock, 'missing-skill'),
    (error) => error.code === 'SKILL_UNKNOWN',
  );
});
