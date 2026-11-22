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
    await fs.mkdir(path.join(upstream, '.agents/plugins'), { recursive: true });
    await fs.writeFile(path.join(upstream, '.agents/plugins/marketplace.json'), JSON.stringify({
      plugins: [{ name: 'context-mode', source: { source: 'local', path: './plugins/context-mode' } }],
    }));
    await fs.writeFile(path.join(upstream, 'plugins/context-mode/hook.mjs'), 'export const enabled = true;');
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
  const versionFile = path.join(marketplace.marketplaceSource.source, 'version.txt');
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '1.0.0';
  const cache = path.join(process.env.HOME, '.codex/plugins/cache/context-mode/context-mode', version);
  fs.cpSync(path.join(marketplace.marketplaceSource.source, 'plugins/context-mode'), cache, { recursive: true });
  write(pluginsFile, [{ pluginId: args[2], marketplaceName: 'context-mode', version, enabled: true, installed: true, marketplaceSource: marketplace.marketplaceSource }]);
} else if (args.slice(0, 2).join(' ') === 'plugin remove') {
  write(pluginsFile, []);
} else if (args.slice(0, 3).join(' ') === 'plugin marketplace remove') {
  write(marketplacesFile, []);
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
    // A Plugin from a marketplace PAC does not manage is reported and preserved.
    await fs.writeFile(path.join(home, '.fixture-native/plugins.json'), JSON.stringify([
      { pluginId: 'external@foreign', marketplaceName: 'foreign', enabled: true, installed: true }
    ]));
    const external = spawnSync(path.join(repo, 'scripts/reconcile-plugins.sh'), ['preflight', ...args], { env, encoding: 'utf8' });
    assert.equal(external.status, 0, external.stderr);
    assert.match(external.stderr, /EXTERNAL: preserving codex Plugin external@foreign/u);
    // An uncatalogued Plugin inside a PAC-managed marketplace still fails closed.
    await fs.writeFile(path.join(home, '.fixture-native/plugins.json'), JSON.stringify([
      { pluginId: 'rogue@context-mode', marketplaceName: 'context-mode', enabled: true, installed: true }
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
    const priorPins = path.join(tmp, 'prior.tsv');
    const oldCatalog = await fs.readFile(catalog, 'utf8');
    await fs.writeFile(priorPins, oldCatalog.split('\n')[1] + '\n');
    await fs.writeFile(path.join(upstream, 'version.txt'), '1.1.0');
    run('git', ['-C', upstream, 'add', 'version.txt']);
    run('git', ['-C', upstream, 'commit', '--quiet', '-m', 'next release']);
    const next = run('git', ['-C', upstream, 'rev-parse', 'HEAD']);
    const nextTree = run('git', ['-C', upstream, 'rev-parse', 'HEAD^{tree}']);
    await fs.writeFile(catalog, oldCatalog.replace(commit, next).replace(tree, nextTree).replace('1.0.0', '1.1.0'));
    rejectPreflight(/DRIFT/u);
    args.push('--prior-pins', priorPins);
    const oldCache = path.join(home, '.codex/plugins/cache/context-mode/context-mode/1.0.0');
    await fs.cp(path.join(upstream, 'plugins/context-mode'), oldCache, { recursive: true });
    const hook = path.join(oldCache, 'hook.mjs');
    const originalHook = await fs.readFile(hook);
    await fs.writeFile(hook, 'unreviewed user hook');
    rejectPreflight(/DRIFT: prior Plugin registration/u);
    assert.equal(await fs.readFile(hook, 'utf8'), 'unreviewed user hook');
    await fs.writeFile(hook, originalHook);
    await fs.writeFile(path.join(cachedSource, 'unreviewed.txt'), 'local drift');
    rejectPreflight(/DRIFT/u);
    assert.equal(run('git', ['-C', cachedSource, 'rev-parse', 'HEAD']), commit);
    await fs.unlink(path.join(cachedSource, 'unreviewed.txt'));
    const nativeFile = path.join(home, '.fixture-native/plugins.json');
    const installed = JSON.parse(await fs.readFile(nativeFile, 'utf8'));
    await fs.writeFile(nativeFile, JSON.stringify([{ ...installed[0], version: 'wrong' }]));
    rejectPreflight(/DRIFT: prior Plugin registration/u);
    await fs.writeFile(nativeFile, JSON.stringify(installed));
    run(path.join(repo, 'scripts/reconcile-plugins.sh'), ['preflight', ...args], { env });
    const backup = path.join(home, '.agent-work/backups/personal-agent-control/rotation-fixture');
    const sourceRel = '.local/share/agent-plugins/sources/context-mode';
    const cacheRel = '.codex/plugins/cache/context-mode';
    await fs.cp(cachedSource, path.join(backup, 'home', sourceRel), { recursive: true });
    await fs.cp(path.join(home, cacheRel), path.join(backup, 'home', cacheRel), { recursive: true });
    await fs.writeFile(path.join(backup, 'managed-paths.txt'), sourceRel + '\n' + cacheRel + '\n');
    await fs.writeFile(path.join(backup, 'metadata.txt'), 'source=' + repo + '\n');
    args.push('--prior-sources', path.join(backup, 'home/.local/share/agent-plugins/sources'));
    await fs.writeFile(hook, 'edit after preflight');
    const changed = spawnSync(path.join(repo, 'scripts/reconcile-plugins.sh'), ['apply', ...args], { env, encoding: 'utf8' });
    assert.equal(changed.status, 72, changed.stderr);
    assert.equal(await fs.readFile(path.join(tmp, 'cache-conflict'), 'utf8'), 'context-mode');
    run(path.join(repo, 'scripts/restore-backup.sh'), [backup], { env: { ...env, PAC_PRESERVE_PLUGIN_CACHE: cacheRel } });
    assert.equal(run('git', ['-C', cachedSource, 'rev-parse', 'HEAD']), commit);
    assert.equal(await fs.readFile(hook, 'utf8'), 'edit after preflight');
    await fs.writeFile(hook, originalHook);
    run(path.join(repo, 'scripts/reconcile-plugins.sh'), ['apply', ...args], { env });
    run(path.join(repo, 'scripts/reconcile-plugins.sh'), ['check', ...args], { env });
    assert.equal(run('git', ['-C', cachedSource, 'rev-parse', 'HEAD']), next);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
