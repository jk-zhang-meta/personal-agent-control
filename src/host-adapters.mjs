import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { run } from './exec.mjs';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';
import { atomicWrite } from './state.mjs';

const ADAPTERS = {
  codex: [
    ['generated/codex/AGENTS.md', '.codex/AGENTS.md'],
    ['generated/codex/agents/independent-reviewer.toml', '.codex/agents/independent-reviewer.toml'],
  ],
  claude: [
    ['generated/claude/CLAUDE.md', '.claude/CLAUDE.md'],
    ['generated/claude/agents/independent-reviewer.md', '.claude/agents/independent-reviewer.md'],
  ],
};

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function ownershipPath(context) {
  return path.join(context.stateDir, 'owned-host-adapters.json');
}

async function readOwnership(context) {
  await assertSafeManagedObject(context.home, ownershipPath(context), 'host-adapter ownership', 'file');
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(ownershipPath(context), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, hosts: {} };
    throw new PacError('HOST_ADAPTER_OWNERSHIP_INVALID', `Cannot read host-adapter ownership: ${error.message}`);
  }
  const fail = (message) => { throw new PacError('HOST_ADAPTER_OWNERSHIP_INVALID', message); };
  if (!parsed || Array.isArray(parsed) || parsed.schemaVersion !== 1
      || !parsed.hosts || typeof parsed.hosts !== 'object' || Array.isArray(parsed.hosts)) {
    fail('Host-adapter ownership must use schemaVersion 1 and a hosts object.');
  }
  if (Object.keys(parsed).some((key) => !['schemaVersion', 'hosts'].includes(key))) {
    fail('Host-adapter ownership contains an unknown top-level field.');
  }
  for (const [host, entries] of Object.entries(parsed.hosts)) {
    if (!Object.hasOwn(ADAPTERS, host) || !Array.isArray(entries)) {
      fail(`Host-adapter ownership contains an invalid host: ${host}`);
    }
    const allowed = new Set(ADAPTERS[host].map(([, targetRelative]) => targetRelative));
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || Array.isArray(entry) || Object.keys(entry).length !== 2
          || !Object.hasOwn(entry, 'targetRelative') || !Object.hasOwn(entry, 'sha256')
          || typeof entry.targetRelative !== 'string' || !allowed.has(entry.targetRelative)
          || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)
          || seen.has(entry.targetRelative)) {
        fail(`Host-adapter ownership contains an invalid ${host} entry.`);
      }
      seen.add(entry.targetRelative);
    }
    if (seen.size !== allowed.size) fail(`Host-adapter ownership is incomplete for ${host}.`);
  }
  return parsed;
}

async function expectedEntries(context, host) {
  return await Promise.all(ADAPTERS[host].map(async ([sourceRelative, targetRelative]) => {
    const source = path.join(context.root, sourceRelative);
    const target = path.join(context.home, targetRelative);
    const content = await fs.readFile(source);
    return { source, target, targetRelative, sha256: digest(content) };
  }));
}

async function inspectEntry(context, host, entry) {
  await assertSafeManagedObject(context.home, entry.target, `${host} adapter`, 'file');
  try {
    const stat = await fs.lstat(entry.target);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ...entry, state: 'collision', valid: false };
    const actualSha256 = digest(await fs.readFile(entry.target));
    return {
      ...entry,
      actualSha256,
      state: actualSha256 === entry.sha256 ? 'managed' : 'drift',
      valid: actualSha256 === entry.sha256,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...entry, state: 'missing', valid: false };
    throw error;
  }
}

