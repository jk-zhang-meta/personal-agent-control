import fs from 'node:fs/promises';
import path from 'node:path';

// Read vendor preferences without importing idapro (which creates config).
export async function discoverIda({ home, platform = process.platform, env = process.env, roots } = {}) {
  const p = platform === 'win32' ? path.win32 : path;
  const valid = async candidate => typeof candidate === 'string' && candidate.length > 0
    && (await fs.stat(p.join(candidate, platform === 'win32' ? 'idalib.dll' : 'libidalib.dylib')).catch(() => null))?.isFile();
  if (await valid(env.IDADIR)) return env.IDADIR;
  const user = env.IDAUSR?.split(platform === 'win32' ? ';' : ':')[0]
    || (platform === 'win32' ? p.join(env.APPDATA || p.join(home, 'AppData/Roaming'), 'Hex-Rays/IDA Pro') : p.join(home, '.idapro'));
  const config = await fs.readFile(p.join(user, 'ida-config.json'), 'utf8').then(JSON.parse).catch(() => null);
  const configured = config?.Paths?.['ida-install-dir'];
  if (await valid(configured)) return configured;
  const search = roots || (platform === 'win32'
    ? [env.ProgramFiles, env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)
    : ['/Applications', p.join(home, 'Applications')]);
  const candidates = [];
  for (const root of search) {
    for (const entry of (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).slice(0, 512)) {
      const match = /^IDA(?: Professional| Pro)?[ -]?(\d+)\.(\d+).*?(?:\.app)?$/iu.exec(entry.name);
      if (!entry.isDirectory() || !match || Number(match[1]) < 9 || (Number(match[1]) === 9 && Number(match[2]) < 4)) continue;
      candidates.push({ version: Number(match[1]) * 1000 + Number(match[2]), directory: p.join(root, entry.name, platform === 'darwin' ? 'Contents/MacOS' : '') });
    }
  }
  for (const candidate of candidates.sort((a, b) => b.version - a.version)) if (await valid(candidate.directory)) return candidate.directory;
  return null;
}
