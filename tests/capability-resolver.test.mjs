import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  loadSourceModel,
  validateRepositoryMetadata,
} from '../payload/skills/capability-resolver/scripts/lib/catalog.mjs';
import {
  SCHEMA_VERSION,
  browseCategory,
  checkIndex,
  rebuildIndex,
  resolveCapabilities,
} from '../payload/skills/capability-resolver/scripts/lib/index.mjs';

const secretSentinel = 'PRIVATE-REFERENCE-SENTINEL-DO-NOT-INDEX';

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeSkill(path, name, description) {
  write(path, `---\nname: ${name}\ndescription: >\n  ${description}\n---\n\n# ${name}\n\n${secretSentinel}\n`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function ids(result) {
  return result.results.map((item) => item.id);
}

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pac-resolver-test-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const skillStore = join(home, '.local/share/agent-skills/.agents/skills');
  const pluginStore = join(home, '.local/share/agent-plugins/sources/fixture-marketplace');
  const dbPath = join(home, '.cache/personal-agent-control/capabilities-v1.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  write(join(repo, 'catalog/plugins.tsv'), [
    '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility',
    `fixture-plugin\tfixture-marketplace\tgithub-tag\texample/plugin\tv1\t${'c'.repeat(40)}\t${'d'.repeat(40)}\t1.0.0\tcodex,claude\treview-final\tMIT\tcommon`,
    '',
  ].join('\n'));
  write(join(repo, 'pac.json'), JSON.stringify({
    schemaVersion: 1,
    hosts: {
      codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
      claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
    },
    plugins: { enabled: ['fixture-plugin'] },
  }, null, 2));
  write(join(repo, 'catalog/tools.tsv'), [
    '# name\tversion\towner\tpurpose\tintegrity-or-lock',
    'node\t24.18.0\tnodejs/node\truntime\tmise.lock',
    '',
  ].join('\n'));
  write(join(repo, 'catalog/taxonomy.json'), JSON.stringify({
    schemaVersion: 1,
    categories: [
      { id: 'root', parent: null, label: 'Capabilities' },
      { id: 'kind', parent: 'root', label: 'Kind' },
      { id: 'kind.skill', parent: 'kind', label: 'Skills' },
      { id: 'kind.subagent', parent: 'kind', label: 'Subagents' },
      { id: 'kind.provider', parent: 'kind', label: 'Providers' },
      { id: 'kind.provider.mcp-server', parent: 'kind.provider', label: 'MCP servers' },
      { id: 'kind.provider.plugin', parent: 'kind.provider', label: 'Plugins' },
      { id: 'domain', parent: 'root', label: 'Domain' },
      { id: 'domain.communication', parent: 'domain', label: 'Communication' },
      { id: 'domain.research', parent: 'domain', label: 'Research', description: 'Scholarly evidence and literature', aliases: ['论文', 'evidence'] },
      { id: 'domain.frontend', parent: 'domain', label: 'Frontend', description: 'React interface design', aliases: ['UI'] },
      { id: 'action', parent: 'root', label: 'Action' },
      { id: 'action.optimize', parent: 'action', label: 'Optimize' },
      { id: 'action.review', parent: 'action', label: 'Review', description: 'Audit and evaluate', aliases: ['audit'] },
      { id: 'artifact', parent: 'root', label: 'Artifact' },
      { id: 'artifact.response', parent: 'artifact', label: 'Response' },
    ],
  }, null, 2));
  write(join(repo, 'catalog/capabilities.jsonl'), [
    JSON.stringify({ id: 'skill:research-core', memberships: ['domain.research'], aliases: ['论文', '科研综述', '证据检索'], targets: ['codex', 'claude'], delivery: 'apm', visibility: 'common' }),
    JSON.stringify({ id: 'skill:frontend-helper', memberships: ['domain.frontend'], aliases: ['React UI'], targets: ['codex'], delivery: 'apm', visibility: 'common' }),
    JSON.stringify({ id: 'skill:first-verified-result', memberships: ['domain.research'], aliases: ['first verified result', 'validated metrics'], triggers: ['implement a research idea and run an experiment', 'resume a long computation until result artifacts are verified'], antiTriggers: ['literature-only research', 'submit a job without requesting results', 'give me the stable run reference only'], targets: ['codex', 'claude'], delivery: 'profile', visibility: 'private' }),
    JSON.stringify({ id: 'skill:graph-workflow', memberships: ['domain.research'], aliases: ['dependency graph', 'durable agent workflow'], triggers: ['coordinate dependency fan-out and fan-in', 'persist automatic workflow control across a host or process restart'], antiTriggers: ['one critical path', 'single scheduler-owned long experiment'], targets: ['codex', 'claude'], delivery: 'apm', visibility: 'common' }),
    JSON.stringify({ id: 'skill:i-have-adhd', memberships: ['domain.communication', 'action.optimize', 'artifact.response'], aliases: ['focus mode', 'ADHD-friendly response', 'concise action mode'], triggers: ['explicitly use i-have-adhd'], antiTriggers: ['normal task without a response style request'], targets: ['codex', 'claude'], delivery: 'apm', visibility: 'common', activationPolicy: 'explicit-only' }),
    JSON.stringify({ id: 'skill:requirements-clarity', memberships: ['domain.research'], aliases: ['requirements elicitation', 'PRD discovery'], triggers: ['clarify an ambiguous complex feature request', 'elicit requirements for a PRD'], antiTriggers: ['clear bug fix', 'small scoped change'], targets: ['codex', 'claude'], delivery: 'apm', visibility: 'common' }),
    JSON.stringify({ id: 'skill:review-final', memberships: ['domain.research', 'action.review'], aliases: ['final rebuttal audit'] }),
    JSON.stringify({ id: 'subagent:independent-reviewer', memberships: ['action.review'], aliases: ['read-only reviewer'] }),
    JSON.stringify({ id: 'provider:plugin:fixture-plugin@fixture-marketplace', memberships: ['domain.research'], summary: 'Fixture native Plugin provider.' }),
    '',
  ].join('\n'));

  writeSkill(join(skillStore, 'research-core/SKILL.md'), 'research-core', 'Academic literature and 论文 evidence review.');
  write(join(skillStore, 'frontend-helper/SKILL.md'), `---\nname: frontend-helper\ndescription:\n  Design and optimize React frontends with\n  accessible component patterns.\n---\n\n# frontend-helper\n`);
  writeSkill(join(skillStore, 'first-verified-result/SKILL.md'), 'first-verified-result', 'Run the shortest representative empirical experiment and return verified exact-run metrics and artifacts.');
  writeSkill(join(skillStore, 'graph-workflow/SKILL.md'), 'graph-workflow', 'Coordinate dependency fan-out and fan-in or durable automatic workflow control.');
  writeSkill(join(skillStore, 'i-have-adhd/SKILL.md'), 'i-have-adhd', 'Use a concise ADHD-friendly response style only when explicitly invoked.');
  writeSkill(join(skillStore, 'requirements-clarity/SKILL.md'), 'requirements-clarity', 'Clarify vague requirements and produce an approved PRD.');
  writeSkill(join(pluginStore, 'plugins/fixture-plugin/skills/review-final/SKILL.md'), 'review-final', 'Independently audit a final academic rebuttal.');
  write(join(repo, '.rulesync/subagents/independent-reviewer.md'), `---\nname: independent-reviewer\ndescription: \"Review an immutable artifact independently.\"\ntargets:\n  - codexcli\n  - claudecode\n---\n\n${secretSentinel}\n`);

  return { root, repo, home, dbPath, skillStore };
}

