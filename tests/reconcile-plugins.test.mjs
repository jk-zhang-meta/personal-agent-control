import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

test('preflight permits an enabled Plugin source to be acquired during apply', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-plugin-preflight-'));
  const home = path.join(tmp, 'home');
  const upstream = path.join(tmp, 'upstream');
  const bin = path.join(tmp, 'bin');
  const catalog = path.join(tmp, 'plugins.tsv');
  try {
    await fs.mkdir(path.join(upstream, 'plugins/context-mode/skills/context-mode'), { recursive: true });
    await fs.writeFile(path.join(upstream, 'plugins/context-mode/skills/context-mode/SKILL.md'),
      '---\nname: context-mode\ndescription: fixture\n---\n');
    run('git', ['init', '--quiet', upstream]);
    run('git', ['-C', upstream, 'config', 'user.email', 'fixture@example.invalid']);
    run('git', ['-C', upstream, 'config', 'user.name', 'Fixture']);
    run('git', ['-C', upstream, 'add', '.']);
    run('git', ['-C', upstream, 'commit', '--quiet', '-m', 'fixture']);
    const commit = run('git', ['-C', upstream, 'rev-parse', 'HEAD']);
    const tree = run('git', ['-C', upstream, 'rev-parse', 'HEAD^{tree}']);

    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = path.join(process.env.HOME, '.fixture-native');
const pluginsFile = path.join(state, 'plugins.json');
const marketplacesFile = path.join(state, 'marketplaces.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const args = process.argv.slice(2);
if (args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({ marketplaces: read(marketplacesFile) }));
} else if (args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: read(pluginsFile) }));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  write(marketplacesFile, [{ name: 'context-mode', marketplaceSource: { sourceType: 'local', source: args[3] } }]);
} else if (args[0] === 'plugin' && args[1] === 'add') {
  const marketplace = read(marketplacesFile)[0];
  write(pluginsFile, [{ pluginId: args[2], marketplaceName: 'context-mode', version: '1.0.0', enabled: true, installed: true, marketplaceSource: marketplace.marketplaceSource }]);
} else {
  process.exit(2);
}
`, { mode: 0o755 });
    await fs.mkdir(path.join(home, '.fixture-native'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(home, '.fixture-native/plugins.json'), '[]'),
      fs.writeFile(path.join(home, '.fixture-native/marketplaces.json'), '[]'),
      fs.mkdir(path.join(home, '.local/state/personal-agent-control'), { recursive: true }),
    ]);
    await fs.writeFile(path.join(home, '.local/state/personal-agent-control/owned-plugins.tsv'),
      '# plugin\tmarketplace\ttargets\n');
    await fs.writeFile(catalog, [
      '# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility',
      `context-mode\tcontext-mode\tgithub-commit\t${upstream}\t-\t${commit}\t${tree}\t1.0.0\tcodex\tcontext-mode\tMIT\tprivate`,
      '',
    ].join('\n'));
    const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const args = ['--home', home, '--agents', 'codex', '--catalog', catalog];
    const cachedSource = path.join(home, '.local/share/agent-plugins/sources/context-mode');

    run(path.join(repo, 'scripts/reconcile-plugins.sh'), ['preflight', ...args], { env });
    await assert.rejects(fs.lstat(cachedSource), /ENOENT/u);
    await fs.mkdir(path.dirname(cachedSource), { recursive: true });
    run('git', ['clone', '--quiet', upstream, cachedSource]);
    run(path.join(repo, 'scripts/reconcile-plugins.sh'), ['preflight', ...args], { env });
    const rejectPreflight = (pattern) => {
      const result = spawnSync(path.join(repo, 'scripts/reconcile-plugins.sh'), ['preflight', ...args], { env, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
    };
    await fs.writeFile(path.join(cachedSource, 'unexpected.txt'), 'unreviewed');
    rejectPreflight(/DRIFT: Plugin source/u);
    await fs.unlink(path.join(cachedSource, 'unexpected.txt'));
    run('git', ['-C', cachedSource, 'remote', 'set-url', 'origin', path.join(tmp, 'wrong-source')]);
    rejectPreflight(/DRIFT: Plugin source/u);
    run('git', ['-C', cachedSource, 'remote', 'set-url', 'origin', upstream]);
    await fs.writeFile(path.join(home, '.fixture-native/plugins.json'), JSON.stringify([
      { pluginId: 'unmanaged@foreign', marketplaceName: 'foreign', enabled: true, installed: true }
    ]));
    rejectPreflight(/UNMANAGED/u);
    await fs.writeFile(path.join(home, '.fixture-native/plugins.json'), '[]');
    await fs.rm(cachedSource, { recursive: true, force: true });
    await fs.symlink(upstream, cachedSource, 'dir');
    rejectPreflight(/unsafe|DRIFT/iu);
    await fs.unlink(cachedSource);
    const checkedMissing = spawnSync(path.join(repo, 'scripts/reconcile-plugins.sh'), ['check', ...args], { env, encoding: 'utf8' });
    assert.notEqual(checkedMissing.status, 0);
    run(path.join(repo, 'scripts/reconcile-plugins.sh'), ['apply', ...args], { env });
    assert.equal(await fs.readFile(path.join(home, '.local/state/personal-agent-control/owned-plugins.tsv'), 'utf8'),
      '# plugin\tmarketplace\ttargets\ncontext-mode\tcontext-mode\tcodex\n');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
