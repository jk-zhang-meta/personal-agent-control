import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadConfig, loadMachineProfile, saveMachineProfile, effectiveEnabledHosts,
  skillStore, hostSkillDirectory, HOSTS,
} from './config.mjs';
import {
  readManifestDependencies, readLock, renderManifest, stageDependencies,
  installFrozen, apmVersion, verifyRuntimeContent,
} from './apm.mjs';
import {
  withLock, createBackup, augmentBackup, readOwnedSkills, reconcileProjections, discoverApmSkills,
  readOwnedSkillMap, writeReceipt, sha256File, preflightProjectionCollisions, atomicWrite,
  hasPriorHostState,
} from './state.mjs';
import {
  applyMaterializerExceptions, materializerStatus, selectedMaterializerExceptions,
} from './materializers.mjs';
import { pluginCatalog, reconcilePlugins } from './plugins.mjs';
import {
  acquireProfile, loadActiveProfile, loadProfileDescriptor, profileStatus,
  removeProfileDescriptor, saveProfileDescriptor, validateProfileWorkspace,
} from './profile.mjs';
import {
  applyProfileSkills, profileSkillEntries, profileSkillStatus, retireProfileSkills,
} from './profile-skills.mjs';
import {
  syncProfileSkillCapabilities,
} from './capabilities.mjs';
import { run } from './exec.mjs';
import { PacError, usage } from './errors.mjs';
import { verifyCanonicalPayload } from './integrity.mjs';
import { hostAdapterStatus, reconcileHostAdapters } from './host-adapters.mjs';
import { scanGuardStatus, reconcileScanGuard } from './scan-guard.mjs';
import { providerStatus, reconcileProviders } from './providers.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';
import { profileBootstrapStatus, reconcileProfileBootstrap } from './profile-bootstrap.mjs';
import {
  installProfileApm, profileApmProvisionalEntries, profileApmStatus,
} from './profile-apm.mjs';
import {
  commitProfileWorkspace, ensureProfileWorkspace, loadWorkspaceDescriptor,
  profileWorkspaceRepository, publishProfileWorkspace, syncProfileWorkspace,
} from './profile-workspace.mjs';

function provisionalSkills(lock, profile = null, materializers = []) {
  return [
    ...lock.dependencies.map((entry) => ({
      id: entry.name,
      physicalName: entry.virtualPath ? path.posix.basename(entry.virtualPath) : entry.name,
      engine: 'apm',
    })),
    ...materializers.map((entry) => ({ id: entry.name, physicalName: entry.name, engine: entry.engine })),
    ...profileApmProvisionalEntries(profile),
    ...profileSkillEntries(profile),
  ];
}

function assertUniqueSkills(skills) {
  const ids = new Set();
  const physicalNames = new Set();
  for (const skill of skills) {
    if (ids.has(skill.id)) throw new PacError('SKILL_DUPLICATE_NAME', `Duplicate managed Skill name: ${skill.id}`);
    if (physicalNames.has(skill.physicalName)) {
      throw new PacError('SKILL_DUPLICATE_NAME', `Duplicate managed physical Skill name: ${skill.physicalName}`);
    }
    ids.add(skill.id);
    physicalNames.add(skill.physicalName);
  }
  return skills;
}

function effectivePluginNames(config, profile) {
  const disabled = new Set(profile?.manifest?.plugins?.disabled || []);
  return [...new Set([
    ...config.plugins.enabled,
    ...(profile?.manifest?.plugins?.enabled || []),
  ])].filter((name) => !disabled.has(name)).sort();
}

function profileResolverArgs(profile) {
  return profile ? ['--profile', profile.root] : [];
}

async function resolveProfileForApply(context, requested) {
  if (requested === undefined) {
    return { profile: await loadActiveProfile(context), descriptorAction: 'keep' };
  }
  if (requested === null) return { profile: null, descriptorAction: 'remove' };
  if (requested.mode === 'seed') {
    const existing = await loadProfileDescriptor(context);
    if (existing) return { profile: await loadActiveProfile(context), descriptorAction: 'keep' };
  }
  let acquisition = requested;
  if (requested.mode === 'update') {
    const descriptor = await loadProfileDescriptor(context);
    if (!descriptor) throw new PacError('PROFILE_NOT_CONFIGURED', 'No Configuration Profile is configured.');
    acquisition = {
      repository: descriptor.repository,
      ref: descriptor.ref,
      expectedCommit: requested.expectedCommit,
    };
  }
  const { mode: _mode, ...acquisitionRequest } = acquisition;
  const profile = await acquireProfile(context, acquisitionRequest);
  return { profile, descriptorAction: 'save' };
}

function profileRequestFromEnvironment() {
  const repository = process.env.PAC_PROFILE_REPO;
  const ref = process.env.PAC_PROFILE_REF;
  const expectedCommit = process.env.PAC_PROFILE_COMMIT;
  if (!repository && (ref || expectedCommit)) {
    throw new PacError('PROFILE_ENV_INVALID', 'PAC_PROFILE_REF and PAC_PROFILE_COMMIT require PAC_PROFILE_REPO.');
  }
  return repository
    ? { mode: 'seed', repository, ref: ref || 'main', expectedCommit: expectedCommit || undefined }
    : undefined;
}

function scopedHosts(options = {}) {
  if (!options.hosts || options.hosts === 'all') return [...HOSTS];
  return options.hosts.split(',');
}

function includeHostInScope(options, host) {
  const scope = new Set(options.hosts ? scopedHosts(options) : []);
  scope.add(host);
  return HOSTS.filter((candidate) => scope.has(candidate)).join(',');
}

function includeHostsInScope(options, hosts) {
  const scope = new Set(options.hosts ? scopedHosts(options) : []);
  for (const host of hosts) scope.add(host);
  return HOSTS.filter((candidate) => scope.has(candidate)).join(',');
}

function configForEnabledHosts(config, hosts) {
  const enabled = new Set(hosts);
  const effective = structuredClone(config);
  for (const host of HOSTS) effective.hosts[host].enabled = enabled.has(host);
  return effective;
}

async function runResolver(context, args) {
  if (process.env.PAC_NO_RESOLVER === '1') return { skipped: true, reason: 'PAC_NO_RESOLVER' };
  const executable = process.env.PAC_RESOLVER || path.join(
    context.root, 'payload/skills/capability-resolver/scripts/capability-resolver.mjs',
  );
  const { stdout } = await run(process.execPath, [executable, ...args], {
    cwd: context.root,
    errorCode: 'RESOLVER_FAILED',
  });
  try { return JSON.parse(stdout); }
  catch { return { output: stdout.trim() }; }
}

async function restore(context, backup) {
  const override = process.env.PAC_RESTORE;
  const executable = override || 'sh';
  const args = override ? [backup] : [path.join(context.root, 'scripts/restore-backup.sh'), backup];
  return await run(executable, args, {
    cwd: context.root,
    env: { ...process.env, HOME: context.home },
    errorCode: 'ROLLBACK_FAILED',
  });
}

