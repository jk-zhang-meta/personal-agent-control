import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { PacError } from './errors.mjs';
import { acquireProfile, hashDirectory } from './profile.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';
import { verifyCanonicalPayload } from './integrity.mjs';
import { readOwnedSkillMap, withLock } from './state.mjs';

// Policy-only delivery does not install package managers, plugins, credentials,
// or hooks. Full managed installations continue to use `pac apply`.
const SKILL_ROOTS = {
  codex: ['.agents/skills', '.codex/skills'],
  claude: ['.claude/skills'],
  agy: ['.gemini/antigravity-cli/skills', '.gemini/config/skills'],
  grok: ['.grok/skills'],
};
const STATE = '.local/state/personal-agent-control/policy-deployment.json';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bridge = '# Personal Agent Control\n\nRead `~/.config/personal-agent-control/profile-bootstrap.md` before substantive work.\nFollow the shared kernel in `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`.\nUse the skills exposed by this host. Native permission settings remain authoritative.\n';

async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function within(home, file) {
  const rel = path.relative(home, file);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function identity(home, file) {
  await assertSafeManagedObject(home, file, 'policy target');
  const stat = await statOrNull(file);
  if (!stat) return null;
  const real = await fs.realpath(file);
  if (!within(home, real)) throw new PacError('POLICY_PATH_UNSAFE', `Policy target leaves its home: ${file}`);
  const actual = await fs.stat(real);
  if (actual.isDirectory()) return { kind: stat.isSymbolicLink() ? 'link' : 'directory', sha256: await hashDirectory(real), link: stat.isSymbolicLink() ? await fs.readlink(file) : null };
  if (!actual.isFile() || actual.size > 2 * 1024 * 1024) throw new PacError('POLICY_PATH_UNSAFE', `Policy target is not a bounded file or skill: ${file}`);
  return { kind: stat.isSymbolicLink() ? 'link' : 'file', sha256: sha(await fs.readFile(real)), link: stat.isSymbolicLink() ? await fs.readlink(file) : null };
}

async function compatibilityRootIsNeutral(home, relativeRoot, neutral) {
  const target = path.join(home, relativeRoot);
  const stat = await statOrNull(target);
  if (!stat?.isSymbolicLink()) return false;
  // A host may already expose the PAC neutral Skill store as one directory
  // alias (Antigravity commonly does this).  Permit only that exact alias;
  // arbitrary symlink ancestors still fail later through identity().
  await assertSafeManagedObject(home, path.dirname(target), 'policy compatibility root', 'directory');
  try {
    const [actual, expected] = await Promise.all([
      fs.realpath(target), fs.realpath(path.join(home, neutral)),
    ]);
    return actual === expected;
  } catch {
    return false;
  }
}

async function readState(context) {
  const file = path.join(context.home, STATE);
  await assertSafeManagedObject(context.home, file, 'policy ownership', 'file');
  if (!(await statOrNull(file))) return { schemaVersion: 1, entries: [] };
  const stat = await fs.stat(file);
  if (stat.size > 1024 * 1024) throw new PacError('POLICY_STATE_INVALID', 'Policy ownership exceeds 1 MiB.');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > 512
      || value.entries.some((e) => !e || typeof e.relativePath !== 'string' || !within(context.home, path.resolve(context.home, e.relativePath)) || !/^[a-f0-9]{64}$/.test(e.sha256))) {
    throw new PacError('POLICY_STATE_INVALID', 'Policy ownership is invalid.');
  }
  return value;
}

export async function policyStatus(context) {
  const state = await readState(context);
  const entries = [];
  for (const e of state.entries) {
    const actual = await identity(context.home, path.join(context.home, e.relativePath));
    entries.push({ relativePath: e.relativePath, valid: actual?.sha256 === e.sha256 });
  }
  return { mode: 'policy-only', ok: entries.length > 0 && entries.every((e) => e.valid),
    profileCommit: state.profileCommit || null, agents: state.agents || [], entries,
    packageManagers: 'not-assessed', hooks: 'not-modified', backup: state.backup || null };
}

