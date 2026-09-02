import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  SCAN_GUARD_MARKER,
  SCAN_GUARD_POLICY_VERSION,
  inspectCommand,
  hookDecision,
} from './scan-guard-policy.mjs';
import { atomicWriteFile } from './atomic-file.mjs';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject, assertSafeManagedPath } from './path-safety.mjs';

// PAC owns a small, native PreToolUse gate. The gate is not a replacement for
// the host sandbox or resource-guard: it prevents an unbounded raw discovery
// command from reaching the shell and routes the agent to an observable,
// capped provider. The policy copy executed by the host is staged under the
// local agent-work runtime, never read from a live OneDrive checkout.
export { SCAN_GUARD_MARKER, SCAN_GUARD_POLICY_VERSION, inspectCommand, hookDecision };
export const SCAN_GUARD_SCHEMA = 3;

const HOSTS = new Set(['codex', 'claude']);
const HOST_CONFIGS = Object.freeze({
  // Keep hook startup off the harmless control/UI path. Codex serializes shell
  // calls as Bash and apply_patch as apply_patch (with Write/Edit matcher
  // aliases); Claude exposes the named file/network tools directly. MCP and
  // context-mode tools remain covered by prefix so new recursive providers
  // still fail closed in the policy.
  codex: Object.freeze({
    env: 'CODEX_HOME', directory: '.codex', file: 'hooks.json',
    matcher: '^(?:Bash|Read|ReadFile|read_file|Write|WriteFile|write_file|Edit|MultiEdit|ApplyPatch|apply_patch|NotebookRead|NotebookEdit|view_image|WebSearch|WebFetch|Fetch|web__run|image_gen__imagegen|Glob|Grep|mcp__.*|ctx_.*)$',
  }),
  claude: Object.freeze({
    env: 'CLAUDE_CONFIG_DIR', directory: '.claude', file: 'settings.json',
    matcher: '^(?:Bash|Read|ReadFile|read_file|Write|WriteFile|write_file|Edit|MultiEdit|ApplyPatch|apply_patch|NotebookRead|NotebookEdit|view_image|WebSearch|WebFetch|Fetch|web__run|image_gen__imagegen|Glob|Grep|mcp__.*|ctx_.*)$',
  }),
});
const RUNTIME_RELATIVE = '.agent-work/runtime/pac/scan-guard-hook.mjs';
const STATE_RELATIVE = '.local/state/personal-agent-control/scan-guard.json';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonDigest(value) {
  return digest(JSON.stringify(value));
}

function syncedPath(value) {
  const lower = String(value || '').replaceAll('\\', '/').toLowerCase();
  return lower.includes('/onedrive') || lower.includes('/cloudstorage')
    || lower.includes('/dropbox') || lower.includes('/google drive')
    || lower.includes('/mnt/c/') || lower.includes('/mnt/d/');
}

function statePath(context) {
  return path.join(context.home, STATE_RELATIVE);
}

function runtimePath(context) {
  const target = path.join(context.home, RUNTIME_RELATIVE);
  if (syncedPath(target)) {
    throw new PacError('SCAN_GUARD_RUNTIME_UNSAFE', `Scan-guard runtime must be on local storage: ${target}`);
  }
  return target;
}

function scanGuardSourceFiles(context) {
  return {
    policy: path.join(context.root, 'src/scan-guard-policy.mjs'),
    pins: path.join(context.root, 'catalog/trusted-sources.sha256'),
  };
}

function scanGuardSourceAvailable(context) {
  const files = scanGuardSourceFiles(context);
  try { return fs.existsSync(files.policy) && fs.existsSync(files.pins); }
  catch { return false; }
}

function configuredHostPath(context, host) {
  const descriptor = HOST_CONFIGS[host];
  const defaultDirectory = path.join(context.home, descriptor.directory);
  let directory = defaultDirectory;
  const configured = process.env[descriptor.env];
  if (configured) {
    const expanded = configured === '~' ? context.home
      : configured.startsWith('~/') ? path.join(context.home, configured.slice(2))
        : path.resolve(configured);
    directory = path.resolve(expanded);
  }
  // A hidden CODEX_HOME/CLAUDE_CONFIG_DIR would otherwise make status look
  // healthy while the host loads a different hook file. Fail closed unless
  // the host is using PAC's declared default directory.
  if (path.resolve(directory) !== path.resolve(defaultDirectory)) {
    throw new PacError('SCAN_GUARD_CONFIG_UNSUPPORTED',
      `${host} config directory is not the PAC-managed default (${defaultDirectory}): ${directory}`);
  }
  return {
    directory,
    file: path.join(directory, descriptor.file),
    relative: path.posix.join(descriptor.directory, descriptor.file),
  };
}

export function scanGuardManagedPaths(context, hosts = ['codex', 'claude']) {
  const paths = new Set([STATE_RELATIVE, RUNTIME_RELATIVE]);
  for (const host of hosts) {
    if (!HOSTS.has(host)) throw new PacError('HOST_SELECTION_INVALID', `Unknown scan-guard host: ${host}`);
    paths.add(configuredHostPath(context, host).relative);
  }
  return [...paths].sort();
}

function readJsonFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PacError('SCAN_GUARD_CONFIG_UNSAFE', `Scan-guard host config must be a regular file: ${file}`);
    }
    // Parse and CAS against the exact same byte snapshot. Two independent
    // reads permit an external host/plugin writer to swap A→B between them.
    const raw = fs.readFileSync(file);
    return { value: JSON.parse(raw.toString('utf8')), raw };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: {}, raw: null };
    if (error instanceof PacError) throw error;
    throw new PacError('SCAN_GUARD_CONFIG_INVALID', `Cannot parse ${file}: ${error.message}`);
  }
}

function codexHookFeatures(context) {
  const file = path.join(context.home, '.codex/config.toml');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { disabled: false, activation: 'unknown', trust: 'unknown', config: file, values: {} }; throw error; }
  let section = '';
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (sectionMatch) { section = sectionMatch[1].trim(); continue; }
    const match = line.match(/^\s*(hooks|plugin_hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/iu);
    if (match && section === 'features') values[match[1].toLowerCase()] = match[2].toLowerCase() === 'true';
  }
  // PAC installs a user-level hooks.json entry. `plugin_hooks=false` only
  // disables bundled Plugin hooks and must not make this independent gate
  // look inactive.
  const disabled = values.hooks === false || values.codex_hooks === false;
  const activation = disabled ? 'disabled' : (values.hooks === true ? 'enabled' : 'unknown');
  return { disabled, activation, trust: 'unknown', config: file, values };
}

function hostHookState(context, host, config) {
  if (host === 'claude') {
    return { disabled: config.disableAllHooks === true, activation: config.disableAllHooks === true ? 'disabled' : 'enabled', trust: 'native' };
  }
  return codexHookFeatures(context);
}

async function codexHookTrustStatus(context, descriptor, expected) {
  if (typeof context.codexHookTrustProbe === 'function') {
    return await context.codexHookTrustProbe({ descriptor, expected });
  }
  const executable = process.env.PAC_CODEX || 'codex';
  const maxBytes = 2 * 1024 * 1024;
  const timeoutMs = 5000;
  return await new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderrBytes = 0;
    let initialized = false;
    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd: context.root,
      env: {
        ...process.env,
        HOME: context.home,
        CODEX_HOME: path.join(context.home, '.codex'),
        RUST_LOG: 'error',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ observable: false, active: false, trustStatus: 'unknown', reason: 'Codex hooks/list timed out.' }), timeoutMs);
    const send = (value) => {
      try { child.stdin.write(`${JSON.stringify(value)}\n`); }
      catch { finish({ observable: false, active: false, trustStatus: 'unknown', reason: 'Codex app-server stdin closed.' }); }
    };
    const inspectLine = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { return; }
      if (message.id === 1 && !initialized) {
        if (message.error) {
          finish({ observable: false, active: false, trustStatus: 'unknown', reason: 'Codex app-server initialization failed.' });
          return;
        }
        initialized = true;
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [context.root] } });
        return;
      }
      if (message.id !== 2) return;
      const listedRoots = Array.isArray(message.result?.data) ? message.result.data.filter((entry) =>
        typeof entry?.cwd === 'string' && entry.cwd.length > 0 &&
        path.resolve(entry.cwd) === path.resolve(context.root)) : [];
      if (listedRoots.length !== 1) {
        finish({ observable: true, active: false, trustStatus: 'unknown',
          reason: `Codex hooks/list returned ${listedRoots.length} records for the PAC root.` });
        return;
      }
      const listed = listedRoots[0];
      const warnings = Array.isArray(listed.warnings) ? listed.warnings : [];
      const errors = Array.isArray(listed.errors) ? listed.errors : [];
      if (warnings.length > 0 || errors.length > 0) {
        finish({ observable: true, active: false, trustStatus: 'unknown',
          reason: `Codex hooks/list reported ${warnings.length} warning(s) and ${errors.length} error(s).` });
        return;
      }
      const hooks = Array.isArray(listed.hooks) ? listed.hooks : [];
      const matches = hooks.filter((entry) => entry &&
        String(entry.eventName || '').replace(/[^a-z0-9]/giu, '').toLowerCase() === 'pretooluse' &&
        entry.handlerType === 'command' && entry.source === 'user' && entry.isManaged === false &&
        entry.matcher === expected.matcher &&
        entry.command === expected.hooks[0].command &&
        path.resolve(String(entry.sourcePath || '')) === path.resolve(descriptor.file));
      if (matches.length !== 1) {
        finish({ observable: true, active: false, trustStatus: 'unknown',
          reason: `Codex hooks/list found ${matches.length} exact PAC entries.` });
        return;
      }
      const entry = matches[0];
      if (typeof entry.key !== 'string' || entry.key.length === 0 ||
          !/^sha256:[0-9a-f]{64}$/u.test(entry.currentHash || '')) {
        finish({ observable: true, active: false, trustStatus: 'unknown',
          reason: 'Codex hooks/list returned invalid PAC hook identity metadata.' });
        return;
      }
      const trustStatus = String(entry.trustStatus || 'unknown').toLowerCase();
      finish({
        observable: true,
        active: entry.enabled === true && ['trusted', 'managed'].includes(trustStatus),
        enabled: entry.enabled === true,
        trustStatus,
        key: typeof entry.key === 'string' ? entry.key : null,
        currentHash: typeof entry.currentHash === 'string' ? entry.currentHash : null,
      });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxBytes) {
        finish({ observable: false, active: false, trustStatus: 'unknown', reason: 'Codex hooks/list output exceeded 2 MiB.' });
        return;
      }
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        inspectLine(line);
        if (settled) return;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxBytes) finish({ observable: false, active: false, trustStatus: 'unknown', reason: 'Codex app-server diagnostics exceeded 2 MiB.' });
    });
    child.on('error', () => finish({ observable: false, active: false, trustStatus: 'unknown', reason: 'Codex app-server is unavailable.' }));
    child.on('close', () => finish({ observable: false, active: false, trustStatus: 'unknown', reason: 'Codex app-server closed before hooks/list completed.' }));
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'personal_agent_control', title: 'Personal Agent Control', version: '1.0.0' },
      capabilities: null,
    } });
  });
}

