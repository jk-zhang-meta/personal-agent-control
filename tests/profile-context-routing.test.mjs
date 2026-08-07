import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { loadSourceModel } from '../payload/skills/capability-resolver/scripts/lib/catalog.mjs';
import {
  rebuildIndex,
  resolveCapabilities,
} from '../payload/skills/capability-resolver/scripts/lib/index.mjs';

const BODY_ONLY_SENTINEL = 'CONTEXT-BODY-ONLY-SENTINEL-7F4B';

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pac-profile-context-'));
  const repo = join(root, 'core');
  const profile = join(root, 'profile');
  const home = join(root, 'home');
  const skillRoot = join(home, '.local/share/agent-skills/.agents/skills');
  const dbPath = join(home, '.cache/personal-agent-control/capabilities-v1.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  write(join(repo, 'pac.json'), JSON.stringify({
    schemaVersion: 1,
    hosts: {
      codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
      claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
    },
    plugins: { enabled: [] },
  }));
  write(join(repo, 'catalog/taxonomy.json'), JSON.stringify({
    schemaVersion: 1,
    categories: [
      { id: 'root', parent: null, label: 'Capabilities' },
      { id: 'kind', parent: 'root', label: 'Kind' },
      { id: 'kind.context', parent: 'kind', label: 'Contexts' },
    ],
  }));
  write(join(repo, 'catalog/plugins.tsv'), '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility\n');
  write(join(repo, 'catalog/tools.tsv'), '# name\tversion\towner\tpurpose\tintegrity-or-lock\n');
  write(join(repo, 'catalog/capabilities.jsonl'), '');
  mkdirSync(skillRoot, { recursive: true });

  write(join(profile, 'pac-profile.json'), JSON.stringify({
    schemaVersion: 1,
    skills: [],
    plugins: { enabled: [] },
  }));
  const contextPath = join(profile, 'context/course-guide.md');
  write(contextPath, `# Private course guide\n\n${BODY_ONLY_SENTINEL}\n`);
  const contextRecord = {
    id: 'context:course-guide',
    name: 'course guide',
    kind: 'context',
    path: 'context/course-guide.md',
    summary: 'Private course administration reference.',
    aliases: ['teaching reference'],
    memberships: ['kind.context'],
    targets: ['codex', 'claude'],
  };
  write(join(profile, 'catalog/capabilities.jsonl'), `${JSON.stringify(contextRecord)}\n`);
  return { root, repo, profile, home, skillRoot, dbPath, contextPath, contextRecord };
}

test('Profile context routes by metadata and returns its exact load path without indexing body text', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);

  assert.equal(readFileSync(fixture.dbPath).includes(Buffer.from(BODY_ONLY_SENTINEL)), false);
  const bodyOnly = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: BODY_ONLY_SENTINEL },
  });
  assert.deepEqual(bodyOnly.results, []);

  const resolved = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'Use the private course administration reference' },
  });
  assert.equal(resolved.results[0]?.id, 'context:course-guide');
  assert.equal(resolved.results[0]?.kind, 'context');
  assert.equal(resolved.results[0]?.path, fixture.contextPath);
  assert.equal(resolved.results[0]?.resource, fixture.contextPath);
  assert.deepEqual(resolved.results[0]?.activation, {
    type: 'read-context',
    path: fixture.contextPath,
    policy: 'automatic',
  });

  const excluded = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'course administration', kinds: ['skill'] },
  });
  assert.deepEqual(excluded.results, []);
  const included = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'course administration', kinds: ['context'] },
  });
  assert.equal(included.results[0]?.id, 'context:course-guide');
});

test('Profile context rejects paths outside the Profile and non-regular Markdown paths', (t) => {
  const cases = [
    {
      label: 'absolute',
      path: '/tmp/outside.md',
      pattern: /path must be relative/iu,
    },
    {
      label: 'escape',
      path: '../outside.md',
      pattern: /must not escape/iu,
    },
    {
      label: 'non-Markdown',
      path: 'context/course-guide.txt',
      prepare: (fixture) => write(join(fixture.profile, 'context/course-guide.txt'), 'text'),
      pattern: /Markdown file/iu,
    },
    {
      label: 'symlink',
      path: 'context/link.md',
      prepare: (fixture) => symlinkSync(fixture.contextPath, join(fixture.profile, 'context/link.md')),
      pattern: /must not contain symlinks/iu,
    },
  ];

  for (const scenario of cases) {
    const fixture = createFixture(t);
    scenario.prepare?.(fixture);
    const overlay = join(fixture.profile, 'catalog/capabilities.jsonl');
    write(overlay, `${JSON.stringify({ ...fixture.contextRecord, path: scenario.path })}\n`);
    assert.throws(() => loadSourceModel({
      repo: fixture.repo,
      profile: fixture.profile,
      home: fixture.home,
      skillRoot: fixture.skillRoot,
    }), scenario.pattern, scenario.label);
  }
});