export async function synchronizePolicy(context, { repository, commit, baseline, agents = Object.keys(SKILL_ROOTS) }) {
  if (!/^[a-f0-9]{40}$/.test(commit || '') || !/^[a-f0-9]{40}$/.test(baseline || '')
      || !agents.length || new Set(agents).size !== agents.length || agents.some((a) => !Object.hasOwn(SKILL_ROOTS, a))) {
    throw new PacError('POLICY_INPUT_INVALID', 'Use exact Profile commit IDs and unique codex,claude,agy,grok targets.');
  }
  return withLock(context, async () => {
    await verifyCanonicalPayload(context);
    const previous = await acquireProfile(context, { repository, ref: baseline, expectedCommit: baseline });
    const current = await acquireProfile(context, { repository, ref: commit, expectedCommit: commit });
    const state = await readState(context);
    const fullInstallation = (await readOwnedSkillMap(context)).size > 0;
    const owned = new Map(state.entries.map((e) => [e.relativePath, e.sha256]));
    const oldSkills = new Map(previous.skills.map((s) => [s.name, s.contentSha256]));
    const skills = current.skills.map((s) => ({ name: s.name, source: s.root, sha256: s.contentSha256, baseline: oldSkills.get(s.name) }));
    for (const name of ['capability-resolver', 'graph-workflow']) {
      const source = path.join(context.root, 'payload/skills', name);
      const digest = await hashDirectory(source);
      skills.push({ name, source, sha256: digest, baseline: digest });
    }
    const planned = [];
    const neutral = '.local/share/agent-skills/.agents/skills';
    for (const skill of skills) {
      if (fullInstallation) {
        const installed = await identity(context.home, path.join(context.home, neutral, skill.name));
        if (installed?.sha256 !== skill.sha256) throw new PacError('POLICY_APPLY_REQUIRED',
          'Update the existing managed installation with pac apply before projecting compatibility hosts.');
      } else planned.push({ relativePath: `${neutral}/${skill.name}`, kind: 'directory', ...skill });
      const selected = fullInstallation ? agents.filter((a) => a !== 'codex' && a !== 'claude') : agents;
      for (const root of [...new Set(selected.flatMap((a) => SKILL_ROOTS[a]))]) {
        if (await compatibilityRootIsNeutral(context.home, root, neutral)) continue;
        planned.push({ relativePath: `${root}/${skill.name}`, kind: 'link', link: path.join(context.home, neutral, skill.name), ...skill });
      }
    }
    const file = async (relativePath, source, baselineSource = source) => {
      const content = await fs.readFile(source);
      planned.push({ relativePath, kind: 'file', content, sha256: sha(content), baseline: sha(await fs.readFile(baselineSource)) });
    };
    if (!fullInstallation) {
      if (current.bootstrap) await file('.config/personal-agent-control/profile-bootstrap.md', current.bootstrap, previous.bootstrap || current.bootstrap);
      // Compatibility clients may discover either shared kernel.
      await file('.codex/AGENTS.md', path.join(context.root, 'generated/codex/AGENTS.md'));
      await file('.claude/CLAUDE.md', path.join(context.root, 'generated/claude/CLAUDE.md'));
    }
    if (agents.includes('agy')) planned.push({ relativePath: '.gemini/antigravity-cli/rules/personal-agent-control.md', kind: 'file', content: `---\ntrigger: always_on\n---\n\n${bridge}`, sha256: sha(`---\ntrigger: always_on\n---\n\n${bridge}`) });
    if (agents.includes('agy')) {
      const relativePath = '.gemini/GEMINI.md';
      if (!(await statOrNull(path.join(context.home, relativePath))) || owned.has(relativePath)) {
        planned.push({ relativePath, kind: 'file', content: bridge, sha256: sha(bridge) });
      }
    }
    if (agents.includes('grok')) {
      // Do not replace an existing custom bridge; Grok also reads CLAUDE.md.
      const relativePath = '.grok/rules/personal-agent-control.md';
      if (!(await statOrNull(path.join(context.home, relativePath))) || owned.has(relativePath)) planned.push({ relativePath, kind: 'file', content: bridge, sha256: sha(bridge) });
    }
    const changes = [];
    for (const item of planned) {
      const target = path.join(context.home, item.relativePath);
      const actual = await identity(context.home, target);
      if (actual && actual.sha256 !== item.sha256 && actual.sha256 !== item.baseline && actual.sha256 !== owned.get(item.relativePath)) {
        throw new PacError('POLICY_DRIFT', `Preserving modified or unrelated policy content: ${target}`);
      }
      item.before = actual;
      // A correct symlink updates with its neutral target; keep it intact.
      const correctLink = actual?.kind === 'link' && item.kind === 'link'
        && path.resolve(path.dirname(target), actual.link) === path.resolve(item.link);
      if (actual?.sha256 !== item.sha256 && !correctLink) changes.push(item);
    }
    const backup = path.join(context.home, '.agent-work/backups/personal-agent-control', `policy-${Date.now()}-${crypto.randomUUID()}`);
    await assertSafeManagedObject(context.home, backup, 'policy backup', 'directory');
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    const journal = [];
    await atomicWriteFile(path.join(backup, 'plan.json'), JSON.stringify({ mode: 'policy-only', commit, baseline, changes: changes.map(({ relativePath, before }) => ({ relativePath, before })) }, null, 2));
    try {
      for (const [index, item] of changes.entries()) {
        const target = path.join(context.home, item.relativePath);
        const check = await identity(context.home, target);
        if (JSON.stringify(check) !== JSON.stringify(item.before)) throw new PacError('POLICY_RACE', `Policy changed after preflight: ${target}`);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const staging = path.join(path.dirname(target), `.pac-policy-${crypto.randomUUID()}`);
        if (item.kind === 'directory') {
          await fs.cp(item.source, staging, { recursive: true, dereference: false, force: false, errorOnExist: true });
          if (await hashDirectory(staging) !== item.sha256) throw new PacError('POLICY_SOURCE_CHANGED', `Profile Skill changed: ${item.name}`);
        } else if (item.kind === 'link') {
          await fs.symlink(item.link, staging, process.platform === 'win32' ? 'junction' : 'dir');
        } else await fs.writeFile(staging, item.content, { mode: 0o600, flag: 'wx' });
        const prior = path.join(backup, `${index}`);
        const entry = { target, prior: item.before ? prior : null, moved: false, installed: false, staging };
        journal.push(entry);
        await atomicWriteFile(path.join(backup, 'journal.json'), JSON.stringify(journal, null, 2));
        if (item.before) {
          await fs.rename(target, prior);
          entry.moved = true;
          await atomicWriteFile(path.join(backup, 'journal.json'), JSON.stringify(journal, null, 2));
        }
        await fs.rename(staging, target);
        entry.installed = true;
        await atomicWriteFile(path.join(backup, 'journal.json'), JSON.stringify(journal, null, 2));
      }
      for (const item of planned) {
        if ((await identity(context.home, path.join(context.home, item.relativePath)))?.sha256 !== item.sha256) throw new PacError('POLICY_VERIFY_FAILED', `Policy verification failed: ${item.relativePath}`);
      }
      const entries = new Map(fullInstallation ? [] : state.entries.map((e) => [e.relativePath, e]));
      for (const item of planned) entries.set(item.relativePath, { relativePath: item.relativePath, sha256: item.sha256 });
      const result = { schemaVersion: 1, mode: 'policy-only', profileCommit: commit, profileRoot: current.root,
        agents: [...new Set([...(state.agents || []), ...agents])], backup, entries: [...entries.values()] };
      const ownerFile = path.join(context.home, STATE);
      if (await statOrNull(ownerFile)) await fs.copyFile(ownerFile, path.join(backup, 'previous-state.json'));
      await atomicWriteFile(ownerFile, JSON.stringify(result, null, 2));
      return { mode: 'policy-only', ok: true, profileCommit: commit, agents: result.agents,
        backup, changed: changes.length, skills: skills.length, hooks: 'not-modified',
        packageManagers: 'not-assessed' };
    } catch (error) {
      for (const entry of [...journal].reverse()) {
        if (entry.installed) await fs.rename(entry.target, `${entry.prior || entry.staging}.failed-${crypto.randomUUID()}`);
        if (entry.moved) await fs.rename(entry.prior, entry.target);
      }
      throw error;
    }
  });
}