function assertConfigObject(value, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PacError('SCAN_GUARD_CONFIG_INVALID', `Host config must be a JSON object: ${file}`);
  }
  if (value.hooks === undefined) value.hooks = {};
  if (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks)) {
    throw new PacError('SCAN_GUARD_CONFIG_INVALID', `hooks must be an object: ${file}`);
  }
  if (value.hooks.PreToolUse === undefined) value.hooks.PreToolUse = [];
  if (!Array.isArray(value.hooks.PreToolUse)) {
    throw new PacError('SCAN_GUARD_CONFIG_INVALID', `hooks.PreToolUse must be an array: ${file}`);
  }
}

function entryCommands(entry) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return [];
  return entry.hooks.filter((hook) => hook && typeof hook.command === 'string').map((hook) => hook.command);
}

function hasMarker(entry) {
  return entryCommands(entry).some((command) => command.includes(SCAN_GUARD_MARKER));
}

function markerEntries(config) {
  return config.hooks.PreToolUse.filter(hasMarker);
}

function readOwnership(context) {
  const file = statePath(context);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PacError('SCAN_GUARD_OWNERSHIP_INVALID', `Scan-guard ownership must be a regular file: ${file}`);
    }
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || Array.isArray(value) || ![2, SCAN_GUARD_SCHEMA].includes(value.schemaVersion)
        || typeof value.policyVersion !== 'number'
        || (value.sourceSha256 !== null && (typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceSha256)))
        || value.runtimeRelative !== RUNTIME_RELATIVE
        || !value.hosts || typeof value.hosts !== 'object' || Array.isArray(value.hosts)
        || Object.keys(value).some((key) => !['schemaVersion', 'policyVersion', 'sourceSha256', 'registrySha256', 'runtimeRelative', 'hosts'].includes(key))) {
      throw new PacError('SCAN_GUARD_OWNERSHIP_INVALID', 'Scan-guard ownership has an invalid schema.');
    }
    if (value.schemaVersion === 3 && value.registrySha256 !== null &&
        (typeof value.registrySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.registrySha256))) {
      throw new PacError('SCAN_GUARD_OWNERSHIP_INVALID', 'Scan-guard registry digest is invalid.');
    }
    for (const [host, entry] of Object.entries(value.hosts)) {
      if (!HOSTS.has(host) || !entry || Array.isArray(entry)
          || Object.keys(entry).sort().join(',') !== 'entrySha256,targetRelative'
          || entry.targetRelative !== configuredHostPath(context, host).relative
          || typeof entry.entrySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.entrySha256)) {
        throw new PacError('SCAN_GUARD_OWNERSHIP_INVALID', `Invalid scan-guard ownership entry: ${host}`);
      }
    }
    // Schema 2 did not bind the machine-local registry. Keep it readable for
    // one reconciliation pass, but status remains invalid until PAC records a
    // fresh digest in schema 3.
    return {
      ...value,
      schemaVersion: SCAN_GUARD_SCHEMA,
      registrySha256: value.schemaVersion === 3 ? value.registrySha256 : null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return {
      schemaVersion: SCAN_GUARD_SCHEMA,
      policyVersion: SCAN_GUARD_POLICY_VERSION,
      sourceSha256: null,
      registrySha256: null,
      runtimeRelative: RUNTIME_RELATIVE,
      hosts: {},
    };
    if (error instanceof PacError) throw error;
    throw new PacError('SCAN_GUARD_OWNERSHIP_INVALID', `Cannot read scan-guard ownership: ${error.message}`);
  }
}

