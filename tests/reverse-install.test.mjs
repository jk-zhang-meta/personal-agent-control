import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { provisionReverse, windowsReverseSetup } from '../src/reverse-install.mjs';
import { discoverIda } from '../src/ida-installation.mjs';

test('WSL provisioning uses built-in PowerShell and argv before any Windows Node exists', async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command === 'wslpath') return { stdout: args[0] === '-w' ? 'C:\\Core space' : '/mnt/c/' + path.win32.basename(args[1]) };
    return { stdout: JSON.stringify({ home: 'C:\\Users\\owner', node: 'C:\\tools\\node.exe' }) };
  };
  const context = { platform: 'linux', isWsl: true, root: '/mnt/c/Core space' };
  const result = await provisionReverse(context, { name: 'ida' }, { execute });
  assert.equal(result.node, '/mnt/c/node.exe');
  const invocation = calls.find(([command]) => command.endsWith('powershell.exe'));
  assert.deepEqual(invocation[1], ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','C:\\Core space\\src\\reverse-install.ps1','-Action','Install','-Provider','ida','-CoreRoot','C:\\Core space']);
  assert.equal(calls.some(([command]) => command.endsWith('node.exe')), false);
  calls.length = 0;
  await windowsReverseSetup(context, 'Probe', 'ida', execute);
  assert.equal(calls.find(([command]) => command.endsWith('powershell.exe'))[1].includes('Install'), false);
  calls.length = 0;
  await provisionReverse(context, { name: 'codegraph' }, { execute });
  assert.equal(calls.length, 0);
});

test('IDA discovery preserves valid selection, finds later installation, never creates vendor config', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-ida-'));
  try {
    const root = path.join(home, 'Applications');
    const install = path.join(root, 'IDA Professional 9.5.app', 'Contents/MacOS');
    await fs.mkdir(install, { recursive: true });
    await fs.writeFile(path.join(install, 'libidalib.dylib'), 'fixture');
    const beta = path.join(root, 'IDA Professional 9.6 beta.app', 'Contents/MacOS');
    await fs.mkdir(beta, { recursive: true });
    await fs.writeFile(path.join(beta, 'libidalib.dylib'), 'fixture');
    assert.equal(await discoverIda({ home, platform: 'darwin', env: {}, roots: [root] }), install);
    assert.equal(await discoverIda({ home, platform: 'darwin', env: { IDADIR: beta }, roots: [root] }), beta);
    assert.equal(await fs.stat(path.join(home, '.idapro')).catch(() => null), null);
    const selected = path.join(home, 'chosen');
    await fs.mkdir(selected);
    await fs.writeFile(path.join(selected, 'libidalib.dylib'), 'fixture');
    assert.equal(await discoverIda({ home, platform: 'darwin', env: { IDADIR: selected }, roots: [root] }), selected);
    await fs.mkdir(path.join(home, '.idapro'));
    const config = JSON.stringify({ Paths: { 'ida-install-dir': selected } });
    await fs.writeFile(path.join(home, '.idapro/ida-config.json'), config);
    assert.equal(await discoverIda({ home, platform: 'darwin', env: {}, roots: [root] }), selected);
    assert.equal(await fs.readFile(path.join(home, '.idapro/ida-config.json'), 'utf8'), config);
    assert.equal(await discoverIda({ home, platform: 'darwin', env: { IDAUSR: path.join(home, 'absent') }, roots: [] }), null);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
