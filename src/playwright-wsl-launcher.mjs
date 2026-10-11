import { spawn } from 'node:child_process';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (!command || !path.isAbsolute(command) || path.basename(command).toLowerCase() !== 'node.exe' || !args.length) {
  throw new Error('Expected an absolute Windows node.exe path and Windows MCP entrypoint.');
}
// Windows interop needs a Windows-mounted cwd even when the agent works in WSL.
const child = spawn(command, args, { cwd: path.dirname(command), stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
