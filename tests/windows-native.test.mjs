import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { resolveContext } from '../src/config.mjs';
import { run } from '../src/exec.mjs';

const windowsOnly = { skip: process.platform !== 'win32' };

test('Windows context resolves the pinned APM executable from LOCALAPPDATA mise', windowsOnly, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pac-win-config-')));
  const home = path.join(root, 'home');
  const localAppData = path.join(root, 'LocalAppData');
  const apm = path.join(localAppData, 'mise/installs/apm/0.28.0/apm.exe');
  await fs.mkdir(home);
  await fs.mkdir(path.dirname(apm), { recursive: true });
  await fs.writeFile(apm, 'fixture');
  const prior = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  t.after(async () => {
    if (prior === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prior;
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal(resolveContext({ home }).apm, apm);
});

test('Windows shell runner uses Git sh and translates native absolute path arguments', windowsOnly, async (t) => {
  const sh = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git/bin/sh.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Git/bin/sh.exe'),
  ].filter(Boolean).find((candidate) => existsSync(candidate));
  assert.ok(sh, 'Git for Windows sh.exe is required for the Windows PAC test');
  const prior = process.env.PAC_SH;
  process.env.PAC_SH = sh;
  t.after(() => {
    if (prior === undefined) delete process.env.PAC_SH;
    else process.env.PAC_SH = prior;
  });

  const result = await run('sh', ['-c', 'printf "%s" "$1"', 'sh', 'C:\\Work Tree\\file.txt']);
  assert.equal(result.stdout, '/c/Work Tree/file.txt');
});