test('compiles deployed Skills, Plugin provider, bundled Skill, and subagent once', async (t) => {
  const fixture = createFixture(t);
  await validateRepositoryMetadata({ repo: fixture.repo, skillRoot: fixture.skillStore });
  const cliValidation = spawnSync(process.execPath, [
    join(process.cwd(), 'payload/skills/capability-resolver/scripts/capability-resolver.mjs'),
    'validate-metadata', '--repo', fixture.repo, '--skill-root', fixture.skillStore,
  ], { encoding: 'utf8' });
  assert.equal(cliValidation.status, 0, cliValidation.stderr);
  const model = await loadSourceModel({ repo: fixture.repo, home: fixture.home, strictRouting: true });
  assert.deepEqual(model.capabilities.map((item) => item.id), [
    'provider:plugin:fixture-plugin@fixture-marketplace',
    'skill:first-verified-result',
    'skill:frontend-helper',
    'skill:graph-workflow',
    'skill:i-have-adhd',
    'skill:requirements-clarity',
    'skill:research-core',
    'skill:review-final',
    'subagent:independent-reviewer',
  ]);
  assert.equal(model.capabilities.find((item) => item.id === 'skill:review-final').providerId,
    'provider:plugin:fixture-plugin@fixture-marketplace');
  assert.equal(model.capabilities.find((item) => item.id === 'skill:i-have-adhd').activation.policy,
    'explicit-only');

  await rebuildIndex(fixture);
  await checkIndex(fixture);
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS count FROM capability').get().count, 9);
    assert.ok(!db.prepare('PRAGMA table_info(capability_fts_word)').all().some(({ name }) => name === 'body'));
  } finally {
    db.close();
  }
  assert.equal(readFileSync(fixture.dbPath).includes(Buffer.from(secretSentinel)), false);
  const bodySearch = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: secretSentinel },
  });
  assert.deepEqual(bodySearch.results, []);
});

