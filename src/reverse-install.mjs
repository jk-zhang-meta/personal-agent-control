import path from 'node:path';
import fs from 'node:fs/promises';
import { run } from './exec.mjs';
import { PacError } from './errors.mjs';

// Windows owns the runtime even when a WSL client owns the MCP projection.
// Built-in PowerShell can bootstrap pinned Node without assuming Node is installed.
export async function windowsReverseSetup(context, action, provider = 'ida', execute = run) {
  const wsl = (context.platform || process.platform) === 'linux' && context.isWsl;
  const convert = async (flag, value) => (await execute('wslpath', [flag, value], { timeoutMs: 5000 })).stdout.trim();
  const root = wsl ? await convert('-w', context.root) : context.root;
  const command = wsl ? await convert('-u', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    : path.join(process.env.WINDIR || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await execute(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.win32.join(root, 'src/reverse-install.ps1'),
    '-Action', action, '-Provider', provider, '-CoreRoot', root,
    ...(!wsl ? ['-RuntimeHome', context.home] : [])],
  { timeoutMs: action === 'Probe' ? 15000 : 1800000, errorCode: 'REVERSE_PROVISION_FAILED' });
  const value = JSON.parse(result.stdout.trim());
  if (wsl && value.node) value.node = await convert('-u', value.node);
  return value;
}

export async function provisionReverse(context, provider, { execute = run } = {}) {
  if (!['ida', 'windbg'].includes(provider.name)) return;
  const platform = context.platform || process.platform;
  if (platform === 'win32' || (platform === 'linux' && context.isWsl)) {
    return windowsReverseSetup(context, 'Install', provider.name, execute);
  }
  // Existing macOS installations remain usable; automatic provisioning is not
  // declared validated there. Do not silently claim a fresh install succeeded.
  if (platform === 'darwin') {
    const existing = path.join(context.home, '.agent-work/tools/reverse-engineering/ida/venv/bin/python');
    if ((await fs.stat(existing).catch(() => null))?.isFile()) return { status: 'existing', automaticInstallation: false };
    throw new PacError('REVERSE_PROVISION_UNVERIFIED', 'Automatic macOS reverse-engineering provisioning is not yet validated; existing MCP bindings can continue without installation.');
  }
  throw new PacError('PROVIDER_PLATFORM_UNSUPPORTED', 'Reverse-engineering provisioning requires native Windows or same-host WSL.');
}