async function applyAdapter(context, host, entries) {
  const chezmoi = process.env.PAC_CHEZMOI || path.join(context.home, '.local/bin/chezmoi');
  try { await fs.access(chezmoi, fs.constants.X_OK); }
  catch {
    throw new PacError('HOST_ADAPTER_TOOL_MISSING', `Chezmoi is required to install the ${host} adapter: ${chezmoi}`);
  }
  // Chezmoi remembers a previously written file even after an external
  // rollback or a user removes it. In that state --error-on-conflict treats a
  // missing PAC-owned adapter as a conflict and refuses to restore it. Force
  // is safe only when every present entry already equals the current canonical
  // bytes; a modified or colliding entry remains fail-closed.
  const inspected = await Promise.all(entries.map((entry) => inspectEntry(context, host, entry)));
  const recoverMissing = inspected.some((entry) => entry.state === 'missing')
    && inspected.every((entry) => entry.state === 'missing' || entry.state === 'managed');
  const selected = {
    agents: host,
    codex: host === 'codex',
    claude: host === 'claude',
    skipExternals: true,
  };
  // This operation owns only the explicitly listed adapter files.  Externals
  // (notably the pinned mise archive) belong to bootstrap and must not be
  // downloaded again during a host-only reconcile.
  await run(chezmoi, [
    '--source', context.root,
    '--config', path.join(context.home, '.config/personal-agent-control/chezmoi.toml'),
    '--destination', context.home,
    '--override-data', JSON.stringify({ pac: selected }),
    '--refresh-externals=never',
    '--no-tty', recoverMissing ? '--force' : '--error-on-conflict',
    'apply', '--exclude', 'externals', '--parent-dirs',
    ...entries.map((entry) => entry.target),
  ], { cwd: context.root, errorCode: 'HOST_ADAPTER_APPLY_FAILED' });
}

export async function hostAdapterStatus(context, enabledHosts, scopeHosts) {
  if (process.env.PAC_HOST_ADAPTER_MODE === 'skip') return [];
  const enabled = new Set(enabledHosts);
  const scope = new Set(scopeHosts);
  const ownership = await readOwnership(context);
  const results = [];
  for (const host of Object.keys(ADAPTERS)) {
    if (!scope.has(host)) continue;
    const owned = ownership.hosts[host];
    for (const entry of await expectedEntries(context, host)) {
      const actual = await inspectEntry(context, host, entry);
      const prior = owned?.find((item) => item.targetRelative === entry.targetRelative);
      if (enabled.has(host)) {
        const ownershipValid = prior?.sha256 === entry.sha256;
        results.push({
          host,
          ...actual,
          expected: 'managed-and-owned',
          owned: ownershipValid,
          valid: actual.valid && ownershipValid,
        });
      } else if (prior) {
        results.push({ host, ...actual, expected: 'missing', valid: actual.state === 'missing' });
      } else {
        results.push({ host, ...actual, expected: 'unmanaged-or-missing', valid: true });
      }
    }
  }
  return results;
}

export async function reconcileHostAdapters(context, enabledHosts, scopeHosts) {
  if (process.env.PAC_HOST_ADAPTER_MODE === 'skip') return { skipped: true, hosts: [] };
  const enabled = new Set(enabledHosts);
  const scope = new Set(scopeHosts);
  const ownership = await readOwnership(context);
  const results = [];
  for (const host of Object.keys(ADAPTERS)) {
    if (!scope.has(host)) continue;
    const entries = await expectedEntries(context, host);
    if (enabled.has(host)) {
      await Promise.all(entries.map((entry) => (
        assertSafeManagedObject(context.home, entry.target, `${host} adapter`, 'file')
      )));
      if (process.env.PAC_HOST_ADAPTER_MODE !== 'adopt') await applyAdapter(context, host, entries);
      const inspected = await Promise.all(entries.map((entry) => inspectEntry(context, host, entry)));
      const invalid = inspected.find((entry) => !entry.valid);
      if (invalid) {
        throw new PacError('HOST_ADAPTER_INVALID', `The ${host} adapter was not installed exactly: ${invalid.target}`, invalid);
      }
      ownership.hosts[host] = entries.map(({ targetRelative, sha256 }) => ({ targetRelative, sha256 }));
      results.push({ host, action: process.env.PAC_HOST_ADAPTER_MODE === 'adopt' ? 'adopted' : 'applied' });
      continue;
    }
    const prior = ownership.hosts[host];
    if (!prior) {
      results.push({ host, action: 'preserved-unmanaged' });
      continue;
    }
    for (const item of prior) {
      const target = path.join(context.home, item.targetRelative);
      await assertSafeManagedObject(context.home, target, `${host} adapter`, 'file');
      let actual;
      try { actual = digest(await fs.readFile(target)); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (actual !== item.sha256) {
        throw new PacError('HOST_ADAPTER_DRIFT', `Refusing to retire a modified ${host} adapter: ${target}`);
      }
      await fs.unlink(target);
    }
    delete ownership.hosts[host];
    results.push({ host, action: 'retired' });
  }
  await atomicWrite(ownershipPath(context), `${JSON.stringify(ownership, null, 2)}\n`);
  return { skipped: false, hosts: results };
}