test('runtime Plugin inventory follows enabled Plugins and compatible enabled hosts', async (t) => {
  const fixture = createFixture(t);
  const configPath = join(fixture.repo, 'pac.json');
  const machinePath = join(fixture.home, '.config/personal-agent-control/machine.json');
  const enabled = await loadSourceModel({ repo: fixture.repo, home: fixture.home, strictRouting: true });
  const enabledProvider = enabled.capabilities.find(({ id }) =>
    id === 'provider:plugin:fixture-plugin@fixture-marketplace');
  assert.deepEqual(enabledProvider.targets, ['claude', 'codex']);

  write(machinePath, JSON.stringify({ schemaVersion: 1, enabledHosts: ['claude'] }));
  const claudeOnly = await loadSourceModel({ repo: fixture.repo, home: fixture.home, strictRouting: true });
  assert.deepEqual(claudeOnly.capabilities.find(({ id }) =>
    id === 'provider:plugin:fixture-plugin@fixture-marketplace').targets, ['claude']);
  assert.notEqual(claudeOnly.revision, enabled.revision);

  rmSync(join(fixture.home, '.local/share/agent-plugins'), { recursive: true, force: true });
  writeFileSync(machinePath, JSON.stringify({ schemaVersion: 1, enabledHosts: [] }));
  const noHosts = await loadSourceModel({ repo: fixture.repo, home: fixture.home, strictRouting: true });
  assert.ok(!noHosts.capabilities.some(({ id }) => id.includes('fixture-plugin') || id === 'skill:review-final'));
  assert.notEqual(noHosts.revision, claudeOnly.revision);

  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    hosts: {
      codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
      claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
    },
    plugins: { enabled: [] },
  }));
  const disabled = await loadSourceModel({ repo: fixture.repo, home: fixture.home, strictRouting: true });
  assert.ok(!disabled.capabilities.some(({ id }) => id.includes('fixture-plugin') || id === 'skill:review-final'));
  assert.notEqual(disabled.revision, noHosts.revision);
  await rebuildIndex(fixture);
  await checkIndex(fixture);

  const staticValidation = await validateRepositoryMetadata({
    repo: fixture.repo,
    skillRoot: fixture.skillStore,
  });
  assert.equal(staticValidation.capabilityCount, 9);
});

