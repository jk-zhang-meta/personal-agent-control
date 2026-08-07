import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PacError } from './errors.mjs';
import { HOSTS, hostSkillDirectory } from './config.mjs';
import { assertSafeManagedObject, assertSafeManagedPath } from './path-safety.mjs';
import { atomicWriteFile } from './atomic-file.mjs';

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

export const atomicWrite = atomicWriteFile;

async function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function outerTransactionMarkers(context) {
  try {
    return (await fs.readdir(context.stateDir))
      .filter((name) => /^chezmoi-transaction-[0-9]+$/u.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function borrowOuterLock(context, lockDir, owner, transaction) {
  if (owner.kind !== 'chezmoi-outer' || owner.token !== transaction.token
      || owner.pid !== transaction.ownerPid || !await processExists(Number(owner.pid))) {
    return null;
  }
  let marker;
  try {
    const stat = await fs.lstat(transaction.marker);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    marker = await fs.readFile(transaction.marker, 'utf8');
  } catch { return null; }
  if (marker !== transaction.markerText) return null;

  const claim = `${transaction.marker}.claim`;
  let handle;
  try {
    handle = await fs.open(claim, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({
      token: transaction.token,
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new PacError('PAC_CHEZMOI_TRANSACTION_USED', 'The Chezmoi outer transaction has already been consumed.', {
        transaction: transaction.marker,
      });
    }
    throw error;
  } finally { await handle?.close(); }

  // The top-level Chezmoi process owns this lock through final commit or
  // rollback.  The nested PAC mutation borrows it and must never release it.
  return async () => {
    let current;
    try { current = JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')); }
    catch { current = {}; }
    if (current.kind !== 'chezmoi-outer' || current.token !== transaction.token) {
      throw new PacError('PAC_LOCK_OWNERSHIP', 'Chezmoi outer lock ownership changed during the nested PAC mutation.', {
        lockDir,
        expectedToken: transaction.token,
        actualToken: current.token,
      });
    }
  };
}

export async function acquireLock(context, options = {}) {
  const lockDir = path.join(context.stateDir, 'pac.lock');
  await assertSafeManagedPath(context.home, context.stateDir, 'PAC state directory');
  await fs.mkdir(context.stateDir, { recursive: true, mode: 0o700 });
  const markers = await outerTransactionMarkers(context);
  if (markers.length && !options.outerTransaction) {
    try { await fs.lstat(lockDir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new PacError('PAC_LOCK_STALE', 'A Chezmoi outer transaction requires completion or explicit recovery.', {
        transactions: markers.map((name) => path.join(context.stateDir, name)),
      });
    }
  }
  const token = crypto.randomUUID();
  const owner = { token, pid: process.pid, startedAt: new Date().toISOString(), command: process.argv.slice(2) };
  const candidate = `${lockDir}.acquire-${token}`;
  try {
    await fs.mkdir(candidate, { mode: 0o700 });
    await fs.writeFile(path.join(candidate, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    try { await fs.rm(candidate, { recursive: true, force: true }); } catch { /* preserve acquisition evidence */ }
    throw error;
  }
  try {
    await fs.rename(candidate, lockDir);
  } catch (error) {
    try { await fs.rm(candidate, { recursive: true, force: true }); } catch { /* preserve acquisition evidence */ }
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    let currentOwner;
    try { currentOwner = JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')); }
    catch { currentOwner = {}; }
    if (options.outerTransaction) {
      const borrowed = await borrowOuterLock(context, lockDir, currentOwner, options.outerTransaction);
      if (borrowed) return borrowed;
    }
    if (await processExists(Number(currentOwner.pid))) {
      throw new PacError('PAC_LOCKED', `Another PAC mutation is active (pid ${currentOwner.pid}).`, currentOwner);
    }
    throw new PacError('PAC_LOCK_STALE', `A stale PAC lock requires explicit recovery: ${lockDir}`, {
      lockDir,
      owner: currentOwner,
      recovery: `Verify that no PAC process is active, then remove only ${lockDir}.`,
    });
  }
  return async () => {
    const quarantine = `${lockDir}.release-${token}`;
    try { await fs.rename(lockDir, quarantine); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    let releasedOwner;
    try { releasedOwner = JSON.parse(await fs.readFile(path.join(quarantine, 'owner.json'), 'utf8')); }
    catch { releasedOwner = {}; }
    if (releasedOwner.token !== token) {
      try { await fs.rename(quarantine, lockDir); } catch { /* preserve evidence in quarantine */ }
      throw new PacError('PAC_LOCK_OWNERSHIP', 'PAC lock ownership changed before release.', {
        expectedToken: token,
        actualToken: releasedOwner.token,
        quarantine,
      });
    }
    await fs.rm(quarantine, { recursive: true, force: true });
  };
}

export async function withLock(context, callback, options = {}) {
  const release = await acquireLock(context, options);
  try { return await callback(); }
  finally { await release(); }
}

export async function readOwnedSkills(context) {
  try {
    const text = await fs.readFile(path.join(context.stateDir, 'owned-skills.txt'), 'utf8');
    return new Set(text.split(/\r?\n/u).filter(Boolean));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

export async function readOwnedSkillMap(context) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(context.stateDir, 'owned-skill-map.json'), 'utf8'));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.skills)) return new Map();
    return new Map(parsed.skills.map((entry) => [entry.id, entry]));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return new Map();
    throw error;
  }
}

export async function writeOwnedSkills(context, names) {
  const sorted = [...new Set(names)].sort();
  await atomicWrite(path.join(context.stateDir, 'owned-skills.txt'), `${sorted.join('\n')}\n`);
}

async function writeOwnedSkillMap(context, skills) {
  const normalized = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  await atomicWrite(path.join(context.stateDir, 'owned-skill-map.json'), `${JSON.stringify({
    schemaVersion: 1,
    skills: normalized,
  }, null, 2)}\n`);
}

function assertSafeName(name) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)) {
    throw new PacError('SKILL_NAME_UNSAFE', `Unsafe Skill name: ${name}`);
  }
}

async function realDirectory(context, directory, label) {
  await assertSafeManagedObject(context.home, directory, label, 'directory');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeManagedObject(context.home, directory, label, 'directory');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PacError('PATH_UNSAFE', `${label} must be a real directory: ${directory}`);
}

async function existingRealDirectory(context, directory, label) {
  await assertSafeManagedObject(context.home, directory, label, 'directory');
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PacError('PATH_UNSAFE', `${label} must be a real directory: ${directory}`);
  }
  return true;
}

async function linkPointsTo(link, target) {
  try {
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink()) return false;
    return path.resolve(path.dirname(link), await fs.readlink(link)) === path.resolve(target);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function neutralLinkTarget(link, physicalRoot) {
  try {
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink()) return null;
    const target = path.resolve(path.dirname(link), await fs.readlink(link));
    return path.dirname(target) === path.resolve(physicalRoot) ? target : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function skillTargetsHost(skill, host) {
  if (skill.targets === undefined) return true;
  if (!Array.isArray(skill.targets) || skill.targets.length === 0
      || new Set(skill.targets).size !== skill.targets.length
      || skill.targets.some((target) => !HOSTS.includes(target))) {
    throw new PacError('SKILL_TARGETS_INVALID', `Managed Skill ${skill.id} has invalid host targets.`);
  }
  return skill.targets.includes(host);
}

export async function preflightProjectionCollisions(context, config, neutralStore, desiredSkills, selectedHosts = HOSTS) {
  const owned = await readOwnedSkills(context);
  const physicalRoot = path.join(neutralStore, '.agents/skills');
  const entries = desiredSkills.map((entry) => typeof entry === 'string' ? { id: entry } : entry);
  for (const host of selectedHosts) {
    const root = hostSkillDirectory(context, config, host);
    await assertSafeManagedObject(context.home, root, `${host} Skill directory`, 'directory');
    for (const entry of entries.filter((candidate) => skillTargetsHost(candidate, host))) {
      const { id } = entry;
      assertSafeName(id);
      const candidate = path.join(root, id);
      try {
        await fs.lstat(candidate);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (owned.has(id) && await neutralLinkTarget(candidate, physicalRoot)) continue;
      throw new PacError('SKILL_COLLISION', `Unmanaged entry blocks PAC projection: ${candidate}`);
    }
  }
}

export async function discoverApmSkills(neutralStore, lock) {
  const root = path.join(neutralStore, '.agents/skills');
  const expected = new Set(lock.dependencies.map((dependency) => dependency.name));
  const byId = new Map();
  let directories;
  try { directories = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { throw new PacError('SKILL_INVALID', `Cannot inspect APM Skill root ${root}: ${error.message}`); }
  for (const directory of directories) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const physicalName = directory.name;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(physicalName)) continue;
    const skillFile = path.join(root, physicalName, 'SKILL.md');
    let text;
    try { text = await fs.readFile(skillFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u)?.[1];
    const id = frontmatter?.match(/^name:\s*['"]?([^'"\s]+)['"]?\s*$/mu)?.[1];
    if (!id || !expected.has(id)) continue;
    assertSafeName(id);
    if (byId.has(id)) throw new PacError('SKILL_DUPLICATE_NAME', `Multiple physical directories declare managed Skill name ${id}.`);
    byId.set(id, { id, physicalName, engine: 'apm' });
  }
  const missing = [...expected].filter((id) => !byId.has(id));
  if (missing.length) throw new PacError('SKILL_INVALID', `APM did not materialize locked Skill(s): ${missing.join(', ')}`);
  return [...byId.values()];
}

export async function reconcileProjections(context, config, neutralStore, desiredSkills, selectedHosts, scopedHosts = HOSTS) {
  const ownedBefore = await readOwnedSkills(context);
  const ownedMap = await readOwnedSkillMap(context);
  const desiredMap = new Map(desiredSkills.map((entry) => [entry.id, entry]));
  if (desiredMap.size !== desiredSkills.length) throw new PacError('SKILL_DUPLICATE_NAME', 'Desired Skill identifiers are not unique.');
  const desired = new Set(desiredMap.keys());
  const selected = new Set(selectedHosts);
  const scope = new Set(scopedHosts);
  const physicalRoot = path.join(neutralStore, '.agents/skills');

  for (const [name, mapping] of desiredMap) {
    assertSafeName(name);
    assertSafeName(mapping.physicalName);
    const physical = path.join(physicalRoot, mapping.physicalName);
    let stat;
    try { stat = await fs.lstat(physical); }
    catch (error) { if (error.code === 'ENOENT') throw new PacError('SKILL_MISSING', `Managed Skill is missing: ${physical}`); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PacError('SKILL_UNSAFE', `Managed Skill must be a real directory: ${physical}`);
    const skill = await fs.lstat(path.join(physical, 'SKILL.md')).catch(() => null);
    if (!skill?.isFile() || skill.isSymbolicLink()) throw new PacError('SKILL_INVALID', `Managed Skill lacks a regular SKILL.md: ${physical}`);
  }

  for (const host of HOSTS) {
    if (!scope.has(host)) continue;
    const root = hostSkillDirectory(context, config, host);
    const enabled = selected.has(host);
    if (enabled) await realDirectory(context, root, `${host} Skill directory`);
    else if (!await existingRealDirectory(context, root, `${host} Skill directory`)) continue;
    const candidates = enabled ? new Set([...ownedBefore, ...desired]) : ownedBefore;
    for (const name of candidates) {
      assertSafeName(name);
      const link = path.join(root, name);
      const mapping = desiredMap.get(name) || ownedMap.get(name) || { physicalName: name };
      assertSafeName(mapping.physicalName);
      const physical = path.join(physicalRoot, mapping.physicalName);
      const shouldExist = enabled && desired.has(name) && skillTargetsHost(mapping, host);
      const isManagedLink = await linkPointsTo(link, physical);
      if (shouldExist) {
        if (isManagedLink) continue;
        try {
          await fs.lstat(link);
          if (ownedBefore.has(name) && await neutralLinkTarget(link, physicalRoot)) {
            await fs.unlink(link);
          } else {
            throw new PacError('SKILL_COLLISION', `Unmanaged entry blocks PAC projection: ${link}`);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await fs.symlink(path.relative(root, physical), link, 'dir');
      } else if (isManagedLink) {
        await fs.unlink(link);
      }
    }
  }
  await writeOwnedSkills(context, desired);
  await writeOwnedSkillMap(context, desiredMap.values());
  return { ownedBefore: [...ownedBefore].sort(), ownedAfter: [...desired].sort() };
}

export async function hasPriorHostState(context, config, neutralStore, host) {
  if ((await ownedAdapterTargets(context, host)).length) return true;
  if ((await readOwnedPluginRows(context)).some((entry) => entry.targets.includes(host))) return true;

  const owned = await readOwnedSkills(context);
  if (!owned.size) return false;
  const ownedMap = await readOwnedSkillMap(context);
  const root = hostSkillDirectory(context, config, host);
  try { await assertSafeManagedObject(context.home, root, `${host} Skill directory`, 'directory'); }
  catch (error) { if (error.code === 'PATH_UNSAFE') return false; throw error; }
  const physicalRoot = path.join(neutralStore, '.agents/skills');
  for (const name of owned) {
    assertSafeName(name);
    const mapping = ownedMap.get(name) || { physicalName: name };
    assertSafeName(mapping.physicalName);
    if (await linkPointsTo(path.join(root, name), path.join(physicalRoot, mapping.physicalName))) return true;
  }
  return false;
}

async function copyPath(source, destination) {
  try {
    await fs.lstat(source);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}

function safeRelative(relative) {
  return relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..');
}

const BACKUP_REGULAR_FILES = new Set([
  '.config/personal-agent-control/machine.json',
  '.config/personal-agent-control/profile.json',
  '.config/personal-agent-control/profile-bootstrap.md',
  '.config/personal-agent-control/state.boltdb',
  '.local/state/personal-agent-control/owned-host-adapters.json',
  '.local/state/personal-agent-control/profile-bootstrap.json',
  '.local/state/personal-agent-control/owned-skills.txt',
  '.local/state/personal-agent-control/owned-skill-map.json',
  '.local/state/personal-agent-control/owned-plugins.tsv',
  '.local/state/personal-agent-control/external-skills.json',
  '.local/share/agent-skills/apm.lock.yaml',
  '.codex/config.toml',
  '.codex/AGENTS.md',
  '.codex/agents/independent-reviewer.toml',
  '.claude.json',
  '.claude/.claude.json',
  '.claude/settings.json',
  '.claude/plugins/installed_plugins.json',
  '.claude/plugins/known_marketplaces.json',
  '.claude/CLAUDE.md',
  '.claude/agents/independent-reviewer.md',
]);

function backupObjectType(relative) {
  if (BACKUP_REGULAR_FILES.has(relative)) return 'file';
  const prefixes = [
    ['.local/state/personal-agent-control/migrations/', 'file'],
    ['.local/share/agent-skills/.agents/skills/', 'directory'],
    ['.local/share/agent-plugins/sources/', 'directory'],
    ['.codex/plugins/cache/', 'directory'],
    ['.codex/.tmp/marketplaces/', 'directory'],
    ['.claude/plugins/cache/', 'directory'],
    ['.claude/plugins/marketplaces/', 'directory'],
    ['.agents/skills/', 'any'],
    ['.claude/skills/', 'any'],
  ];
  if (relative === '.local/share/agent-skills/apm_modules') return 'directory';
  for (const [prefix, type] of prefixes) {
    if (!relative.startsWith(prefix)) continue;
    const name = relative.slice(prefix.length);
    assertSafeName(name);
    return type;
  }
  throw new PacError('BACKUP_PATH_UNSAFE', `Path is outside the restore allowlist: ${relative}`);
}

async function catalogRows(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function validatedPluginTargets(value, code, label) {
  const targets = typeof value === 'string' ? value.split(',') : [];
  if (!targets.length || new Set(targets).size !== targets.length
      || targets.some((host) => !HOSTS.includes(host))) {
    throw new PacError(code, `${label} has invalid host targets: ${value}`);
  }
  return targets;
}

async function readOwnedPluginRows(context) {
  const file = path.join(context.stateDir, 'owned-plugins.tsv');
  await assertSafeManagedObject(context.home, file, 'Plugin ownership state', 'file');
  let lines;
  try { lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/u); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (lines.shift() !== '# plugin\tmarketplace\ttargets') {
    throw new PacError('PLUGIN_OWNERSHIP_INVALID', 'Invalid Plugin ownership header.');
  }
  const seen = new Set();
  return lines.filter(Boolean).map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 3) throw new PacError('PLUGIN_OWNERSHIP_INVALID', `Invalid Plugin ownership row: ${line}`);
    const [plugin, marketplace, targetsText] = fields;
    assertSafeName(plugin);
    assertSafeName(marketplace);
    const identity = `${plugin}@${marketplace}`;
    if (seen.has(identity)) throw new PacError('PLUGIN_OWNERSHIP_INVALID', `Duplicate Plugin ownership identity: ${identity}`);
    seen.add(identity);
    return { plugin, marketplace, targets: validatedPluginTargets(targetsText, 'PLUGIN_OWNERSHIP_INVALID', identity) };
  });
}

const ADAPTER_BACKUP_TARGETS = {
  codex: new Set(['.codex/AGENTS.md', '.codex/agents/independent-reviewer.toml']),
  claude: new Set(['.claude/CLAUDE.md', '.claude/agents/independent-reviewer.md']),
};

async function ownedAdapterTargets(context, host) {
  const file = path.join(context.stateDir, 'owned-host-adapters.json');
  await assertSafeManagedObject(context.home, file, 'host-adapter ownership', 'file');
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new PacError('HOST_ADAPTER_OWNERSHIP_INVALID', `Cannot read host-adapter ownership: ${error.message}`);
  }
  const entries = parsed?.schemaVersion === 1 && parsed.hosts && !Array.isArray(parsed.hosts)
    ? parsed.hosts[host]
    : undefined;
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.some((entry) => !entry || Array.isArray(entry)
      || !ADAPTER_BACKUP_TARGETS[host].has(entry.targetRelative)
      || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256))) {
    throw new PacError('HOST_ADAPTER_OWNERSHIP_INVALID', `Invalid ${host} host-adapter ownership.`);
  }
  return entries.map((entry) => entry.targetRelative);
}

function validatedHostSet(value, label) {
  const hosts = [...new Set(value)];
  if (hosts.some((host) => !HOSTS.includes(host))) {
    throw new PacError('HOST_SELECTION_INVALID', `${label} contains an unknown host.`);
  }
  return new Set(hosts);
}

export async function createBackup(context, config, neutralStore, desiredSkills, options = {}) {
  const owned = await readOwnedSkills(context);
  const ownedMap = await readOwnedSkillMap(context);
  const ownedPlugins = await readOwnedPluginRows(context);
  const desiredMap = new Map(desiredSkills.map((entry) => [entry.id, entry]));
  const names = new Set([...owned, ...desiredMap.keys()]);
  const physicalNames = new Set();
  for (const mapping of [...ownedMap.values(), ...desiredSkills]) {
    assertSafeName(mapping.id);
    assertSafeName(mapping.physicalName);
    physicalNames.add(mapping.physicalName);
  }
  const plugins = await catalogRows(path.join(context.root, 'catalog/plugins.tsv'));
  const migrations = await catalogRows(path.join(context.root, 'catalog/plugin-migrations.tsv'));
  const activeHosts = validatedHostSet(
    options.activeHosts || HOSTS.filter((host) => config.hosts[host].enabled),
    'activeHosts',
  );
  const cleanupHosts = validatedHostSet(options.cleanupHosts || [], 'cleanupHosts');
  for (const host of activeHosts) cleanupHosts.delete(host);
  const paths = new Set([
    '.config/personal-agent-control/machine.json',
    '.config/personal-agent-control/profile.json',
    '.config/personal-agent-control/profile-bootstrap.md',
    '.config/personal-agent-control/state.boltdb',
    '.local/state/personal-agent-control/owned-host-adapters.json',
    '.local/state/personal-agent-control/profile-bootstrap.json',
    '.local/state/personal-agent-control/owned-skills.txt',
    '.local/state/personal-agent-control/owned-skill-map.json',
    '.local/state/personal-agent-control/owned-plugins.tsv',
    '.local/state/personal-agent-control/external-skills.json',
    '.local/state/personal-agent-control/migrations/neutral-skill-store-v1',
    '.local/share/agent-skills/apm.lock.yaml',
    '.local/share/agent-skills/apm_modules',
  ]);
  for (const name of names) {
    assertSafeName(name);
    paths.add(`.local/share/agent-skills/.agents/skills/${name}`);
    const desiredEntry = desiredMap.get(name);
    if (activeHosts.has('codex') && (owned.has(name) || !desiredEntry || skillTargetsHost(desiredEntry, 'codex'))) {
      paths.add(`.agents/skills/${name}`);
    }
    if (activeHosts.has('claude') && (owned.has(name) || !desiredEntry || skillTargetsHost(desiredEntry, 'claude'))) {
      paths.add(`.claude/skills/${name}`);
    }
  }
  for (const host of cleanupHosts) {
    const root = hostSkillDirectory(context, config, host);
    let safe = true;
    try { await assertSafeManagedObject(context.home, root, `${host} Skill directory`, 'directory'); }
    catch (error) { if (error.code === 'PATH_UNSAFE') safe = false; else throw error; }
    if (!safe) continue;
    for (const name of owned) {
      const mapping = ownedMap.get(name) || { physicalName: name };
      assertSafeName(name);
      assertSafeName(mapping.physicalName);
      const physical = path.join(neutralStore, '.agents/skills', mapping.physicalName);
      if (await linkPointsTo(path.join(root, name), physical)) {
        paths.add(`${host === 'codex' ? '.agents/skills' : '.claude/skills'}/${name}`);
      }
    }
  }
  for (const physicalName of physicalNames) {
    paths.add(`.local/share/agent-skills/.agents/skills/${physicalName}`);
  }
  if (activeHosts.has('codex')) {
    paths.add('.codex/config.toml');
    paths.add('.codex/AGENTS.md');
    paths.add('.codex/agents/independent-reviewer.toml');
  }
  if (activeHosts.has('claude')) {
    paths.add('.claude.json');
    paths.add('.claude/.claude.json');
    paths.add('.claude/settings.json');
    paths.add('.claude/plugins/installed_plugins.json');
    paths.add('.claude/plugins/known_marketplaces.json');
    paths.add('.claude/CLAUDE.md');
    paths.add('.claude/agents/independent-reviewer.md');
  }
  for (const host of cleanupHosts) {
    for (const target of await ownedAdapterTargets(context, host)) paths.add(target);
  }

  const addPluginArtifacts = (marketplace, targets) => {
    assertSafeName(marketplace);
    const relevant = targets.filter((host) => activeHosts.has(host) || cleanupHosts.has(host));
    if (!relevant.length) return;
    paths.add(`.local/share/agent-plugins/sources/${marketplace}`);
    for (const host of relevant) {
      if (host === 'codex') {
        paths.add('.codex/config.toml');
        paths.add(`.codex/plugins/cache/${marketplace}`);
        paths.add(`.codex/.tmp/marketplaces/${marketplace}`);
      } else {
        paths.add('.claude.json');
        paths.add('.claude/.claude.json');
        paths.add('.claude/settings.json');
        paths.add('.claude/plugins/installed_plugins.json');
        paths.add('.claude/plugins/known_marketplaces.json');
        paths.add(`.claude/plugins/cache/${marketplace}`);
        paths.add(`.claude/plugins/marketplaces/${marketplace}`);
      }
    }
  };

  for (const fields of plugins) {
    if (fields.length !== 12) throw new PacError('PLUGIN_CATALOG_INVALID', 'Invalid Plugin catalog row in backup inventory.');
    const [plugin, marketplace, , , , , , , targetsText] = fields;
    assertSafeName(plugin);
    addPluginArtifacts(
      marketplace,
      validatedPluginTargets(targetsText, 'PLUGIN_CATALOG_INVALID', `${plugin}@${marketplace}`)
        .filter((host) => activeHosts.has(host)),
    );
  }
  for (const entry of ownedPlugins) {
    addPluginArtifacts(entry.marketplace, entry.targets);
  }
  for (const fields of migrations) {
    if (fields.length !== 5) throw new PacError('PLUGIN_MIGRATION_INVALID', 'Invalid Plugin migration row in backup inventory.');
    const [plugin, marketplace, targetsText, , marker] = fields;
    assertSafeName(plugin);
    assertSafeName(marker);
    const targets = validatedPluginTargets(targetsText, 'PLUGIN_MIGRATION_INVALID', `${plugin}@${marketplace}`)
      .filter((host) => activeHosts.has(host));
    addPluginArtifacts(marketplace, targets);
    for (const host of targets) paths.add(`.local/state/personal-agent-control/migrations/${marker}-${host}`);
  }
  const managedPaths = [...paths].sort();
  for (const relative of managedPaths) {
    if (!safeRelative(relative)) throw new PacError('BACKUP_PATH_UNSAFE', `Unsafe backup path: ${relative}`);
    await assertSafeManagedObject(
      context.home,
      path.join(context.home, relative),
      `PAC backup source ${relative}`,
      backupObjectType(relative),
    );
  }
  const repoPaths = [
    'pac.json',
    'packages/skills/apm.yml',
    'packages/skills/apm.lock.yaml',
    'catalog/capabilities.jsonl',
    'catalog/files.sha256',
  ];
  for (const relative of repoPaths) {
    if (!Object.hasOwn(options.repositoryBytes || {}, relative)) {
      await assertSafeManagedObject(
        context.root,
        path.join(context.root, relative),
        `PAC repository backup source ${relative}`,
        'file',
      );
    }
  }
  const backup = path.join(
    context.home,
    '.agent-work/backups/personal-agent-control',
    `${utcStamp()}-${process.pid}-${crypto.randomUUID()}`,
  );
  const backupHome = path.join(backup, 'home');
  await assertSafeManagedPath(context.home, backup, 'PAC backup directory');
  try {
    await fs.mkdir(backupHome, { recursive: true, mode: 0o700 });
    for (const relative of managedPaths) {
      const source = path.join(context.home, relative);
      await assertSafeManagedObject(
        context.home,
        source,
        `PAC backup source ${relative}`,
        backupObjectType(relative),
      );
      await copyPath(source, path.join(backupHome, relative));
    }
    await fs.writeFile(path.join(backup, 'managed-paths.txt'), `${managedPaths.join('\n')}\n`, { mode: 0o600 });
    for (const relative of repoPaths) {
      const destination = path.join(backup, 'repo', relative);
      if (Object.hasOwn(options.repositoryBytes || {}, relative)) {
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.writeFile(destination, options.repositoryBytes[relative], { mode: 0o600 });
      } else {
        await copyPath(path.join(context.root, relative), destination);
      }
    }
    await fs.writeFile(path.join(backup, 'managed-repo-paths.txt'), `${repoPaths.join('\n')}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(backup, 'metadata.txt'), `kind=pac-transaction\nsource=${context.root}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
    await atomicWrite(path.join(context.stateDir, 'last-backup'), `${backup}\n`);
    return backup;
  } catch (error) {
    try {
      await assertSafeManagedPath(context.home, backup, 'PAC incomplete backup');
      await fs.rm(backup, { recursive: true, force: true });
    } catch { /* leave an unreferenced snapshot when safe cleanup cannot be proven */ }
    throw error;
  }
}

function managedPathCovers(parent, child) {
  return parent === child || child.startsWith(`${parent}/`);
}

function desiredStateBackupPaths(desiredSkills, options = {}) {
  const activeHosts = validatedHostSet(options.activeHosts || [], 'activeHosts');
  const desiredPlugins = new Set(options.desiredPlugins || []);
  const paths = new Set([
    '.config/personal-agent-control/profile.json',
    '.config/personal-agent-control/profile-bootstrap.md',
    '.local/state/personal-agent-control/profile-bootstrap.json',
    '.local/state/personal-agent-control/owned-skills.txt',
    '.local/state/personal-agent-control/owned-skill-map.json',
    '.local/state/personal-agent-control/owned-plugins.tsv',
  ]);

  for (const skill of desiredSkills) {
    assertSafeName(skill.id);
    assertSafeName(skill.physicalName);
    paths.add(`.local/share/agent-skills/.agents/skills/${skill.physicalName}`);
    if (activeHosts.has('codex') && skillTargetsHost(skill, 'codex')) {
      paths.add(`.agents/skills/${skill.id}`);
    }
    if (activeHosts.has('claude') && skillTargetsHost(skill, 'claude')) {
      paths.add(`.claude/skills/${skill.id}`);
    }
  }

  for (const entry of options.pluginEntries || []) {
    if (!desiredPlugins.has(entry.name)) continue;
    assertSafeName(entry.name);
    assertSafeName(entry.marketplace);
    const targets = validatedPluginTargets(
      entry.targets,
      'PLUGIN_CATALOG_INVALID',
      `${entry.name}@${entry.marketplace}`,
    ).filter((host) => activeHosts.has(host));
    if (!targets.length) continue;
    paths.add(`.local/share/agent-plugins/sources/${entry.marketplace}`);
    for (const host of targets) {
      if (host === 'codex') {
        paths.add('.codex/config.toml');
        paths.add(`.codex/plugins/cache/${entry.marketplace}`);
        paths.add(`.codex/.tmp/marketplaces/${entry.marketplace}`);
      } else {
        paths.add('.claude.json');
        paths.add('.claude/.claude.json');
        paths.add('.claude/settings.json');
        paths.add('.claude/plugins/installed_plugins.json');
        paths.add('.claude/plugins/known_marketplaces.json');
        paths.add(`.claude/plugins/cache/${entry.marketplace}`);
        paths.add(`.claude/plugins/marketplaces/${entry.marketplace}`);
      }
    }
  }
  return [...paths].sort();
}

/**
 * Extend a snapshot created before an optional Profile was resolved.  Existing
 * entries are immutable; only newly managed desired-state paths are captured.
 */
export async function augmentBackup(
  context,
  backup,
  desiredSkills,
  options = {},
) {
  const backupRoot = path.join(context.home, '.agent-work/backups/personal-agent-control');
  const resolvedBackup = path.resolve(backup);
  if (path.dirname(resolvedBackup) !== backupRoot) {
    throw new PacError('BACKUP_INVALID', `Backup is outside the PAC backup root: ${backup}`);
  }
  await assertSafeManagedObject(context.home, backupRoot, 'PAC backup root', 'directory');
  await assertSafeManagedObject(context.home, resolvedBackup, 'PAC backup', 'directory');
  const backupHome = path.join(resolvedBackup, 'home');
  const manifest = path.join(resolvedBackup, 'managed-paths.txt');
  const metadata = path.join(resolvedBackup, 'metadata.txt');
  await assertSafeManagedObject(context.home, backupHome, 'PAC backup home', 'directory');
  await assertSafeManagedObject(context.home, manifest, 'PAC backup manifest', 'file');
  await assertSafeManagedObject(context.home, metadata, 'PAC backup metadata', 'file');
  const metadataText = await fs.readFile(metadata, 'utf8');
  if (!metadataText.split(/\r?\n/u).includes(`source=${context.root}`)) {
    throw new PacError('BACKUP_INVALID', 'Backup belongs to a different PAC source.');
  }

  const existingLines = (await fs.readFile(manifest, 'utf8')).split(/\r?\n/u).filter(Boolean);
  const existing = new Set(existingLines);
  if (existing.size !== existingLines.length) {
    throw new PacError('BACKUP_INVALID', `Backup manifest contains duplicate paths: ${manifest}`);
  }
  const additions = desiredStateBackupPaths(desiredSkills, options)
    .filter((relative) => ![...existing].some((prior) => managedPathCovers(prior, relative)));

  for (const relative of additions) {
    if (!safeRelative(relative)) throw new PacError('BACKUP_PATH_UNSAFE', `Unsafe backup path: ${relative}`);
    const type = backupObjectType(relative);
    const source = path.join(context.home, relative);
    await assertSafeManagedObject(context.home, source, `PAC backup source ${relative}`, type);
    const destination = path.join(backupHome, relative);
    try {
      await fs.lstat(destination);
      throw new PacError('BACKUP_INVALID', `Unmanifested object already exists in the backup: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await copyPath(source, destination);
    existing.add(relative);
  }
  if (additions.length) {
    await atomicWrite(manifest, `${[...existing].sort().join('\n')}\n`);
  }
  return { backup: resolvedBackup, added: additions };
}

export async function writeReceipt(context, data) {
  const directory = path.join(context.stateDir, 'receipts');
  const file = path.join(directory, `${utcStamp()}-${process.pid}.json`);
  await atomicWrite(file, `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), ...data }, null, 2)}\n`);
  return file;
}

export async function sha256File(file) {
  try {
    const content = await fs.readFile(file);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
