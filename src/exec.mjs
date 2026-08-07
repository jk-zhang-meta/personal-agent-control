import { spawn } from 'node:child_process';
import { PacError } from './errors.mjs';

export async function run(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    inherit = false,
    errorCode = 'COMMAND_FAILED',
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    }
    child.on('error', (error) => reject(new PacError(
      error.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : errorCode,
      `Could not run ${command}: ${error.message}`,
      { command, args },
    )));
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr, code: 0 });
      reject(new PacError(
        errorCode,
        `${command} exited with status ${code ?? signal}`,
        { command, args, status: code, signal, stdout, stderr },
      ));
    });
  });
}