test('uses validated frontmatter names for deployed directories and rejects duplicate names', async (t) => {
  const fixture = createFixture(t);
  const aliasedDirectory = join(fixture.skillStore, 'frontend-helper');
  const vendorDirectory = join(fixture.skillStore, 'vendor-frontend-path');
  mkdirSync(vendorDirectory, { recursive: true });
  writeFileSync(join(vendorDirectory, 'SKILL.md'), readFileSync(join(aliasedDirectory, 'SKILL.md')));
  rmSync(aliasedDirectory, { recursive: true, force: true });

  const model = await loadSourceModel({ repo: fixture.repo, home: fixture.home, strictRouting: true });
  const frontend = model.capabilities.find(({ id }) => id === 'skill:frontend-helper');
  assert.equal(frontend.resource, join(vendorDirectory, 'SKILL.md'));

  writeSkill(join(fixture.skillStore, 'duplicate-path/SKILL.md'), 'frontend-helper', 'Duplicate name.');
  assert.throws(() => validateRepositoryMetadata({
    repo: fixture.repo,
    skillRoot: fixture.skillStore,
  }), /duplicate Skill leaf name/i);
});

test('fails closed for undeclared MCP and App providers while accepting catalogued Plugins', async (t) => {
  const fixture = createFixture(t);
  const overlayPath = join(fixture.repo, 'catalog/capabilities.jsonl');
  const base = readFileSync(overlayPath, 'utf8');
  for (const [kind, id] of [
    ['mcp-server', 'provider:mcp-server:local-search'],
    ['app', 'provider:app:private-dashboard'],
  ]) {
    writeFileSync(overlayPath, `${base}${JSON.stringify({
      id,
      role: 'provider',
      kind,
      name: id.split(':').at(-1),
      memberships: ['domain.research'],
      summary: 'Undeclared future provider.',
      targets: ['codex'],
      activation: { type: 'future-provider' },
    })}\n`);
    assert.throws(() => validateRepositoryMetadata({ repo: fixture.repo, skillRoot: fixture.skillStore }),
      /undeclared|invent|provider|catalog/i);
  }
});

