import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject, assertSafeManagedPath } from './path-safety.mjs';
import { atomicWriteFile } from './atomic-file.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_SKILL_STORE = '~/.local/share/agent-skills';
export const SUPPORTED_AGENTS = Object.freeze({
  codex: Object.freeze({ skillsDirectory: '~/.agents/skills' }),
  claude: Object.freeze({ skillsDirectory: '~/.claude/skills' }),
});
export const HOSTS = Object.freeze(Object.keys(SUPPORTED_AGENTS));
const CANONICAL_HOST_DIRECTORIES = Object.fromEntries(
  Object.entries(SUPPORTED_AGENTS).map(([name, adapter]) => [name, adapter.skillsDirectory]),
);

export function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return path.resolve(value);
}

export function resolveContext(options = {}) {
  const requestedHome = path.resolve(options.home || process.env.HOME || os.homedir());
  let home;
  try { home = fsSync.realpathSync(requestedHome); }
  catch (error) {
    throw new PacError('UNSAFE_HOME', `HOME must be an existing directory: ${requestedHome}`, { cause: error.message });
  }
  if (home === path.parse(home).root) {
    throw new PacError('UNSAFE_HOME', `Refusing to use filesystem root as HOME: ${home}`);
  }
  if (!fsSync.statSync(home).isDirectory()) {
    throw new PacError('UNSAFE_HOME', `HOME must be a directory: ${home}`);
  }
  const requestedRoot = path.resolve(process.env.PAC_ROOT || SOURCE_ROOT);
  let root;
  try { root = fsSync.realpathSync(requestedRoot); }
  catch (error) {
    throw new PacError('SOURCE_INVALID', `PAC source must be an existing directory: ${requestedRoot}`, { cause: error.message });
  }
  if (!fsSync.statSync(root).isDirectory()) {
    throw new PacError('SOURCE_INVALID', `PAC source must be a directory: ${root}`);
  }
  const stateDir = path.join(home, '.local/state/personal-agent-control');
  const apmShim = path.join(home, '.local/share/mise/shims/apm');
  const pinnedApm = path.join(home, '.local/share/mise/installs/apm/0.28.0/apm');
  return {
    root,
    home,
    stateDir,
    manifestDir: path.join(root, 'packages/skills'),
    manifestPath: path.join(root, 'packages/skills/apm.yml'),
    lockPath: path.join(root, 'packages/skills/apm.lock.yaml'),
    configPath: path.join(root, 'pac.json'),
    machineConfigPath: path.join(home, '.config/personal-agent-control/machine.json'),
    profileConfigPath: path.join(home, '.config/personal-agent-control/profile.json'),
    profileWorkspaceConfigPath: path.join(home, '.config/personal-agent-control/profile-workspace.json'),
    profileBootstrapPath: path.join(home, '.config/personal-agent-control/profile-bootstrap.md'),
    profileBootstrapOwnershipPath: path.join(stateDir, 'profile-bootstrap.json'),
    profileStoreDir: path.join(home, '.local/share/personal-agent-profiles'),
    profileWorkspaceRoot: path.join(home, '.local/share/personal-agent-profile-workspaces/default'),
    profileRuntimeStoreDir: path.join(home, '.local/share/personal-agent-profile-runtimes'),
    apm: process.env.PAC_APM
      || (fsSync.existsSync(pinnedApm) ? pinnedApm : (fsSync.existsSync(apmShim) ? apmShim : 'apm')),
  };
}