function deferredResolverAfterOuterRestore() {
  return {
    skipped: true,
    reason: 'chezmoi-outer-source-state-not-archived',
    next: 'run pac apply after the Chezmoi transaction completes',
  };
}

async function backupKind(backup) {
  const metadata = await fs.readFile(path.join(backup, 'metadata.txt'), 'utf8');
  const kinds = metadata.split(/\r?\n/u).filter((line) => line.startsWith('kind='));
  if (kinds.length === 0) return 'pac-transaction';
  if (kinds.length !== 1) throw new PacError('BACKUP_INVALID', `Backup metadata declares multiple kinds: ${backup}`);
  return kinds[0].slice('kind='.length);
}

async function outerTransactionFromEnvironment(context) {
  const requestedBackup = process.env.PAC_PRECREATED_BACKUP || '';
  const requestedMarker = process.env.PAC_CHEZMOI_TRANSACTION || '';
  const requestedToken = process.env.PAC_CHEZMOI_TOKEN || '';
  if (!requestedBackup && !requestedMarker && !requestedToken) return null;
  if (!requestedBackup || !requestedMarker || !requestedToken) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The complete Chezmoi transaction authorization is required.');
  }
  if (!path.isAbsolute(requestedBackup) || !path.isAbsolute(requestedMarker)
      || !/^[A-Za-z0-9]+$/u.test(requestedToken)) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi transaction authorization is malformed.');
  }

  const marker = path.resolve(requestedMarker);
  const markerName = path.basename(marker);
  const markerMatch = markerName.match(/^chezmoi-transaction-([0-9]+)$/u);
  if (!markerMatch || path.dirname(marker) !== context.stateDir) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi transaction marker is outside the PAC state directory.');
  }
  const ownerPid = Number(markerMatch[1]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi transaction owner PID is invalid.');
  }
  await assertSafeManagedObject(context.home, marker, 'Chezmoi transaction marker', 'file');
  let markerStat;
  try { markerStat = await fs.lstat(marker); }
  catch (error) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', `Cannot read the Chezmoi transaction marker: ${error.message}`);
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi transaction marker must be a real regular file.');
  }

  const backup = path.resolve(requestedBackup);
  let canonicalBackup;
  try { canonicalBackup = await fs.realpath(backup); }
  catch (error) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', `Cannot resolve the Chezmoi outer backup: ${error.message}`);
  }
  if (canonicalBackup !== backup) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi outer backup must be a canonical non-symlink path.');
  }
  const backupRoot = path.join(context.home, '.agent-work/backups/personal-agent-control');
  if (path.dirname(backup) !== backupRoot) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi outer backup is outside the PAC backup root.');
  }
  const markerText = await fs.readFile(marker, 'utf8');
  if (markerText !== `${backup}\n${requestedToken}\n`) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi transaction marker does not authorize this backup and token.');
  }
  try {
    const claim = await fs.lstat(`${marker}.claim`);
    if (!claim.isFile() || claim.isSymbolicLink()) {
      throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi transaction claim is unsafe.');
    }
    throw new PacError('PAC_CHEZMOI_TRANSACTION_USED', 'The Chezmoi outer transaction has already been consumed.', {
      transaction: marker,
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lastBackup = path.join(context.stateDir, 'last-backup');
  let lastBackupText;
  try {
    const stat = await fs.lstat(lastBackup);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a real regular file');
    lastBackupText = await fs.readFile(lastBackup, 'utf8');
  } catch (error) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', `Cannot validate last-backup ownership: ${error.message}`);
  }
  if (lastBackupText !== `${backup}\n`) {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'The Chezmoi transaction does not own last-backup.');
  }

  await run('sh', [path.join(context.root, 'scripts/restore-backup.sh'), '--validate', backup], {
    cwd: context.root,
    env: { ...process.env, HOME: context.home },
    errorCode: 'PAC_CHEZMOI_TRANSACTION_INVALID',
  });
  if (await backupKind(backup) !== 'chezmoi-outer') {
    throw new PacError('PAC_CHEZMOI_TRANSACTION_INVALID', 'PAC_PRECREATED_BACKUP must be a Chezmoi outer snapshot.');
  }
  return {
    backup,
    marker,
    markerText,
    token: requestedToken,
    ownerPid,
  };
}

async function postDoctor(context, hosts, profile = null) {
  if (process.env.PAC_SKIP_POST_DOCTOR === '1' || hosts.length === 0) {
    return { skipped: true, state: 'skipped', healthy: null };
  }
  const override = process.env.PAC_DOCTOR;
  const executable = override || 'sh';
  const args = [
    ...(override ? [] : [
      path.join(context.root, 'scripts/doctor.sh'),
      '--allow-pending-codex-hook-trust',
    ]),
    '--home', context.home, '--agents', hosts.join(','),
    ...profileResolverArgs(profile),
  ];
  const result = await run(executable, args, {
    cwd: context.root,
    env: { ...process.env, HOME: context.home },
    errorCode: 'POST_APPLY_VERIFICATION_FAILED',
  });
  const output = result.stdout.trim();
  const staged = !override && output.startsWith('STAGED:');
  return { skipped: false, state: staged ? 'staged' : 'healthy', healthy: !staged, output };
}

async function rebuildResolverAfterRestore(context, neutral) {
  try { await fs.access(path.join(neutral, 'apm.lock.yaml')); }
  catch (error) {
    if (error.code === 'ENOENT') return { skipped: true, reason: 'restored-runtime-is-empty' };
    throw error;
  }
  const profile = await loadActiveProfile(context);
  return await runResolver(context, [
    'rebuild', '--repo', context.root, '--home', context.home,
    ...profileResolverArgs(profile),
  ]);
}