test('resolves explainably across FTS, Chinese aliases, host filters, and provider opt-in', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);

  const chinese = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'claude',
    intent: { task: '论文' },
    limit: 5,
  });
  assert.equal(ids(chinese)[0], 'skill:research-core');
  assert.ok(chinese.results[0].reasons.some((reason) =>
    reason.channel === 'exact' && reason.field === 'alias'
      && reason.fragment === '论文' && reason.value === '论文'));

  const keywordResult = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'academic evidence' },
    limit: 5,
  });
  const research = keywordResult.results.find(({ id }) => id === 'skill:research-core');
  assert.ok(research);
  const keywordReason = research.reasons.find(({ channel }) => channel === 'keyword');
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  let metadataValues;
  try {
    const row = db.prepare(`
      SELECT name, summary, aliases_json, triggers_json FROM capability WHERE id = ?
    `).get('skill:research-core');
    metadataValues = [row.name, row.summary, ...JSON.parse(row.aliases_json), ...JSON.parse(row.triggers_json)];
  } finally {
    db.close();
  }
  assert.ok(keywordReason);
  assert.ok(metadataValues.includes(keywordReason.value));
  assert.notEqual(keywordReason.value, 'academic evidence');

  const codexFrontend = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'optimize a React frontend' },
    limit: 5,
  });
  assert.ok(ids(codexFrontend).includes('skill:frontend-helper'));
  const claudeFrontend = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'claude',
    intent: { task: 'optimize a React frontend' },
    limit: 5,
  });
  assert.ok(!ids(claudeFrontend).includes('skill:frontend-helper'));

  const defaultPluginSearch = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'fixture native plugin provider' },
    limit: 10,
  });
  assert.ok(!ids(defaultPluginSearch).some((id) => id.startsWith('provider:')));
  const explicitPluginSearch = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'fixture native plugin provider', kinds: ['plugin'] },
    limit: 10,
  });
  assert.equal(ids(explicitPluginSearch)[0], 'provider:plugin:fixture-plugin@fixture-marketplace');

  const multiBranch = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'audit scholarly research evidence' },
    limit: 5,
  });
  const review = multiBranch.results.find(({ id }) => id === 'skill:review-final');
  assert.ok(review);
  assert.ok(review.matchedCategoryPaths.includes('root/domain/domain.research'));
  assert.ok(review.matchedCategoryPaths.includes('root/action/action.review'));
  assert.ok(review.reasons.some((reason) => reason.channel === 'category'
    && reason.categoryPath === 'root/action/action.review'));

  const wrongHint = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: '论文', categories: ['domain.frontend'] },
    limit: 5,
  });
  assert.equal(ids(wrongHint)[0], 'skill:research-core');

  const browsed = await browseCategory({
    dbPath: fixture.dbPath,
    host: 'codex',
    category: 'domain.research',
    limit: 10,
  });
  assert.ok(ids(browsed).includes('skill:research-core'));
  assert.ok(ids(browsed).includes('skill:review-final'));

  const serialExperiment = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: {
      task: 'Implement a research idea and run an experiment on one critical path; return validated metrics.',
    },
    limit: 10,
  });
  assert.equal(ids(serialExperiment)[0], 'skill:first-verified-result');
  assert.ok(!ids(serialExperiment).includes('skill:graph-workflow'));

  const durableGraph = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: {
      task: 'Coordinate dependency fan-out and fan-in and persist automatic workflow control across a host or process restart.',
    },
    limit: 10,
  });
  assert.equal(ids(durableGraph)[0], 'skill:graph-workflow');

  const singleLongExperiment = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: {
      task: 'Resume a single scheduler-owned long experiment until result artifacts are verified.',
    },
    limit: 10,
  });
  assert.equal(ids(singleLongExperiment)[0], 'skill:first-verified-result');
  assert.ok(!ids(singleLongExperiment).includes('skill:graph-workflow'));

  const submitOnly = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'Submit a job without requesting results.' },
    limit: 10,
  });
  assert.ok(!ids(submitOnly).includes('skill:first-verified-result'));

  const runReferenceOnly = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: {
      task: 'Submit this job and give me the stable run reference only; do not wait for results.',
    },
    limit: 10,
  });
  assert.ok(!ids(runReferenceOnly).includes('skill:first-verified-result'));

  const vaguePrd = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'Please elicit requirements for a PRD from this ambiguous complex feature idea.' },
    limit: 5,
  });
  assert.equal(ids(vaguePrd)[0], 'skill:requirements-clarity');

  const clearFix = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: 'This is a clear bug fix with an exact failing test and file.' },
    limit: 10,
  });
  assert.ok(!ids(clearFix).includes('skill:requirements-clarity'));

  const explicitStyle = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'claude',
    intent: { task: 'Explicitly use i-have-adhd focus mode for this response.' },
    limit: 5,
  });
  assert.equal(ids(explicitStyle)[0], 'skill:i-have-adhd');
  assert.equal(explicitStyle.results[0].activation.policy, 'explicit-only');

  const ordinaryTask = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'claude',
    intent: { task: 'Summarize the current implementation status.' },
    limit: 10,
  });
  assert.ok(!ids(ordinaryTask).includes('skill:i-have-adhd'));
});

test('root browse limits unique capabilities after aggregating deterministic category evidence', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);
  const browsed = await browseCategory({
    dbPath: fixture.dbPath,
    host: 'codex',
    category: 'root',
    limit: 10,
  });
  assert.equal(browsed.results.length, 8);
  assert.equal(new Set(ids(browsed)).size, browsed.results.length);
  const review = browsed.results.find(({ id }) => id === 'skill:review-final');
  assert.ok(review);
  assert.deepEqual(review.matchedCategoryPaths, [
    'root/action/action.review',
    'root/domain/domain.research',
    'root/kind/kind.skill',
  ]);
  assert.ok(review.reasons.every((reason) => reason.channel === 'category-browse'
    && reason.fragment === 'root' && reason.categoryPath.startsWith('root/')));
});

