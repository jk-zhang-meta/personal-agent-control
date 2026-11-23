import path from 'node:path';
import fs from 'node:fs/promises';
import { PacError } from './errors.mjs';

// Local WSL executable discovery only; this never contacts another machine.
export async function findWindowsNode(execute) {
  const converted = await execute('wslpath', ['-u', 'C:\\Program Files\\nodejs\\node.exe'], { timeoutMs: 5000 });
  const candidates = [...new Set([converted.stdout.trim(),
    ...(process.env.PATH || '').split(path.delimiter).slice(0, 128).filter(path.isAbsolute).map(dir => path.join(dir, 'node.exe'))])];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new PacError('WINDOWS_BROWSER_DEPENDENCY_MISSING', 'Windows Node is required in its standard installation directory or WSL PATH.');
}