function quotePosix(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

const TRUSTED_HELPERS = Object.freeze([
  Object.freeze({ skill: 'resource-guard', file: 'resource-guard.mjs', relative: 'scripts/resource-guard.mjs', flag: '--trusted-resource-guard' }),
  Object.freeze({ skill: 'workspace-locator', file: 'locator.mjs', relative: 'scripts/locator.mjs', flag: '--trusted-locator' }),
  Object.freeze({ skill: 'memory-continuity', file: 'memory-ledger.mjs', relative: 'scripts/memory-ledger.mjs', flag: '--trusted-memory-ledger' }),
  Object.freeze({ skill: 'project-contracts', file: 'check-project-contract.mjs', relative: 'scripts/check-project-contract.mjs', flag: '--trusted-project-contract' }),
  Object.freeze({ skill: 'runtime-hygiene', file: 'runtime-cleaner.mjs', relative: 'scripts/runtime-cleaner.mjs', flag: '--trusted-runtime-cleaner' }),
  Object.freeze({ skill: 'runtime-hygiene', file: 'artifact-publish.mjs', relative: 'scripts/artifact-publish.mjs', flag: '--trusted-artifact-publish' }),
  Object.freeze({ skill: 'gpu-experiment', file: 'gpu-plan.mjs', relative: 'scripts/gpu-plan.mjs', flag: '--trusted-gpu-plan' }),
]);
const REQUIRED_SCAN_HELPERS = Object.freeze(['resource-guard', 'workspace-locator']);

function profileHelperExpectations(profile) {
  if (!profile) return null;
  const result = new Map();
  for (const helper of TRUSTED_HELPERS) {
    const skill = profile.skills?.find((entry) => entry.name === helper.skill);
    let expected = null;
    try {
      if (skill?.root) {
        const source = path.join(skill.root, ...helper.relative.split('/'));
        const stat = fs.lstatSync(source);
        if (stat.isFile() && !stat.isSymbolicLink()) expected = fileDigest(source);
      }
    } catch { expected = null; }
    result.set(helper.file, expected);
  }
  return result;
}

function trustedExecutableCandidates(context, profile = null) {
  const expectations = profileHelperExpectations(profile);
  const candidates = TRUSTED_HELPERS.map((helper) => path.join(
    context.home, '.local/share/agent-skills/.agents/skills', helper.skill, helper.relative,
  ));
  return candidates.filter((candidate) => {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || syncedPath(candidate)) return false;
      const home = path.resolve(context.home);
      const homeStat = fs.lstatSync(home);
      if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || (homeStat.mode & 0o022) !== 0 ||
          (typeof process.getuid === 'function' && homeStat.uid !== process.getuid())) return false;
      const suffix = path.relative(home, path.resolve(candidate));
      if (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) return false;
      let cursor = home;
      for (const component of suffix.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, component);
        const item = fs.lstatSync(cursor);
        if (item.isSymbolicLink() || (item.mode & 0o022) !== 0 ||
            (typeof process.getuid === 'function' && item.uid !== process.getuid())) return false;
      }
      const expected = expectations?.get(path.basename(candidate));
      return expectations === null || (Boolean(expected) && fileDigest(candidate) === expected);
    } catch { return false; }
  });
}

function trustedHelperReadiness(context, profile = null) {
  const expectations = profileHelperExpectations(profile);
  const paths = trustedExecutableCandidates(context, profile);
  return {
    profileBound: expectations !== null,
    resourceGuard: paths.some((file) => path.basename(file) === 'resource-guard.mjs'),
    locator: paths.some((file) => path.basename(file) === 'locator.mjs'),
    paths,
    expected: expectations === null ? null : Object.fromEntries(expectations),
  };
}

function scanGuardProfileSelection(profile) {
  if (!profile) return { requested: false, skills: [] };
  const names = new Set((profile.skills || []).map((entry) =>
    typeof entry === 'string' ? entry : entry?.name).filter(Boolean));
  const required = [...REQUIRED_SCAN_HELPERS];
  const present = required.filter((name) => names.has(name));
  if (present.length > 0 && present.length !== required.length) {
    throw new PacError('SCAN_GUARD_PROFILE_INCOMPLETE',
      `Profile must select both scan-guard helpers or neither: ${required.join(', ')}`,
      { required, present });
  }
  return { requested: present.length === required.length, skills: present };
}

function fileDigest(file) {
  return digest(fs.readFileSync(file));
}

function approvedSystemNodeDigests(primaryLauncher) {
  if (process.platform === 'win32') return [];
  const digests = [];
  for (const candidate of ['/usr/bin/node']) {
    try {
      const resolved = path.resolve(candidate);
      if (resolved === path.resolve(primaryLauncher) || syncedPath(resolved)) continue;
      const root = path.parse(resolved).root;
      let cursor = root;
      for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, component);
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || stat.uid !== 0) throw new Error('unsafe system Node path');
      }
      const stat = fs.lstatSync(resolved);
      if (stat.isFile() && !stat.isSymbolicLink()) digests.push(fileDigest(resolved));
    } catch { /* optional fixed system Node is absent or unsafe */ }
  }
  return [...new Set(digests)].sort();
}

function registryPath(context) {
  return context.searchRegistryPath || path.join(context.home, '.config/personal-agent-control/search-roots.json');
}

function registryDigest(context) {
  const file = registryPath(context);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new PacError('SCAN_GUARD_REGISTRY_UNSAFE', `Search registry must be a private regular file: ${file}`);
  }
  const raw = fs.readFileSync(file);
  if (raw.length > 1024 * 1024) throw new PacError('SCAN_GUARD_REGISTRY_INVALID', `Search registry exceeds 1 MiB: ${file}`);
  const home = path.resolve(context.home);
  const suffix = path.relative(home, path.resolve(file));
  if (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
    throw new PacError('SCAN_GUARD_REGISTRY_UNSAFE', `Search registry must remain below HOME: ${file}`);
  }
  let cursor = home;
  for (const component of suffix.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const item = fs.lstatSync(cursor);
    if (item.isSymbolicLink() || (item.mode & 0o022) !== 0 ||
        (typeof process.getuid === 'function' && item.uid !== process.getuid())) {
      throw new PacError('SCAN_GUARD_REGISTRY_UNSAFE', `Search registry path is not owner-controlled: ${cursor}`);
    }
  }
  return { path: file, sha256: digest(raw), bytes: raw.length };
}