test('quotes untrusted FTS input instead of accepting query syntax', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);
  await assert.rejects(() => resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: { task: '' },
    limit: 5,
  }), /non-empty task/i);
  for (const query of ['"', '*', 'NEAR(', 'foo OR bar', 'software-workflow',
    '$software-workflow', 'context-mode:ctx-search', 'C++/C#', "' OR 1=1 --"]) {
    const result = await resolveCapabilities({
      dbPath: fixture.dbPath,
      host: 'codex',
      intent: { task: query },
      limit: 5,
    });
    assert.ok(result.results.length <= 5, query);
  }
  await assert.rejects(() => resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'unknown-host',
    intent: { task: 'research' },
  }), /host/i);
});

test('enforces structured intent and stdin bounds at their trust boundaries', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);

  const boundary = await resolveCapabilities({
    dbPath: fixture.dbPath,
    host: 'codex',
    intent: {
      task: 'x'.repeat(16_000),
      needs: Array.from({ length: 32 }, (_, index) => `need-${index}`),
      hints: ['h'.repeat(1_000)],
      kinds: Array(16).fill('skill'),
      categories: Array(16).fill('domain.research'),
    },
    limit: 1,
  });
  assert.equal(boundary.ok, true);

  for (const [intent, pattern] of [
    [{ task: 'x'.repeat(16_001) }, /16000|task/i],
    [{ task: 'research', needs: Array(33).fill('need') }, /32|needs/i],
    [{ task: 'research', hints: ['x'.repeat(1_001)] }, /1000|hints/i],
    [{ task: 'research', kinds: Array(17).fill('skill') }, /16|kinds/i],
    [{ task: 'research', categories: ['x'.repeat(257)] }, /256|categories/i],
  ]) {
    await assert.rejects(() => resolveCapabilities({
      dbPath: fixture.dbPath,
      host: 'codex',
      intent,
    }), pattern);
  }

  const realCli = join(process.cwd(),
    'payload/skills/capability-resolver/scripts/capability-resolver.mjs');
  assert.equal(lstatSync(realCli).isFile(), true);
  const prefix = '{"task":"research","padding":"';
  const suffix = '"}';
  const exactInput = `${prefix}${'x'.repeat((64 * 1024) - Buffer.byteLength(prefix + suffix))}${suffix}`;
  assert.equal(Buffer.byteLength(exactInput), 64 * 1024);
  const accepted = spawnSync(process.execPath, [realCli, 'resolve', '--host', 'codex',
    '--db', fixture.dbPath, '--stdin'], { input: exactInput, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = spawnSync(process.execPath, [realCli, 'resolve', '--host', 'codex',
    '--db', fixture.dbPath, '--stdin'], { input: `${exactInput} `, encoding: 'utf8' });
  assert.equal(rejected.status, 2, rejected.stderr);
  assert.match(rejected.stderr, /65536|standard input/i);
});

test('rebuild is idempotent, stale-aware, and atomic on invalid source', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);
  const before = { hash: sha256(fixture.dbPath), inode: statSync(fixture.dbPath).ino };
  await rebuildIndex(fixture);
  assert.deepEqual({ hash: sha256(fixture.dbPath), inode: statSync(fixture.dbPath).ino }, before);

  writeSkill(join(fixture.skillStore, 'research-core/SKILL.md'), 'research-core', 'Changed academic evidence description.');
  await assert.rejects(() => checkIndex(fixture), /stale|revision|source/i);
  await rebuildIndex(fixture);
  await checkIndex(fixture);
  const validHash = sha256(fixture.dbPath);

  const overlay = join(fixture.repo, 'catalog/capabilities.jsonl');
  writeFileSync(overlay, `${readFileSync(overlay, 'utf8')}\n{"id":"skill:research-core","memberships":["missing.category"]}\n`);
  await assert.rejects(() => rebuildIndex(fixture), /duplicate|category|overlay/i);
  assert.equal(sha256(fixture.dbPath), validHash);
  assert.equal(readdirSync(dirname(fixture.dbPath)).some((name) => /\.tmp|-(?:wal|shm)$/.test(name)), false);
});