export async function loadConfig(context) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(context.configPath, 'utf8'));
  } catch (error) {
    throw new PacError('CONFIG_INVALID', `Cannot read ${context.configPath}: ${error.message}`);
  }
  if (config.schemaVersion !== 1 || typeof config.hosts !== 'object') {
    throw new PacError('CONFIG_INVALID', 'pac.json must use schemaVersion 1 and declare hosts.');
  }
  for (const host of HOSTS) {
    const entry = config.hosts[host];
    if (!entry || typeof entry.enabled !== 'boolean' || typeof entry.skillsDirectory !== 'string') {
      throw new PacError('CONFIG_INVALID', `pac.json has an invalid ${host} host entry.`);
    }
  }
  if (!Array.isArray(config.plugins?.enabled)) {
    throw new PacError('CONFIG_INVALID', 'pac.json plugins.enabled must be an array.');
  }
  if (config.neutralSkillStore !== CANONICAL_SKILL_STORE) {
    throw new PacError('CONFIG_INVALID', `pac.json neutralSkillStore must remain ${CANONICAL_SKILL_STORE}.`);
  }
  for (const host of HOSTS) {
    if (config.hosts[host].skillsDirectory !== CANONICAL_HOST_DIRECTORIES[host]) {
      throw new PacError('CONFIG_INVALID', `pac.json ${host}.skillsDirectory must remain ${CANONICAL_HOST_DIRECTORIES[host]}.`);
    }
  }
  if (config.plugins.enabled.some((name) => typeof name !== 'string')
      || new Set(config.plugins.enabled).size !== config.plugins.enabled.length) {
    throw new PacError('CONFIG_INVALID', 'pac.json plugins.enabled must contain unique Plugin names.');
  }
  await assertSafeManagedPath(context.home, context.stateDir, 'PAC state directory');
  await assertSafeManagedPath(context.home, skillStore(context, config), 'neutral Skill store');
  return config;
}

export async function saveConfig(context, config) {
  await assertSafeManagedObject(context.root, context.configPath, 'PAC source configuration', 'file');
  await atomicWriteFile(context.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function validateEnabledHosts(value, code = 'MACHINE_PROFILE_INVALID') {
  if (!Array.isArray(value)) {
    throw new PacError(code, 'enabledHosts must be an ordered array.');
  }
  const unknown = value.filter((host) => typeof host !== 'string' || !HOSTS.includes(host));
  if (unknown.length) {
    throw new PacError(code, `enabledHosts contains unknown host IDs: ${unknown.join(', ')}`);
  }
  if (new Set(value).size !== value.length) {
    throw new PacError(code, 'enabledHosts must not contain duplicate host IDs.');
  }
  return [...value];
}

function machineConfigPath(context) {
  return context.machineConfigPath || path.join(context.home, '.config/personal-agent-control/machine.json');
}

export async function loadMachineProfile(context, sourceConfig) {
  const file = machineConfigPath(context);
  await assertSafeManagedObject(context.home, file, 'PAC machine profile', 'file');
  let profile;
  try {
    profile = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        schemaVersion: 1,
        enabledHosts: HOSTS.filter((host) => sourceConfig.hosts[host].enabled),
        origin: 'source-default',
      };
    }
    throw new PacError('MACHINE_PROFILE_INVALID', `Cannot read ${file}: ${error.message}`);
  }
  if (!profile || Array.isArray(profile) || profile.schemaVersion !== 1) {
    throw new PacError('MACHINE_PROFILE_INVALID', 'machine.json must use schemaVersion 1.');
  }
  return {
    schemaVersion: 1,
    enabledHosts: validateEnabledHosts(profile.enabledHosts),
    origin: 'machine',
  };
}

export async function saveMachineProfile(context, enabledHosts) {
  const profile = { schemaVersion: 1, enabledHosts: validateEnabledHosts(enabledHosts) };
  const file = machineConfigPath(context);
  const directory = path.dirname(file);
  await assertSafeManagedObject(context.home, file, 'PAC machine profile', 'file');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeManagedPath(context.home, directory, 'PAC machine profile directory');
  const temp = path.join(directory, `.machine.json.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await assertSafeManagedObject(context.home, file, 'PAC machine profile', 'file');
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return { ...profile, origin: 'machine' };
}

export function effectiveEnabledHosts(profile, override) {
  const enabled = validateEnabledHosts(profile.enabledHosts, 'HOST_SELECTION_INVALID');
  if (!override || override === 'all') return enabled;
  const requested = new Set(validateEnabledHosts(override.split(','), 'HOST_SELECTION_INVALID'));
  return enabled.filter((host) => requested.has(host));
}

export function enabledHosts(config, override) {
  if (override) return override === 'all' ? [...HOSTS] : override.split(',');
  return HOSTS.filter((host) => config.hosts[host].enabled);
}

export function skillStore(context, config) {
  return path.resolve(expandHome(config.neutralSkillStore, context.home));
}

export function hostSkillDirectory(context, config, host) {
  return expandHome(config.hosts[host].skillsDirectory, context.home);
}