async function preflightManagedDrift(
  context,
  config,
  neutral,
  lock,
  hosts,
  profile,
  materializerEntries,
  options = {},
) {
  const [owned, ownedMap] = await Promise.all([readOwnedSkills(context), readOwnedSkillMap(context)]);
  const desired = assertUniqueSkills(provisionalSkills(lock, profile, materializerEntries));
  await preflightProjectionCollisions(context, config, neutral, desired, hosts);
  const bootstrap = await profileBootstrapStatus(context, profile);
  if (!bootstrap.valid && bootstrap.exists && !options.allowProfileReplacement) {
    throw new PacError(
      'PROFILE_BOOTSTRAP_DRIFT',
      `Profile bootstrap differs from the locked Profile: ${bootstrap.target}`,
      bootstrap,
    );
  }
  if (owned.size === 0) return { checked: false, reason: 'no-prior-ownership' };

  const materializers = await materializerStatus(neutral, materializerEntries);
  const modifiedException = materializers.find(
    (entry) => owned.has(entry.name) && entry.installed && !entry.valid,
  );
  if (modifiedException) {
    throw new PacError('MANAGED_DRIFT', `Managed Skill ${modifiedException.name} differs from its reviewed content.`, modifiedException);
  }

  const profileApm = await profileApmStatus(context, profile);
  if (!profileApm.valid && profileApm.state !== 'missing' && !options.allowProfileReplacement) {
    throw new PacError(
      'MANAGED_DRIFT',
      'The locked Profile APM runtime is missing or differs from its lock.',
      profileApm,
    );
  }
  const driftProfile = profile && profileApm.valid ? {
    ...profile,
    skills: [...profile.skills, ...profileApm.skills],
  } : profile;
  const profileSkills = await profileSkillStatus(neutral, driftProfile);
  const modifiedProfile = profileSkills.find((entry) => owned.has(entry.id) && !entry.valid);
  if (modifiedProfile && !options.allowProfileReplacement) {
    throw new PacError('MANAGED_DRIFT', `Managed Profile Skill ${modifiedProfile.id} differs from its locked content.`, modifiedProfile);
  }

  const runtimeLock = path.join(neutral, 'apm.lock.yaml');
  try { await fs.access(runtimeLock); }
  catch (error) {
    if (error.code === 'ENOENT') return { checked: false, reason: 'legacy-pre-apm-state' };
    throw error;
  }
  const transitionalProfileRoots = [...ownedMap.values()]
    .filter((entry) => ['profile', 'profile-apm', 'skills'].includes(entry.engine))
    .map((entry) => entry.physicalName);
  const allowed = [
    ...materializerEntries.map((entry) => entry.name),
    ...profileSkillEntries(profile).map((entry) => entry.physicalName),
    ...transitionalProfileRoots,
  ];
  const verified = await verifyRuntimeContent(neutral, allowed);
  return { checked: true, engine: 'runtime-lock-hashes', ...verified };
}

async function applyUnlocked(context, options = {}) {
  const config = await loadConfig(context);
  const machine = await loadMachineProfile(context, config);
  const sourceIntegrity = await verifyCanonicalPayload(context);
  const profileResolution = await resolveProfileForApply(context, options.profileRequest);
  const profile = profileResolution.profile;
  const scope = scopedHosts(options);
  const enabled = effectiveEnabledHosts(machine);
  const scopedEnabledHosts = enabled.filter((host) => scope.includes(host));
  const effectiveConfig = configForEnabledHosts(config, enabled);
  const neutral = skillStore(context, config);
  const provenCleanupHosts = [];
  for (const host of scope) {
    if (!enabled.includes(host) && await hasPriorHostState(context, effectiveConfig, neutral, host)) {
      provenCleanupHosts.push(host);
    }
  }
  const reconciliationScope = HOSTS.filter((host) => scopedEnabledHosts.includes(host) || provenCleanupHosts.includes(host));
  const canonicalLock = await readLock(context);
  const materializerEntries = await selectedMaterializerExceptions(profile);
  const provisional = assertUniqueSkills(provisionalSkills(canonicalLock, profile, materializerEntries));
  const knownPlugins = await pluginCatalog(context, profile);
  const effectivePlugins = effectivePluginNames(config, profile);
  const unknownPlugins = effectivePlugins.filter((name) => !knownPlugins.some((entry) => entry.name === name));
  if (unknownPlugins.length) throw new PacError('PLUGIN_UNKNOWN', `Unknown Plugin(s): ${unknownPlugins.join(', ')}`);
  // Reject already-installed Plugins outside PAC's catalog before APM or host
  // projections are touched. A late rejection would require rollback while a
  // host may be loading a projected Skill.
  await reconcilePlugins(context, effectiveConfig, scopedEnabledHosts, 'preflight', profile);
  await preflightManagedDrift(
    context,
    effectiveConfig,
    neutral,
    canonicalLock,
    scopedEnabledHosts,
    profile,
    materializerEntries,
    { allowProfileReplacement: profileResolution.descriptorAction !== 'keep' },
  );
  const backup = options.precreatedBackup
    || await createBackup(
      context,
      configForEnabledHosts(config, enabled),
      neutral,
      provisional,
      { activeHosts: scopedEnabledHosts, cleanupHosts: provenCleanupHosts },
    );
  await augmentBackup(context, backup, provisional, {
    activeHosts: scopedEnabledHosts,
    pluginEntries: knownPlugins,
    desiredPlugins: effectivePlugins,
  });
  try {
    if (profileResolution.descriptorAction === 'save') {
      await saveProfileDescriptor(context, profile.descriptor);
    } else if (profileResolution.descriptorAction === 'remove') {
      await removeProfileDescriptor(context);
    }
    const bootstrap = await reconcileProfileBootstrap(context, profile);
    const lock = await installFrozen(context, neutral);
    const [owned, priorOwnedMap] = await Promise.all([readOwnedSkills(context), readOwnedSkillMap(context)]);
    const materializers = await applyMaterializerExceptions(context, neutral, owned, materializerEntries);
    const profileApm = await installProfileApm(context, profile);
    const effectiveProfile = profile ? {
      ...profile,
      skills: [...profile.skills, ...profileApm.skills],
    } : null;
    const profileSkills = await applyProfileSkills(context, neutral, effectiveProfile, priorOwnedMap);
    const apmSkills = await discoverApmSkills(neutral, lock);
    const desired = assertUniqueSkills([
      ...apmSkills,
      ...materializers.map((entry) => ({ id: entry.name, physicalName: entry.name, engine: entry.engine })),
      ...profileSkills.map((entry) => ({
        id: entry.id,
        physicalName: entry.physicalName,
        engine: entry.engine,
        targets: [...entry.targets],
      })),
    ]);
    const adapters = await reconcileHostAdapters(context, enabled, reconciliationScope);
    const providers = await reconcileProviders(context, effectiveProfile, enabled, reconciliationScope, 'apply');
    const projections = await reconcileProjections(context, effectiveConfig, neutral, desired, enabled, reconciliationScope);
    const retiredProfileSkills = await retireProfileSkills(context, neutral, priorOwnedMap, desired);
    const plugins = await reconcilePlugins(context, effectiveConfig, reconciliationScope, 'apply', profile);
    // Native Plugin reconciliation can refresh host hook files; install the
    // PAC fragment last so the final transaction state is what status checks.
    const scanGuard = await reconcileScanGuard(context, enabled, reconciliationScope, effectiveProfile);
    const resolver = await runResolver(context, [
      'rebuild', '--repo', context.root, '--home', context.home,
      ...profileResolverArgs(profile),
    ]);
    const verification = await postDoctor(context, scopedEnabledHosts, profile);
    const receipt = await writeReceipt(context, {
      operation: 'apply', backup, hosts: scopedEnabledHosts, enabledHosts: enabled,
      neutralSkillStore: neutral, skills: desired, plugins: effectivePlugins,
      providers: providers.providers,
      verification: { state: verification.state, healthy: verification.healthy },
      profile: profile ? { configured: true, ref: profile.descriptor.ref, lockedCommit: profile.lockedCommit } : { configured: false },
    });
    return {
      backup, receipt, hosts: scopedEnabledHosts, neutralSkillStore: neutral, skills: desired,
      materializers, profileSkills, retiredProfileSkills,
      profile: profile ? { configured: true, ref: profile.descriptor.ref, lockedCommit: profile.lockedCommit } : { configured: false },
      bootstrap, profileApm, adapters, scanGuard, providers, projections, plugins, resolver, verification, sourceIntegrity,
    };
  } catch (error) {
    try {
      await restore(context, backup);
      const resolver = options.precreatedBackupKind === 'chezmoi-outer'
        ? deferredResolverAfterOuterRestore()
        : await rebuildResolverAfterRestore(context, neutral);
      error.details = {
        ...(error.details || {}),
        rollback: { attempted: true, succeeded: true, backup, resolver },
      };
    } catch (rollbackError) {
      throw new PacError('APPLY_AND_ROLLBACK_FAILED', `${error.message}; rollback also failed: ${rollbackError.message}`, {
        applyError: error.details, rollbackError: rollbackError.details, backup,
      });
    }
    throw error;
  }
}