test('production rebuild and check require complete capability overlay metadata', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);
  const overlay = join(fixture.repo, 'catalog/capabilities.jsonl');
  const incomplete = readFileSync(overlay, 'utf8').split('\n')
    .filter((line) => !line.includes('"skill:research-core"')).join('\n');
  writeFileSync(overlay, incomplete);
  await assert.rejects(() => checkIndex(fixture), /missing capability overlay metadata.*research-core/i);
  await assert.rejects(() => rebuildIndex(fixture), /missing capability overlay metadata.*research-core/i);
});

test('logical digest detects count-preserving row tampering and missing FTS rows', async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);
  let db = new DatabaseSync(fixture.dbPath);
  try {
    const before = db.prepare('SELECT count(*) AS count FROM capability').get().count;
    db.prepare(`UPDATE capability SET summary = ?, activation_json = ? WHERE id = ?`)
      .run('tampered summary', '{"type":"tampered"}', 'skill:research-core');
    assert.equal(db.prepare('SELECT count(*) AS count FROM capability').get().count, before);
  } finally {
    db.close();
  }
  await assert.rejects(() => checkIndex(fixture), /digest/i);
  await rebuildIndex(fixture);
  await checkIndex(fixture);

  db = new DatabaseSync(fixture.dbPath);
  try {
    db.prepare('DELETE FROM capability_fts_word WHERE capability_id = ?').run('skill:research-core');
  } finally {
    db.close();
  }
  await assert.rejects(() => checkIndex(fixture), /digest/i);
  await rebuildIndex(fixture);
  await checkIndex(fixture);
});

test('read-only operations reject missing and symlinked database paths', async (t) => {
  const fixture = createFixture(t);
  await assert.rejects(() => checkIndex(fixture), /missing|exist/i);
  assert.equal(lstatSync(dirname(fixture.dbPath), { throwIfNoEntry: false }), undefined);

  mkdirSync(dirname(fixture.dbPath), { recursive: true });
  const real = join(dirname(fixture.dbPath), 'real.sqlite');
  writeFileSync(real, 'not a database');
  symlinkSync(real, fixture.dbPath);
  await assert.rejects(() => checkIndex(fixture), /symbolic|symlink/i);
});

test('write and check paths allow system ancestor aliases but reject controlled suffix symlinks', async (t) => {
  const fixture = createFixture(t);
  const aliasRoot = join(fixture.root, 'system-prefix-alias');
  symlinkSync(fixture.root, aliasRoot, 'dir');
  const aliasedHome = join(aliasRoot, 'home');
  const aliasedDb = join(aliasedHome, '.cache/personal-agent-control/capabilities-v1.sqlite');
  await rebuildIndex({ repo: fixture.repo, home: aliasedHome, dbPath: aliasedDb });
  await checkIndex({ repo: fixture.repo, home: aliasedHome, dbPath: aliasedDb });

  const another = createFixture(t);
  const externalCache = join(another.root, 'external-cache');
  mkdirSync(externalCache);
  symlinkSync(externalCache, join(another.home, '.cache'), 'dir');
  await assert.rejects(() => rebuildIndex(another), /symlink|controlled/i);
  await assert.rejects(() => rebuildIndex({
    ...another,
    dbPath: join(another.root, 'outside.sqlite'),
  }), /configured home|under/i);
});

test('rebuild rejects a directory database target without changing its mode', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async (t) => {
  const fixture = createFixture(t);
  mkdirSync(fixture.dbPath, { recursive: true });
  chmodSync(fixture.dbPath, 0o750);
  const before = statSync(fixture.dbPath).mode & 0o777;
  await assert.rejects(() => rebuildIndex(fixture), /not a regular file/i);
  assert.equal(statSync(fixture.dbPath).mode & 0o777, before);
});