function hookCommand(context, host, hookRuntime, registryInfo = null, profile = null) {
  const trusted = trustedExecutableCandidates(context, profile);
  const launcher = fs.realpathSync(process.execPath);
  const approvedNodes = approvedSystemNodeDigests(launcher);
  const registry = registryInfo || registryDigest(context);
  const args = [
    // Strip user-controlled NODE_OPTIONS/LD_PRELOAD/etc. before Node loads the
    // policy. The hook needs only a deterministic HOME/PATH/locale.
    ...(process.platform === 'win32' ? [] : [quotePosix('/usr/bin/env'), '-i',
      quotePosix(`HOME=${context.home}`), quotePosix('PATH=/usr/bin:/bin'), quotePosix('LANG=C'), quotePosix('LC_ALL=C')]),
    quotePosix(launcher), quotePosix(hookRuntime), '--hook', '--host', host,
    '--home', quotePosix(context.home), '--runtime', quotePosix(path.dirname(hookRuntime)),
    '--registry', quotePosix(context.searchRegistryPath ||
      path.join(context.home, '.config/personal-agent-control/search-roots.json')),
    '--registry-sha256', quotePosix(registry.sha256),
    '--launcher', quotePosix(launcher), '--launcher-sha256', quotePosix(fileDigest(launcher)),
    ...approvedNodes.flatMap((value) => ['--approved-node-sha256', quotePosix(value)]),
    '--policy-sha256', quotePosix(fileDigest(hookRuntime)), '--marker', quotePosix(SCAN_GUARD_MARKER),
    '--approved-mcp-tool', quotePosix('mcp__codegraph__codegraph_explore'),
    '--approved-mcp-tool', quotePosix('mcp__plugin_codegraph_codegraph__codegraph_explore'),
    '--approved-mcp-tool', quotePosix('mcp__plugin_codegraph__codegraph_explore'),
  ];
  for (const helper of TRUSTED_HELPERS) {
    const candidate = trusted.find((value) => path.basename(value) === helper.file);
    if (candidate) args.push(helper.flag, quotePosix(candidate), `${helper.flag}-sha256`, quotePosix(fileDigest(candidate)));
  }
  return args.join(' ');
}

function expectedEntry(context, host, hookRuntime, registryInfo = null, profile = null) {
  return {
    matcher: HOST_CONFIGS[host].matcher,
    hooks: [{ type: 'command', command: hookCommand(context, host, hookRuntime, registryInfo, profile) }],
  };
}

function currentConfigEntry(config, host) {
  const entries = markerEntries(config);
  if (entries.length > 1) throw new PacError('SCAN_GUARD_DUPLICATE', `Multiple PAC scan-guard entries exist for ${host}.`);
  return entries[0] || null;
}

function ownedConfigEntry(config, prior, host) {
  if (!prior) return null;
  const matches = config.hooks.PreToolUse.filter((entry) => jsonDigest(entry) === prior.entrySha256);
  if (matches.length > 1) {
    throw new PacError('SCAN_GUARD_DUPLICATE', `Multiple entries match PAC scan-guard ownership for ${host}.`);
  }
  return matches[0] || null;
}

function validatePrior(prior, context, host) {
  if (!prior) return;
  if (prior.targetRelative !== configuredHostPath(context, host).relative
      || typeof prior.entrySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(prior.entrySha256)) {
    throw new PacError('SCAN_GUARD_OWNERSHIP_INVALID', `Invalid PAC scan-guard ownership for ${host}.`);
  }
}

function replaceEntry(config, priorEntry, nextEntry) {
  const index = priorEntry ? config.hooks.PreToolUse.indexOf(priorEntry) : -1;
  if (index >= 0) config.hooks.PreToolUse[index] = nextEntry;
  else config.hooks.PreToolUse.push(nextEntry);
}

async function verifyPinnedPolicySource(context, source, content) {
  const manifest = path.join(context.root, 'catalog/trusted-sources.sha256');
  let text;
  try { text = await fsp.readFile(manifest, 'utf8'); }
  catch (error) {
    throw new PacError('SCAN_GUARD_SOURCE_UNTRUSTED', `Trusted source manifest is missing: ${manifest}`, { cause: error.message });
  }
  const expected = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  ([^\r\n]+)$/u);
    if (!match || expected.has(match[2])) throw new PacError('SCAN_GUARD_SOURCE_UNTRUSTED', 'Trusted source manifest is malformed.');
    expected.set(match[2], match[1]);
  }
  const relative = path.relative(context.root, source).split(path.sep).join('/');
  if (expected.size !== 1 || expected.get(relative) !== digest(content)) {
    throw new PacError('SCAN_GUARD_SOURCE_UNTRUSTED', `Scan-guard policy is not pinned in ${manifest}.`, {
      source: relative, actual: digest(content), expected: expected.get(relative) || null,
    });
  }
}

