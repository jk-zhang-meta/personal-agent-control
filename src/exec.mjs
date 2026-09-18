import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PacError } from './errors.mjs';

function resolvedCommand(command) {
  if (process.platform !== 'win32' || command !== 'sh') return command;
  const candidates = [
    process.env.PAC_SH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git/bin/sh.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Git/bin/sh.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || command;
}

function resolvedArgs(command, args) {
  if (process.platform !== 'win32' || command !== 'sh') return args;
  return args.map((arg) => {
    const match = typeof arg === 'string' && arg.match(/^([A-Za-z]):[\\/](.*)$/u);
    return match ? `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}` : arg;
  });
}

export async function run(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    inherit = false,
    errorCode = 'COMMAND_FAILED',
  } = options;

  return await new Promise((resolve, reject) => {
    const executable = resolvedCommand(command);
    const commandArgs = resolvedArgs(command, args);
    const child = spawn(executable, commandArgs, {
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
      { command: executable, args: commandArgs },
    )));
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr, code: 0 });
      reject(new PacError(
        errorCode,
        `${command} exited with status ${code ?? signal}`,
        { command: executable, args: commandArgs, status: code, signal, stdout, stderr },
      ));
    });
  });
}