test('index permissions are 0600/0700, checks reject drift, and rebuild repairs it', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async (t) => {
  const fixture = createFixture(t);
  await rebuildIndex(fixture);
  assert.equal(statSync(fixture.dbPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(fixture.dbPath)).mode & 0o777, 0o700);

  chmodSync(fixture.dbPath, 0o644);
  await assert.rejects(() => checkIndex(fixture), /permissions|600/i);
  const fileRepair = await rebuildIndex(fixture);
  assert.equal(fileRepair.changed, true);
  assert.equal(statSync(fixture.dbPath).mode & 0o777, 0o600);

  chmodSync(dirname(fixture.dbPath), 0o755);
  await assert.rejects(() => checkIndex(fixture), /permissions|700/i);
  const directoryRepair = await rebuildIndex(fixture);
  assert.equal(directoryRepair.changed, true);
  assert.equal(statSync(dirname(fixture.dbPath)).mode & 0o777, 0o700);
  await checkIndex(fixture);
});

test('optional 10k capability smoke stays within a personal-scale latency envelope', {
  skip: process.env.PAC_RESOLVER_BENCH !== '1',
}, async (t) => {
  const fixture = createFixture(t);
  const overlay = [];
  rmSync(fixture.skillStore, { recursive: true, force: true });
  for (let index = 0; index < 10_000; index += 1) {
    const name = `scale-skill-${String(index).padStart(5, '0')}`;
    const exactAlias = `topic-${index}`;
    const longAlias = `${exactAlias}-${'a'.repeat(1_000 - exactAlias.length - 1)}`;
    const triggerPrefix = `route ${exactAlias} `;
    const longTrigger = `${triggerPrefix}${'t'.repeat(1_000 - triggerPrefix.length)}`;
    overlay.push(JSON.stringify({
      id: `skill:${name}`,
      memberships: ['domain.research'],
      aliases: [exactAlias, longAlias],
      triggers: [longTrigger],
      targets: ['codex', 'claude'],
      delivery: 'apm',
      visibility: 'common',
    }));
    writeSkill(join(fixture.skillStore, `${name}/SKILL.md`), name, `Capability for topic ${index}.`);
  }
  write(join(fixture.repo, 'catalog/plugins.tsv'), '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility\n');
  write(join(fixture.repo, 'pac.json'), JSON.stringify({
    schemaVersion: 1,
    hosts: {
      codex: { enabled: true, skillsDirectory: '~/.agents/skills' },
      claude: { enabled: true, skillsDirectory: '~/.claude/skills' },
    },
    plugins: { enabled: [] },
  }));
  write(join(fixture.repo, 'catalog/capabilities.jsonl'), `${overlay.join('\n')}\n`);
  rmSync(join(fixture.repo, '.rulesync/subagents'), { recursive: true, force: true });

  const validationStarted = performance.now();
  await validateRepositoryMetadata({ repo: fixture.repo, skillRoot: fixture.skillStore });
  const validationMs = performance.now() - validationStarted;
  const started = performance.now();
  await rebuildIndex(fixture);
  const buildMs = performance.now() - started;
  const latencies = [];
  for (let index = 0; index < 100; index += 1) {
    const queryStarted = performance.now();
    const result = await resolveCapabilities({
      dbPath: fixture.dbPath,
      host: 'codex',
      intent: { task: `topic-${index * 97}` },
      limit: 5,
    });
    latencies.push(performance.now() - queryStarted);
    assert.equal(result.results[0]?.id,
      `skill:scale-skill-${String(index * 97).padStart(5, '0')}`);
  }
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  const maximumDatabaseBytes = 512 * 1024 * 1024;
  assert.ok(validationMs < 10_000, `10k strict metadata validation took ${validationMs.toFixed(1)}ms`);
  assert.ok(buildMs < 10_000, `10k rebuild took ${buildMs.toFixed(1)}ms`);
  assert.ok(p95 < 100, `10k query p95 was ${p95.toFixed(1)}ms`);
  assert.ok(statSync(fixture.dbPath).size < maximumDatabaseBytes,
    `10k database exceeded the documented 512 MiB ceiling: ${statSync(fixture.dbPath).size} bytes`);
  t.diagnostic(`strict=${validationMs.toFixed(1)}ms rebuild=${buildMs.toFixed(1)}ms p95=${p95.toFixed(1)}ms db=${statSync(fixture.dbPath).size}B`);
});