async function ensurePrivateDirectory(directory, label, home) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const absolute = path.resolve(directory);
  const trustedHome = path.resolve(home);
  const suffix = path.relative(trustedHome, absolute);
  if (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
    throw new PacError('SCAN_GUARD_RUNTIME_UNSAFE', `${label} must be below HOME: ${absolute}`);
  }
  let cursor = trustedHome;
  const homeStat = await fsp.lstat(cursor);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || (homeStat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && homeStat.uid !== process.getuid())) {
    throw new PacError('SCAN_GUARD_RUNTIME_UNSAFE', `HOME is not a private directory: ${trustedHome}`);
  }
  for (const component of suffix.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fsp.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new PacError('SCAN_GUARD_RUNTIME_UNSAFE', `${label} is not a private directory: ${cursor}`);
    }
    await fsp.chmod(cursor, 0o700);
  }
}

async function stageRuntime(context) {
  const source = path.join(context.root, 'src/scan-guard-policy.mjs');
  const target = runtimePath(context);
  await assertSafeManagedObject(context.root, source, 'scan-guard policy source', 'file');
  await assertSafeManagedPath(context.home, path.dirname(target), 'scan-guard runtime directory');
  const content = await fsp.readFile(source);
  await verifyPinnedPolicySource(context, source, content);
  await ensurePrivateDirectory(path.dirname(target), 'Scan-guard runtime directory', context.home);
  const sourceSha256 = digest(content);
  let current = null;
  try { current = await fsp.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!current || !current.equals(content)) await atomicWriteFile(target, content, 0o500);
  await fsp.chmod(target, 0o500);
  const targetStat = await fsp.lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isFile() || (targetStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && targetStat.uid !== process.getuid())) {
    throw new PacError('SCAN_GUARD_RUNTIME_UNSAFE', `Scan-guard runtime is not a private regular file: ${target}`);
  }
  return { target, sourceSha256 };
}