async function apply(context, options, outerTransaction = null) {
  const applyOptions = outerTransaction
    ? { ...options, precreatedBackup: outerTransaction.backup, precreatedBackupKind: 'chezmoi-outer' }
    : options;
  return await withLock(
    context,
    () => applyUnlocked(context, applyOptions),
    outerTransaction ? { outerTransaction } : {},
  );
}

async function projectionStatus(context, config, neutral, skills, hosts, scoped = HOSTS) {
  const selected = new Set(hosts);
  const scope = new Set(scoped);
  const results = [];
  for (const host of HOSTS) {
    if (!scope.has(host)) continue;
    const root = hostSkillDirectory(context, config, host);
    await assertSafeManagedObject(context.home, root, `${host} Skill directory`, 'directory');
    for (const skill of skills) {
      const link = path.join(root, skill.id);
      const target = path.join(neutral, '.agents/skills', skill.physicalName);
      let state = 'missing';
      try {
        const stat = await fs.lstat(link);
        if (stat.isSymbolicLink() && path.resolve(path.dirname(link), await fs.readlink(link)) === target) state = 'managed';
        else state = 'collision';
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const compatible = skill.targets === undefined || skill.targets.includes('*') || skill.targets.includes(host);
      const expected = selected.has(host) && compatible ? 'managed' : 'missing';
      const valid = state === expected || (!compatible && state === 'collision');
      results.push({
        host,
        skill: skill.id,
        physicalName: skill.physicalName,
        targets: skill.targets,
        state,
        expected,
        valid,
      });
    }
  }
  return results;
}

async function status(context, options = {}) {
  const config = await loadConfig(context);
  const machine = await loadMachineProfile(context, config);
  let sourceIntegrity;
  try { sourceIntegrity = await verifyCanonicalPayload(context); }
  catch (error) {
    sourceIntegrity = {
      valid: false,
      code: error.code || 'SOURCE_INTEGRITY_INVALID',
      error: error.message,
      details: error.details,
    };
  }
  let profile;
  let profileState;
  try {
    profileState = await profileStatus(context);
    profileState.valid = !profileState.configured || profileState.state === 'ready';
    if (profileState.state === 'ready') profile = await loadActiveProfile(context);
  } catch (error) {
    profileState = {
      configured: true,
      valid: false,
      state: 'invalid',
      code: error.code || 'PROFILE_INVALID',
      error: error.message,
      details: error.details,
    };
    profile = null;
  }
  const enabled = effectiveEnabledHosts(machine);
  const scope = scopedHosts(options);
  const activeScope = enabled.filter((host) => scope.includes(host));
  const effectiveConfig = configForEnabledHosts(config, enabled);
  const neutral = skillStore(context, config);
  const canonicalLock = await readLock(context);
  const canonicalLockHash = await sha256File(context.lockPath);
  const runtimeLockPath = path.join(neutral, 'apm.lock.yaml');
  const runtimeLockHash = await sha256File(runtimeLockPath);
  let runtimeLock;
  try { runtimeLock = await readLock(context, runtimeLockPath); }
  catch { runtimeLock = null; }
  const [ownedNames, ownedMap] = await Promise.all([readOwnedSkills(context), readOwnedSkillMap(context)]);
  const priorProfileRoots = [...ownedMap.values()]
    .filter((entry) => ['profile', 'profile-apm'].includes(entry.engine))
    .map((entry) => entry.physicalName);
  const profileApm = await profileApmStatus(context, profile);
  const effectiveProfile = profile ? {
    ...profile,
    skills: [...profile.skills, ...profileApm.skills],
  } : null;
  const materializerEntries = await selectedMaterializerExceptions(profile);
  let runtimeContent;
  try {
    runtimeContent = {
      valid: true,
      ...(await verifyRuntimeContent(neutral, [
        ...materializerEntries.map((entry) => entry.name),
        ...profileSkillEntries(effectiveProfile).map((entry) => entry.physicalName),
        ...priorProfileRoots,
      ])),
    };
  }
  catch (error) { runtimeContent = { valid: false, code: error.code || 'RUNTIME_CONTENT_INVALID', error: error.message, details: error.details }; }
  const identity = (lock) => JSON.stringify(lock?.dependencies.map((entry) => ({
    repoUrl: entry.repoUrl, name: entry.name, resolvedCommit: entry.resolvedCommit,
    virtualPath: entry.virtualPath, localPath: entry.localPath, contentHash: entry.contentHash,
  })).sort((left, right) => `${left.repoUrl}/${left.virtualPath}/${left.name}`.localeCompare(`${right.repoUrl}/${right.virtualPath}/${right.name}`)) || []);
  const runtimeMatchesDesired = identity(canonicalLock) === identity(runtimeLock);
  let version;
  try { version = await apmVersion(context); }
  catch (error) { version = { expected: '0.28.0', actual: null, matches: false, error: error.message }; }
  let apmSkills = provisionalSkills(canonicalLock).filter((entry) => entry.engine === 'apm');
  try { apmSkills = await discoverApmSkills(neutral, canonicalLock); }
  catch (error) { if (!['SKILL_INVALID', 'SKILL_DUPLICATE_NAME'].includes(error.code)) throw error; }
  const materializers = await materializerStatus(neutral, materializerEntries);
  const profileSkills = await profileSkillStatus(neutral, effectiveProfile);
  let bootstrap;
  try { bootstrap = await profileBootstrapStatus(context, profile); }
  catch (error) {
    bootstrap = { valid: false, code: error.code || 'PROFILE_BOOTSTRAP_INVALID', error: error.message, details: error.details };
  }
  const skills = assertUniqueSkills([
    ...apmSkills,
    ...materializerEntries.map((entry) => ({ id: entry.name, physicalName: entry.name, engine: entry.engine })),
    ...profileSkillEntries(effectiveProfile).map(({ id, physicalName, engine, targets }) => ({
      id, physicalName, engine, targets,
    })),
  ]);
  const expectedOwnership = new Map(skills.map((entry) => [entry.id, entry]));
  const unexpectedOwned = [...ownedNames].filter((name) => !expectedOwnership.has(name)).sort();
  const missingOwned = [...expectedOwnership.keys()].filter((name) => !ownedNames.has(name)).sort();
  const unexpectedMappings = [...ownedMap.keys()].filter((name) => !expectedOwnership.has(name)).sort();
  const missingMappings = [...expectedOwnership.keys()].filter((name) => !ownedMap.has(name)).sort();
  const mismatchedMappings = [...expectedOwnership].filter(([name, entry]) => {
    const owned = ownedMap.get(name);
    return owned && (owned.physicalName !== entry.physicalName || owned.engine !== entry.engine);
  }).map(([name]) => name).sort();
  const ownership = {
    valid: unexpectedOwned.length === 0 && missingOwned.length === 0
      && unexpectedMappings.length === 0 && missingMappings.length === 0 && mismatchedMappings.length === 0,
    unexpectedOwned,
    missingOwned,
    unexpectedMappings,
    missingMappings,
    mismatchedMappings,
  };
  const projections = await projectionStatus(context, effectiveConfig, neutral, skills, enabled, activeScope);
  const adapters = await hostAdapterStatus(context, enabled, activeScope);
  let scanGuard;
  try { scanGuard = await scanGuardStatus(context, enabled, scope, effectiveProfile); }
  catch (error) {
    scanGuard = [{ host: 'core', state: 'invalid', expected: 'managed', valid: false,
      code: error.code || 'SCAN_GUARD_INVALID', error: error.message, details: error.details }];
  }
  let providers;
  try { providers = await providerStatus(context, effectiveProfile, enabled, scope); }
  catch (error) {
    providers = [{ provider: 'catalog', host: 'core', valid: false, error: error.message, details: error.details }];
  }
  let plugins;
  try { plugins = await reconcilePlugins(context, effectiveConfig, activeScope, 'check', profile); }
  catch (error) { plugins = { valid: false, error: error.message, details: error.details }; }
  if (plugins && plugins.valid === undefined) plugins.valid = true;
  const baseHealthy = sourceIntegrity.valid && profileState.valid && version.matches
      && runtimeMatchesDesired && runtimeContent.valid
      && bootstrap.valid && profileApm.valid
      && materializers.every((entry) => entry.valid) && profileSkills.every((entry) => entry.valid)
      && ownership.valid
      && adapters.every((entry) => entry.valid)
      && providers.every((entry) => entry.valid)
      && projections.every((entry) => entry.valid) && plugins.valid;
  const pendingActivation = scanGuard.filter((entry) => entry.pendingTrust).map((entry) => ({
    host: entry.host,
    action: 'trust-hook',
    trustStatus: entry.hookTrust,
    key: entry.hookTrustProbe?.key || null,
    currentHash: entry.hookTrustProbe?.currentHash || null,
  }));
  const result = {
    ok: baseHealthy && scanGuard.every((entry) => entry.valid),
    activation: {
      ready: baseHealthy && scanGuard.every((entry) => entry.valid || entry.pendingTrust),
      pending: pendingActivation,
    },
    root: context.root,
    home: context.home,
    sourceIntegrity,
    profile: profileState,
    machineProfile: { path: context.machineConfigPath, origin: machine.origin },
    hosts: HOSTS.map((host) => ({
      name: host,
      supported: true,
      enabled: enabled.includes(host),
      selected: scope.includes(host),
      active: enabled.includes(host) && scope.includes(host),
    })),
    apm: version,
    canonicalLock: { path: context.lockPath, sha256: canonicalLockHash, dependencies: canonicalLock.dependencies.length },
    runtimeLock: {
      path: runtimeLockPath,
      sha256: runtimeLockHash,
      sha256MatchesCanonical: canonicalLockHash === runtimeLockHash,
      matchesCanonical: runtimeMatchesDesired,
    },
    runtimeContent,
    skills,
    materializerExceptions: materializers,
    profileSkills,
    profileApm,
    bootstrap,
    ownership,
    adapters,
    scanGuard,
    providers,
    projections,
    plugins,
  };
  return result;
}

async function plan(context, options) {
  const current = await status(context, options);
  return {
    ready: current.ok,
    changes: {
      runtimeLock: current.runtimeLock.matchesCanonical ? 'unchanged' : 'replace',
      adapters: current.adapters.filter((entry) => !entry.valid),
      scanGuard: current.scanGuard.filter((entry) => !entry.valid),
      providers: current.providers.filter((entry) => !entry.valid),
      projections: current.projections.filter((entry) => !entry.valid),
      materializers: [
        ...current.materializerExceptions.filter((entry) => !entry.valid).map((entry) => entry.name),
        ...current.profileSkills.filter((entry) => !entry.valid).map((entry) => entry.id),
      ],
      plugins: current.plugins.valid ? 'unchanged' : 'reconcile',
    },
    status: current,
  };
}

async function mutateMachineAndApply(context, options, mutate) {
  return await withLock(context, async () => {
    const config = await loadConfig(context);
    const current = await loadMachineProfile(context, config);
    const next = new Set(effectiveEnabledHosts(current));
    mutate(next, current);
    const enabled = [...next];
    const neutral = skillStore(context, config);
    const provenPriorHosts = new Set();
    for (const host of current.enabledHosts) {
      if (!next.has(host) && await hasPriorHostState(context, config, neutral, host)) {
        provenPriorHosts.add(host);
      }
    }
    const changedHosts = HOSTS.filter((host) => {
      if (current.enabledHosts.includes(host) === next.has(host)) return false;
      return current.origin === 'machine' || next.has(host) || provenPriorHosts.has(host);
    });
    const applyOptions = { ...options, hosts: includeHostsInScope(options, changedHosts) };
    const applyScope = scopedHosts(applyOptions);
    const oldLock = await readLock(context);
    const backup = await createBackup(
      context,
      configForEnabledHosts(config, enabled),
      skillStore(context, config),
      provisionalSkills(oldLock),
      {
        activeHosts: enabled.filter((host) => applyScope.includes(host)),
        cleanupHosts: [...provenPriorHosts].filter((host) => applyScope.includes(host)),
      },
    );
    let before;
    try { before = await fs.readFile(context.machineConfigPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await saveMachineProfile(context, enabled);
    try { return await applyUnlocked(context, { ...applyOptions, precreatedBackup: backup }); }
    catch (error) {
      if (before) {
        let actual;
        try { actual = await fs.readFile(context.machineConfigPath); } catch { actual = null; }
        if (!actual?.equals(before)) await atomicWrite(context.machineConfigPath, before);
      } else await fs.rm(context.machineConfigPath, { force: true });
      throw error;
    }
  });
}

async function mutateSkillsAndApply(context, options, mutate, stageOptions = {}) {
  return await withLock(context, async () => {
    const active = await loadProfileDescriptor(context);
    const workspace = await ensureProfileWorkspace(context, active ? {
      repository: active.repository,
      ref: active.ref,
      expectedCommit: active.lockedCommit,
    } : {});
    const profileContext = {
      ...context,
      root: workspace.path,
      manifestDir: path.join(workspace.path, 'packages/skills'),
      manifestPath: path.join(workspace.path, 'packages/skills/apm.yml'),
      lockPath: path.join(workspace.path, 'packages/skills/apm.lock.yaml'),
    };
    try { await fs.access(profileContext.manifestPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(profileContext.manifestDir, { recursive: true, mode: 0o700 });
      await atomicWrite(profileContext.manifestPath, renderManifest([]));
    }
    const manifestBefore = await fs.readFile(profileContext.manifestPath);
    let lockBefore = null;
    try { lockBefore = await fs.readFile(profileContext.lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const dependencies = await readManifestDependencies(profileContext);
    const previousLock = dependencies.length ? await readLock(profileContext) : { dependencies: [] };
    const next = await mutate(dependencies);
    let committed = false;
    let capabilityChange = null;
    try {
      const staged = await stageDependencies(profileContext, next, stageOptions);
      capabilityChange = await syncProfileSkillCapabilities(
        workspace.path,
        previousLock.dependencies.map((entry) => entry.name),
        staged.skillNames,
      );
      await validateProfileWorkspace(workspace.path);
      const revision = await commitProfileWorkspace(context, {
        message: stageOptions.update ? 'Update personal Skill dependencies' : 'Change personal Skill dependencies',
        validate: validateProfileWorkspace,
      });
      committed = true;
      return await applyUnlocked(context, {
        ...options,
        profileRequest: {
          repository: workspace.path,
          ref: revision.commit,
          expectedCommit: revision.commit,
        },
      });
    } catch (error) {
      if (!committed) {
        await fs.writeFile(profileContext.manifestPath, manifestBefore);
        if (lockBefore) await fs.writeFile(profileContext.lockPath, lockBefore);
        else await fs.rm(profileContext.lockPath, { force: true });
        if (capabilityChange) {
          await fs.writeFile(
            path.join(workspace.path, 'catalog/capabilities.jsonl'),
            capabilityChange.overlayBefore,
          );
        }
      }
      throw error;
    }
  });
}

async function workspaceSkillState(context) {
  const workspace = await loadWorkspaceDescriptor(context);
  if (!workspace) return { workspace: null, dependencies: [], lock: null };
  const profileContext = {
    ...context,
    root: workspace.path,
    manifestDir: path.join(workspace.path, 'packages/skills'),
    manifestPath: path.join(workspace.path, 'packages/skills/apm.yml'),
    lockPath: path.join(workspace.path, 'packages/skills/apm.lock.yaml'),
  };
  const dependencies = await readManifestDependencies(profileContext);
  if (dependencies.length === 0) return { workspace, profileContext, dependencies, lock: null };
  return { workspace, profileContext, dependencies, lock: await readLock(profileContext) };
}

export function removeSkillDependency(dependencies, lock, requested) {
  let reference = requested;
  if (!dependencies.includes(reference)) {
    const locked = lock?.dependencies.find((entry) => entry.name === requested);
    let matches = [];
    if (locked?.localPath) {
      matches = dependencies.filter((entry) => entry === locked.localPath);
    } else if (locked?.repoUrl) {
      const normalizePath = (value) => value.replace(/^\/+|\/+$/gu, '').replace(/\.git(?=\/|$)/u, '');
      const defaultHost = 'github.com';
      const lockedHost = (locked.host || defaultHost).toLowerCase();
      const lockedPort = locked.port ? `:${locked.port}` : '';
      const expectedPath = normalizePath(
        `${locked.repoUrl}${locked.virtualPath ? `/${locked.virtualPath}` : ''}`,
      );
      const expected = `${lockedHost}${lockedPort}/${expectedPath}`;
      const identity = (entry) => {
        let source = entry.trim();
        try { source = decodeURIComponent(source); } catch { /* APM will reject invalid escaping later. */ }
        source = source.split('#', 1)[0];
        let host = defaultHost;
        let port = '';
        let repositoryPath = source;
        const scp = source.match(/^[^@/]+@([^/:]+):(.+)$/u);
        if (scp) {
          [, host, repositoryPath] = scp;
        } else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
          try {
            const url = new URL(source);
            host = url.hostname;
            port = url.port
              && !(['https:443', 'http:80', 'ssh:22'].includes(`${url.protocol}${url.port}`))
              ? `:${url.port}` : '';
            repositoryPath = url.pathname;
          } catch { return null; }
        } else {
          const segments = source.split('/');
          if (segments[0] === 'gh') segments.shift();
          else if (segments[0]?.includes('.')) host = segments.shift();
          repositoryPath = segments.join('/');
        }
        return `${host.toLowerCase()}${port}/${normalizePath(repositoryPath)}`;
      };
      matches = dependencies.filter((entry) => identity(entry) === expected);
    }
    if (matches.length > 1) {
      throw new PacError(
        'SKILL_REFERENCE_AMBIGUOUS',
        `Multiple dependency references map to locked Skill ${requested}; remove one by its full dependency reference.`,
        { skill: requested, references: matches },
      );
    }
    if (matches.length === 1) [reference] = matches;
  }
  const next = dependencies.filter((entry) => entry !== reference);
  if (next.length === dependencies.length) {
    throw new PacError('SKILL_UNKNOWN', `Skill dependency not declared: ${requested}`);
  }
  return next;
}

async function skillCommand(context, action, args, options) {
  if (action === 'list') {
    const lock = await readLock(context);
    const profile = await loadActiveProfile(context);
    const materializers = await selectedMaterializerExceptions(profile);
    return {
      skills: [
        ...lock.dependencies.map((entry) => ({ ...entry, engine: 'apm' })),
        ...materializers,
        ...(profile?.apm?.lock?.dependencies || []).map((entry) => ({ ...entry, engine: 'profile-apm' })),
        ...profileSkillEntries(profile).map(({ id: name, engine }) => ({ name, engine })),
      ],
    };
  }
  if (action === 'search') {
    if (!args.length) throw usage('pac skill search requires a query.');
    const config = await loadConfig(context);
    const machine = await loadMachineProfile(context, config);
    const hosts = effectiveEnabledHosts(machine, options.hosts);
    if (!hosts.length) {
      const requestedHosts = scopedHosts(options);
      throw new PacError(
        'HOST_SCOPE_EMPTY',
        `No enabled host matches the requested scope: ${requestedHosts.join(', ')}.`,
        { requestedHosts, enabledHosts: effectiveEnabledHosts(machine) },
      );
    }
    return await runResolver(context, ['resolve', '--host', hosts[0], ...args]);
  }
  if (action === 'add') {
    if (args.length !== 1) throw usage('pac skill add requires exactly one APM dependency reference.');
    return await mutateSkillsAndApply(context, options, async (dependencies) => {
      if (dependencies.includes(args[0])) throw new PacError('SKILL_DUPLICATE', `Skill dependency already declared: ${args[0]}`);
      return [...dependencies, args[0]];
    });
  }
  if (action === 'remove') {
    if (args.length !== 1) throw usage('pac skill remove requires one Skill name or dependency reference.');
    return await mutateSkillsAndApply(context, options, async (dependencies) => {
      const { lock } = await workspaceSkillState(context);
      return removeSkillDependency(dependencies, lock, args[0]);
    });
  }
  if (action === 'update') {
    if (args.length > 1) throw usage('pac skill update accepts at most one Skill name.');
    const { lock } = await workspaceSkillState(context);
    if (!lock) throw new PacError('SKILL_UNKNOWN', 'No personal Skill dependencies are locked.');
    const packageName = args[0] ? lock.dependencies.find((entry) => entry.name === args[0])?.name : undefined;
    if (args[0] && !packageName) throw new PacError('SKILL_UNKNOWN', `No locked Skill named ${args[0]}.`);
    return await mutateSkillsAndApply(context, options, async (dependencies) => dependencies, { update: true, package: packageName });
  }
  throw usage('Usage: pac skill add|remove|update|list|search ...');
}

async function mutateProfileManifestAndApply(context, options, message, mutate) {
  return await withLock(context, async () => {
    const active = await loadProfileDescriptor(context);
    const workspace = await ensureProfileWorkspace(context, active ? {
      repository: active.repository,
      ref: active.ref,
      expectedCommit: active.lockedCommit,
    } : {});
    const manifestPath = path.join(workspace.path, 'pac-profile.json');
    const before = await fs.readFile(manifestPath);
    let committed = false;
    try {
      const manifest = JSON.parse(before.toString('utf8'));
      if (manifest.schemaVersion === 1) {
        manifest.schemaVersion = 2;
        manifest.bootstrap = null;
        manifest.plugins = { enabled: [...manifest.plugins.enabled], disabled: [] };
      }
      mutate(manifest);
      await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await validateProfileWorkspace(workspace.path);
      const revision = await commitProfileWorkspace(context, {
        message,
        validate: validateProfileWorkspace,
      });
      committed = true;
      return await applyUnlocked(context, {
        ...options,
        profileRequest: {
          repository: workspace.path,
          ref: revision.commit,
          expectedCommit: revision.commit,
        },
      });
    } catch (error) {
      if (!committed) await fs.writeFile(manifestPath, before);
      throw error;
    }
  });
}

async function pluginCommand(context, action, args, options) {
  const profile = await loadActiveProfile(context);
  const [known, coreKnown] = await Promise.all([pluginCatalog(context, profile), pluginCatalog(context)]);
  const profileNames = new Set(known.filter((entry) => !coreKnown.some((core) => core.name === entry.name)).map((entry) => entry.name));
  if (action === 'list') {
    const config = await loadConfig(context);
    const enabled = new Set(effectivePluginNames(config, profile));
    return { plugins: known.map((entry) => ({ ...entry, enabled: enabled.has(entry.name), origin: profileNames.has(entry.name) ? 'profile' : 'core' })) };
  }
  if (action === 'update') {
    if (args.length > 1) throw usage('pac plugin update accepts at most one Plugin name.');
    if (args[0] && !known.some((entry) => entry.name === args[0])) throw new PacError('PLUGIN_UNKNOWN', `Unknown Plugin: ${args[0]}`);
    return await apply(context, options);
  }
  if (!['add', 'remove'].includes(action) || args.length !== 1) throw usage('Usage: pac plugin add|remove|update|list [name]');
  const name = args[0];
  if (!known.some((entry) => entry.name === name)) throw new PacError('PLUGIN_UNKNOWN', `Unknown Plugin: ${name}`);
  return await mutateProfileManifestAndApply(context, options, `${action === 'add' ? 'Enable' : 'Disable'} personal Plugin ${name}`, (manifest) => {
    const enabled = new Set(manifest.plugins.enabled);
    const disabled = new Set(manifest.plugins.disabled);
    if (action === 'add') {
      enabled.add(name);
      disabled.delete(name);
    } else {
      enabled.delete(name);
      disabled.add(name);
    }
    manifest.plugins.enabled = [...enabled].sort();
    manifest.plugins.disabled = [...disabled].sort();
  });
}

async function profileCommand(context, action, args, options) {
  if (action === 'status') {
    if (args.length) throw usage('pac profile status accepts no arguments.');
    return {
      profile: await profileStatus(context),
      workspace: await loadWorkspaceDescriptor(context),
    };
  }
  if (action === 'init') {
    if (args.length > 1) throw usage('Usage: pac profile init [PATH]');
    return await withLock(context, async () => {
      const active = await loadProfileDescriptor(context);
      const workspace = await ensureProfileWorkspace(context, {
        ...(args[0] ? { path: args[0] } : {}),
        ...(active ? {
          repository: active.repository,
          ref: active.ref,
          expectedCommit: active.lockedCommit,
        } : {}),
      });
      await validateProfileWorkspace(workspace.path);
      const revision = await commitProfileWorkspace(context, {
        message: 'Initialize personal agent profile',
        validate: validateProfileWorkspace,
      });
      return await applyUnlocked(context, {
        ...options,
        profileRequest: {
          repository: workspace.path,
          ref: revision.commit,
          expectedCommit: revision.commit,
        },
      });
    });
  }
  if (action === 'publish') {
    if (args.length !== 1) throw usage('Usage: pac profile publish OWNER/REPOSITORY');
    return await withLock(context, async () => {
      await ensureProfileWorkspace(context);
      const revision = await commitProfileWorkspace(context, {
        message: 'Prepare personal agent profile for publication',
        validate: validateProfileWorkspace,
      });
      await publishProfileWorkspace(context, { repository: args[0] });
      const repository = await profileWorkspaceRepository(context);
      return await applyUnlocked(context, {
        ...options,
        profileRequest: {
          repository,
          ref: revision.commit,
          expectedCommit: revision.commit,
        },
      });
    });
  }
  if (action === 'sync') {
    if (args.length > 1) throw usage('Usage: pac profile sync [COMMIT_MESSAGE]');
    return await withLock(context, async () => {
      const revision = await syncProfileWorkspace(context, {
        message: args[0] || 'Synchronize personal agent profile',
        validate: validateProfileWorkspace,
      });
      return await applyUnlocked(context, {
        ...options,
        profileRequest: {
          repository: revision.repository,
          ref: revision.commit,
          expectedCommit: revision.commit,
        },
      });
    });
  }
  if (['set', 'attach'].includes(action)) {
    if (args.length < 1 || args.length > 3) {
      throw usage('Usage: pac profile set REPOSITORY [REF] [EXPECTED_COMMIT]');
    }
    const [repository, ref = 'main', expectedCommit] = args;
    return await apply(context, {
      ...options,
      profileRequest: { repository, ref, expectedCommit },
    });
  }
  if (action === 'update') {
    if (args.length > 1) throw usage('pac profile update accepts at most one EXPECTED_COMMIT.');
    return await apply(context, {
      ...options,
      profileRequest: { mode: 'update', expectedCommit: args[0] },
    });
  }
  if (['remove', 'detach'].includes(action)) {
    if (args.length) throw usage('pac profile remove accepts no arguments.');
    return await apply(context, { ...options, profileRequest: null });
  }
  throw usage('Usage: pac profile init|set|update|publish|sync|remove|status ...');
}

async function hostCommand(context, action, args, options) {
  if (action === 'list') {
    const config = await loadConfig(context);
    const machine = await loadMachineProfile(context, config);
    const enabled = new Set(effectiveEnabledHosts(machine));
    return {
      machineProfile: { path: context.machineConfigPath, origin: machine.origin },
      hosts: HOSTS.map((name) => ({ name, supported: true, ...config.hosts[name], enabled: enabled.has(name) })),
    };
  }
  if (!['enable', 'disable'].includes(action) || args.length !== 1 || !HOSTS.includes(args[0])) {
    throw usage(`Usage: pac host enable|disable|list ${HOSTS.join('|')}`);
  }
  const host = args[0];
  return await mutateMachineAndApply(context, { ...options, hosts: includeHostInScope(options, host) }, (enabled) => {
    if (action === 'enable') enabled.add(host); else enabled.delete(host);
  });
}

async function doctor(context, options) {
  const config = await loadConfig(context);
  const machine = await loadMachineProfile(context, config);
  const hosts = effectiveEnabledHosts(machine, options.hosts);
  const profile = await loadActiveProfile(context);
  const override = process.env.PAC_DOCTOR;
  const executable = override || 'sh';
  const args = [
    ...(override ? [] : [path.join(context.root, 'scripts/doctor.sh')]),
    '--home', context.home, '--agents', hosts.join(','),
    ...profileResolverArgs(profile),
  ];
  const result = hosts.length ? await run(executable, args, {
    cwd: context.root, env: { ...process.env, HOME: context.home }, errorCode: 'DOCTOR_FAILED',
  }) : { stdout: 'No hosts enabled.' };
  const current = await status(context, options);
  if (!current.ok) {
    throw new PacError('DOCTOR_FAILED', 'PAC status contract is unhealthy.', { status: current });
  }
  return { doctor: result.stdout.trim(), status: current };
}

async function rollback(context, args) {
  if (args.length > 1) throw usage('pac rollback accepts at most one backup path.');
  return await withLock(context, async () => {
    let backup = args[0];
    if (!backup) {
      try { backup = (await fs.readFile(path.join(context.stateDir, 'last-backup'), 'utf8')).trim(); }
      catch { throw new PacError('BACKUP_MISSING', 'No PAC backup is recorded.'); }
    }
    const result = await restore(context, backup);
    const config = await loadConfig(context);
    const kind = await backupKind(backup);
    const resolver = kind === 'chezmoi-outer'
      ? deferredResolverAfterOuterRestore()
      : await rebuildResolverAfterRestore(context, skillStore(context, config));
    const receipt = await writeReceipt(context, { operation: 'rollback', backup });
    return { backup, receipt, output: result.stdout.trim(), resolver };
  });
}

async function install(context, args, options) {
  if (args.length > 1 || (args[0] && ![...HOSTS, 'all'].includes(args[0]))) {
    throw usage(`Usage: pac install [${HOSTS.join('|')}|all]`);
  }
  const requested = args[0] || 'all';
  const environmentProfile = profileRequestFromEnvironment();
  const installOptions = {
    ...options,
    hosts: requested,
    ...(environmentProfile ? { profileRequest: environmentProfile } : {}),
  };
  return await mutateMachineAndApply(context, installOptions, (enabled, current) => {
    if (current.origin === 'source-default') enabled.clear();
    for (const host of requested === 'all' ? HOSTS : [requested]) enabled.add(host);
  });
}

async function selfUpdate(context, options) {
  return await withLock(context, async () => {
    const dirty = (await run('git', ['-C', context.root, 'status', '--porcelain', '--untracked-files=all'], {
      errorCode: 'SELF_UPDATE_FAILED',
    })).stdout.trim();
    if (dirty) {
      throw new PacError('SELF_UPDATE_DIRTY', 'Refusing to update PAC with working-tree changes or untracked files.', {
        root: context.root,
        changedPaths: dirty.split(/\r?\n/u).map((line) => line.slice(3)),
      });
    }
    const before = (await run('git', ['-C', context.root, 'rev-parse', 'HEAD'], { errorCode: 'SELF_UPDATE_FAILED' })).stdout.trim();
    await run('git', ['-C', context.root, 'pull', '--ff-only'], { errorCode: 'SELF_UPDATE_FAILED' });
    const after = (await run('git', ['-C', context.root, 'rev-parse', 'HEAD'], { errorCode: 'SELF_UPDATE_FAILED' })).stdout.trim();
    try {
      const localMise = path.join(context.home, '.local/bin/mise');
      const mise = process.env.PAC_MISE || await fs.access(localMise, fs.constants.X_OK)
        .then(() => localMise)
        .catch(() => 'mise');
      await run(mise, ['trust', '--yes', path.join(context.root, 'mise.toml')], {
        cwd: context.root,
        errorCode: 'TOOL_UPDATE_FAILED',
      });
      await run(mise, ['install', '--locked', '--yes'], {
        cwd: context.root,
        env: { ...process.env, MISE_PARANOID: '1', MISE_LOCKED: '1' },
        errorCode: 'TOOL_UPDATE_FAILED',
      });
      const applied = await applyUnlocked(context, options);
      const receipt = await writeReceipt(context, { operation: 'self-update', source: { before, after }, applyReceipt: applied.receipt });
      return {
        ...applied,
        source: { before, after },
        tools: { reconciled: true, manifest: path.join(context.root, 'mise.toml') },
        selfUpdateReceipt: receipt,
      };
    } catch (error) {
      throw new PacError('SELF_UPDATE_APPLY_FAILED', 'PAC source fast-forwarded, but applying the new revision failed. Source was not reset.', {
        before, after, applyError: { code: error.code, message: error.message, details: error.details },
      });
    }
  });
}

export async function executeCommand(context, command, args, options = {}) {
  switch (command) {
    case 'install': return await install(context, args, options);
    case 'plan': if (args.length) throw usage('pac plan accepts no arguments.'); return await plan(context, options);
    case 'apply': {
      if (args.length) throw usage('pac apply accepts no arguments.');
      const environmentProfile = profileRequestFromEnvironment();
      return await apply(
        context,
        environmentProfile ? { ...options, profileRequest: environmentProfile } : options,
        await outerTransactionFromEnvironment(context),
      );
    }
    case 'status': if (args.length) throw usage('pac status accepts no arguments.'); return await status(context, options);
    case 'doctor': if (args.length) throw usage('pac doctor accepts no arguments.'); return await doctor(context, options);
    case 'rollback': return await rollback(context, args);
    case 'update': if (args.length) throw usage('pac update accepts no arguments.'); return await selfUpdate(context, options);
    case 'self-update': if (args.length) throw usage('pac self-update accepts no arguments.'); return await selfUpdate(context, options);
    case 'skill': return await skillCommand(context, args.shift(), args, options);
    case 'plugin': return await pluginCommand(context, args.shift(), args, options);
    case 'host': return await hostCommand(context, args.shift(), args, options);
    case 'profile': return await profileCommand(context, args.shift(), args, options);
    default: throw usage(`Unknown command: ${command || '(none)'}`);
  }
}