async function writeConfigIfChanged(context, host, file, config, originalRaw) {
  const nextRaw = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  if (originalRaw && originalRaw.equals(nextRaw)) return false;
  // Compare-and-swap against an external writer. PAC's transaction lock
  // serializes PAC itself; this second read prevents silently clobbering a
  // host/plugin update that landed after our first read.
  let currentRaw = null;
  try { currentRaw = await fsp.readFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ((originalRaw && !currentRaw?.equals(originalRaw)) || (!originalRaw && currentRaw)) {
    throw new PacError('SCAN_GUARD_CONCURRENT_DRIFT', `Host config changed while PAC was reconciling it: ${file}`);
  }
  let mode = 0o600;
  try { mode = (await fsp.stat(file)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicWriteFile(file, nextRaw, mode || 0o600);
  try { await fsp.chmod(file, mode || 0o600); } catch { /* advisory on some mounts */ }
  return true;
}

function runtimeStatus(context, ownership) {
  const file = runtimePath(context);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      return { valid: false, state: 'unsafe', path: file };
    }
    const home = path.resolve(context.home);
    const suffix = path.relative(home, path.resolve(file));
    if (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
      return { valid: false, state: 'unsafe', path: file };
    }
    let cursor = home;
    for (const component of suffix.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const parent = fs.lstatSync(cursor);
      if (parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 ||
          (typeof process.getuid === 'function' && parent.uid !== process.getuid())) {
        return { valid: false, state: 'unsafe', path: file };
      }
    }
    const actual = digest(fs.readFileSync(file));
    return { valid: Boolean(ownership.sourceSha256) && actual === ownership.sourceSha256,
      state: 'present', path: file, sha256: actual };
  } catch (error) {
    if (error.code === 'ENOENT') return { valid: false, state: 'missing', path: file };
    throw error;
  }
}

async function retireRuntimeIfOwned(context, ownership) {
  if (Object.keys(ownership.hosts).length > 0) return { action: 'preserved' };
  const file = runtimePath(context);
  let stat;
  try { stat = await fsp.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { action: 'absent' };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      !ownership.sourceSha256 || fileDigest(file) !== ownership.sourceSha256) {
    throw new PacError('SCAN_GUARD_RUNTIME_DRIFT',
      `Refusing to retire a scan-guard runtime that no longer matches PAC ownership: ${file}`);
  }
  await fsp.unlink(file);
  ownership.sourceSha256 = null;
  ownership.registrySha256 = null;
  return { action: 'retired', path: file };
}

export async function scanGuardStatus(context, enabledHosts, scopeHosts, profile = null) {
  // Older locked/synthetic Core sources may not yet contain the replaceable
  // scan-gate seam. Do not manufacture a healthy entry for them; an existing
  // PAC-owned state, however, is unhealthy because its policy cannot be
  // refreshed or verified.
  if (!scanGuardSourceAvailable(context)) {
    const prior = readOwnership(context);
    if (Object.keys(prior.hosts || {}).length === 0) return [];
    return [...new Set(scopeHosts)].filter((host) => HOSTS.has(host)).map((host) => ({
      host, state: 'invalid', expected: enabledHosts.includes(host) ? 'managed' : 'missing',
      owned: Boolean(prior.hosts[host]), valid: false,
      error: 'PAC scan-guard source files are missing from the active Core source.',
    }));
  }
  const selection = scanGuardProfileSelection(profile);
  const enabled = new Set(selection.requested ? enabledHosts : []);
  const scope = new Set(scopeHosts);
  const ownership = readOwnership(context);
  if (!selection.requested && [...scope].every((host) => !ownership.hosts[host])) {
    return [...scope].filter((host) => HOSTS.has(host)).map((host) => ({
      host, state: 'inactive', expected: 'absent', owned: false, valid: true,
      reason: 'active Profile does not select both scan-guard helpers',
    }));
  }
  const runtime = runtimeStatus(context, ownership);
  const helperReadiness = trustedHelperReadiness(context, profile);
  let registry = null;
  let registryError = null;
  if (enabled.size > 0) {
    try { registry = registryDigest(context); }
    catch (error) { registryError = error; }
  }
  const results = [];
  for (const host of HOSTS) {
    if (!scope.has(host)) continue;
    let descriptor;
    try { descriptor = configuredHostPath(context, host); }
    catch (error) {
      results.push({ host, state: 'unsupported', expected: enabled.has(host) ? 'managed' : 'missing', valid: false, error: error.message });
      continue;
    }
    const { value: config } = readJsonFile(descriptor.file);
    assertConfigObject(config, descriptor.file);
    const actual = currentConfigEntry(config, host);
    const prior = ownership.hosts[host];
    validatePrior(prior, context, host);
    const owned = ownedConfigEntry(config, prior, host);
    const hostState = hostHookState(context, host, config);
    const disabled = hostState.disabled;
    const expected = enabled.has(host) && registry && runtime.valid
      ? expectedEntry(context, host, runtime.path, registry, profile) : null;
    const drifted = Boolean(prior) && (!actual || !owned || (actual && jsonDigest(actual) !== prior.entrySha256));
    const registryMismatch = enabled.has(host) &&
      (!registry || ownership.registrySha256 !== registry.sha256);
    const codexTrust = host === 'codex' && expected && actual && !drifted
      ? await codexHookTrustStatus(context, descriptor, expected)
      : null;
    const operational = host === 'codex' ? Boolean(codexTrust?.active) : !disabled;
    const structuralValid = enabled.has(host)
      ? Boolean(actual) && Boolean(expected) && !drifted && jsonDigest(actual) === jsonDigest(expected) && Boolean(prior)
        && runtime.valid && !disabled && hostState.activation !== 'unknown' && !registryError
        && helperReadiness.resourceGuard && helperReadiness.locator
        && !registryMismatch
      : prior ? !drifted && !actual : true;
    const pendingTrust = enabled.has(host) && host === 'codex' && structuralValid && !operational
      && codexTrust?.observable === true && codexTrust?.enabled === true
      && ['untrusted', 'modified'].includes(codexTrust?.trustStatus);
    const valid = enabled.has(host) ? structuralValid && operational : structuralValid;
    results.push({
      host, target: descriptor.file, expected: enabled.has(host) ? 'managed' : 'missing',
      state: drifted ? 'drift' : (actual ? 'managed' : 'missing'), owned: Boolean(prior), valid,
      structuralValid, pendingTrust,
      hooksDisabled: disabled, entrySha256: actual ? jsonDigest(actual) : null,
      hookTrust: codexTrust?.trustStatus || hostState.trust, operational,
      hookTrustProbe: codexTrust, activation: hostState.activation, runtime,
      registry: registry ? { path: registry.path, bytes: registry.bytes, sha256: registry.sha256,
        matchesOwnership: ownership.registrySha256 === registry.sha256 } : { error: registryError?.message || 'unavailable' },
      helpers: helperReadiness,
      error: drifted ? 'PAC scan-guard entry was removed or modified outside PAC.' :
        (enabled.has(host) ? registryError?.message : undefined) ||
          (enabled.has(host) && (!helperReadiness.resourceGuard || !helperReadiness.locator)
            ? 'PAC scan-guard helpers do not match the active Profile source.'
            : (enabled.has(host) && !runtime.valid
              ? `PAC scan-guard runtime is ${runtime.state}.`
              : (registryMismatch ? 'Search registry digest does not match PAC ownership.'
                : (enabled.has(host) && hostState.activation === 'unknown'
                  ? 'Codex hooks feature is not explicitly enabled.'
                  : (enabled.has(host) && host === 'codex' && !operational
                    ? (codexTrust?.reason || `Codex PAC hook trust is ${codexTrust?.trustStatus || 'unknown'}; review the exact entry in /hooks.`)
                    : undefined))))),
    });
  }
  return results;
}

export async function reconcileScanGuard(context, enabledHosts, scopeHosts, profile = null) {
  if (!scanGuardSourceAvailable(context)) {
    const prior = readOwnership(context);
    if (Object.keys(prior.hosts || {}).length > 0) {
      throw new PacError('SCAN_GUARD_SOURCE_MISSING',
        'PAC scan-guard source files are missing while an owned host entry still exists.');
    }
    return { skipped: true, reason: 'active Core source has no scan-guard seam', hosts: [] };
  }
  const selection = scanGuardProfileSelection(profile);
  const enabled = new Set(selection.requested ? enabledHosts : []);
  const scope = new Set(scopeHosts);
  const ownership = readOwnership(context);
  if (!selection.requested && [...scope].every((host) => !ownership.hosts[host])) {
    return { skipped: true, reason: 'active Profile does not select both scan-guard helpers',
      hosts: [...scope].filter((host) => HOSTS.has(host)).map((host) => ({ host, action: 'absent' })) };
  }
  const helperReadiness = trustedHelperReadiness(context, profile);
  if (enabled.size > 0 && (!helperReadiness.resourceGuard || !helperReadiness.locator)) {
    throw new PacError('SCAN_GUARD_HELPER_MISMATCH',
      'PAC scan-guard helpers are missing, unsafe, or differ from the active Profile source.', helperReadiness);
  }
  const runtime = enabled.size > 0 ? await stageRuntime(context) : null;
  const registry = enabled.size > 0 ? registryDigest(context) : null;
  if (runtime && registry) {
    ownership.policyVersion = SCAN_GUARD_POLICY_VERSION;
    ownership.sourceSha256 = runtime.sourceSha256;
    ownership.registrySha256 = registry.sha256;
    ownership.runtimeRelative = RUNTIME_RELATIVE;
  }
  const results = [];
  for (const host of HOSTS) {
    if (!scope.has(host)) continue;
    const descriptor = configuredHostPath(context, host);
    await assertSafeManagedObject(context.home, descriptor.file, `${host} scan-guard config`, 'file');
    const loaded = readJsonFile(descriptor.file);
    const config = loaded.value;
    assertConfigObject(config, descriptor.file);
    const actual = currentConfigEntry(config, host);
    const prior = ownership.hosts[host];
    validatePrior(prior, context, host);
    const owned = ownedConfigEntry(config, prior, host);
    const hostState = hostHookState(context, host, config);
    if (enabled.has(host)) {
      if (hostState.disabled || hostState.activation !== 'enabled') {
        throw new PacError('SCAN_GUARD_HOST_DISABLED', `${host} hooks are disabled or not explicitly enabled by host configuration: ${descriptor.file}`);
      }
      const expected = expectedEntry(context, host, runtime.target, registry, profile);
      if (prior && (!actual || !owned)) {
        throw new PacError('SCAN_GUARD_DRIFT', `PAC scan-guard entry was removed or modified outside PAC: ${descriptor.file}`);
      }
      if (actual && prior && jsonDigest(actual) !== prior.entrySha256) {
        throw new PacError('SCAN_GUARD_DRIFT', `PAC scan-guard entry was modified outside PAC: ${descriptor.file}`);
      }
      if (actual && !prior && jsonDigest(actual) !== jsonDigest(expected)) {
        throw new PacError('SCAN_GUARD_COLLISION', `An unmanaged scan-guard entry occupies the PAC marker in ${descriptor.file}`);
      }
      if (!actual) replaceEntry(config, null, expected);
      else if (jsonDigest(actual) !== jsonDigest(expected)) replaceEntry(config, actual, expected);
      const changed = await writeConfigIfChanged(context, host, descriptor.file, config, loaded.raw);
      ownership.hosts[host] = { targetRelative: descriptor.relative, entrySha256: jsonDigest(expected) };
      results.push({ host, action: changed ? (actual ? 'updated' : 'installed') : 'unchanged', target: descriptor.file });
      continue;
    }

    if (actual) {
      // A marker without PAC ownership is not ours to delete. This protects
      // an independently installed policy or a host-managed entry.
      if (!prior) {
        results.push({ host, action: 'preserved-unmanaged', target: descriptor.file });
        continue;
      }
      if (!owned) {
        throw new PacError('SCAN_GUARD_DRIFT', `Refusing to retire a removed or modified PAC scan-guard entry: ${descriptor.file}`);
      }
      if (jsonDigest(actual) !== prior.entrySha256) {
        throw new PacError('SCAN_GUARD_DRIFT', `Refusing to retire a modified PAC scan-guard entry: ${descriptor.file}`);
      }
      config.hooks.PreToolUse = config.hooks.PreToolUse.filter((entry) => entry !== actual);
      const changed = await writeConfigIfChanged(context, host, descriptor.file, config, loaded.raw);
      results.push({ host, action: changed ? 'retired' : 'already-retired', target: descriptor.file });
      delete ownership.hosts[host];
    } else {
      if (prior) {
        throw new PacError('SCAN_GUARD_DRIFT', `Refusing to retire a missing PAC scan-guard entry: ${descriptor.file}`);
      }
      results.push({ host, action: 'absent', target: descriptor.file });
    }
  }
  const retiredRuntime = enabled.size === 0 ? await retireRuntimeIfOwned(context, ownership) : null;
  await assertSafeManagedPath(context.home, context.stateDir, 'PAC scan-guard state directory');
  await fsp.mkdir(context.stateDir, { recursive: true, mode: 0o700 });
  await atomicWriteFile(statePath(context), `${JSON.stringify(ownership, null, 2)}\n`, 0o600);
  return { skipped: false,
    runtime: runtime ? { path: runtime.target, sourceSha256: runtime.sourceSha256 } : retiredRuntime,
    hosts: results };
}

export async function hasPriorScanGuardState(context, host) {
  if (!HOSTS.has(host)) throw new PacError('HOST_SELECTION_INVALID', `Unknown scan-guard host: ${host}`);
  const ownership = readOwnership(context);
  return Boolean(ownership.hosts[host]);
}
