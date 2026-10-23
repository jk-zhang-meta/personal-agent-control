import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './atomic-file.mjs';
import { PacError } from './errors.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';
import { SCAN_GUARD_MARKER } from './scan-guard-policy.mjs';

export { SCAN_GUARD_MARKER, SCAN_GUARD_POLICY_VERSION, inspectCommand, hookDecision } from './scan-guard-policy.mjs';
export const SCAN_GUARD_SCHEMA = 4;
const STATE = '.local/state/personal-agent-control/scan-guard.json';
const HOST_FILES = {
  codex: ['.codex/config.toml', '.codex/hooks.json'],
  claude: ['.claude/settings.json'],
};

function hostFiles(host) {
  if (!HOST_FILES[host]) throw new PacError('HOST_SELECTION_INVALID', `Unknown host: ${host}`);
  return HOST_FILES[host];
}

function ownership(context) {
  try { return JSON.parse(fs.readFileSync(path.join(context.home, STATE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: SCAN_GUARD_SCHEMA, hosts: {} }; throw error; }
}

function pacHandler(hook) {
  return [hook?.command, hook?.commandWindows, hook?.command_windows]
    .some((command) => typeof command === 'string' && command.includes(SCAN_GUARD_MARKER));
}

// Retire individual handlers, not entire matcher groups: a host/plugin may
// have appended its own handler to the same group.
function retireJson(text) {
  const config = JSON.parse(text);
  const entries = config?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return text;
  let changed = false;
  config.hooks.PreToolUse = entries.flatMap((entry) => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook) => !pacHandler(hook));
    if (hooks.length === entry.hooks.length) return [entry];
    changed = true;
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
  return changed ? `${JSON.stringify(config, null, 2)}\n` : text;
}

function stringEnd(text, start) {
  const quote = text[start];
  const delimiter = text.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  for (let index = start + delimiter.length; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') { index += 1; continue; }
    if (!text.startsWith(delimiter, index)) continue;
    let end = index + delimiter.length;
    if (delimiter.length === 3) while (text[end] === quote) end += 1;
    return end;
  }
  throw new PacError('SCAN_GUARD_CONFIG_INVALID', 'Unterminated TOML string; host config was not changed.');
}

// TOML examples inside multiline instructions are data, not hook tables.
// Walk string/comment/container boundaries before recognizing statements.
function tomlStatements(text) {
  const statements = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") { index = stringEnd(text, index) - 1; continue; }
    if (char === '#') {
      const newline = text.indexOf('\n', index);
      if (newline < 0) break;
      index = newline - 1;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
    if (char !== '\n' || depth !== 0) continue;
    statements.push({ start, end: index + 1, raw: text.slice(start, index + 1) });
    start = index + 1;
  }
  if (start < text.length) statements.push({ start, end: text.length, raw: text.slice(start) });
  return statements;
}

function pacTomlCommand(statement) {
  const match = /^[ \t]*(?:command(?:_windows|Windows)?|"command(?:_windows|Windows)?"|'command(?:_windows|Windows)?')[ \t]*=[ \t]*/u.exec(statement.raw);
  if (!match) return false;
  const start = match[0].length;
  if (statement.raw[start] !== '"' && statement.raw[start] !== "'") return false;
  return statement.raw.slice(start, stringEnd(statement.raw, start)).includes(SCAN_GUARD_MARKER);
}

function retireToml(text) {
  const statements = tomlStatements(text);
  const sections = statements.flatMap((statement) => {
    const match = /^[ \t]*(\[\[?.+?\]\]?)[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/u.exec(statement.raw);
    return match ? [{ index: statement.start, key: match[1] }] : [];
  });
  const edits = [];
  for (let index = 0; index < sections.length; index += 1) {
    if (sections[index].key !== '[[hooks.PreToolUse]]') continue;
    let end = index + 1;
    while (end < sections.length && sections[end].key === '[[hooks.PreToolUse.hooks]]') end += 1;
    const handlers = sections.slice(index + 1, end).map((section, offset) => {
      const finish = sections[index + offset + 2]?.index ?? text.length;
      return { start: section.index, end: finish,
        pac: statements.some((statement) => statement.start >= section.index
          && statement.start < finish && pacTomlCommand(statement)) };
    });
    const retired = handlers.filter((handler) => handler.pac);
    if (!retired.length) continue;
    if (retired.length === handlers.length) {
      edits.push({ start: sections[index].index, end: sections[end]?.index ?? text.length });
    } else edits.push(...retired);
  }
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    text = text.slice(0, edit.start) + text.slice(edit.end);
  }
  return text;
}

async function configState(context, relative) {
  const file = path.join(context.home, relative);
  await assertSafeManagedObject(context.home, file, 'retired PAC hook config', 'file');
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { file, text: null, next: null }; throw error; }
  const next = relative.endsWith('.toml') ? retireToml(text) : retireJson(text);
  return { file, text, next };
}

export function scanGuardManagedPaths(context, hosts = ['codex', 'claude']) {
  const paths = new Set([STATE, '.agent-work/runtime/pac/scan-guard-hook.mjs',
    '.config/personal-agent-control/search-roots.json']);
  const prior = ownership(context);
  // Backup compatibility only: old installations may have a staged policy
  // before their ownership receipt was committed. Never execute or stage it.
  try {
    const digest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(context.root, 'src/scan-guard-policy.mjs'))).digest('hex');
    paths.add(`.agent-work/runtime/pac/scan-guard-hook-${digest}.mjs`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (/^\.agent-work\/runtime\/pac\/scan-guard-hook-[0-9a-f]{64}\.mjs$/u.test(prior.runtimeRelative || '')) {
    paths.add(prior.runtimeRelative);
  }
  for (const host of hosts) for (const relative of hostFiles(host)) paths.add(relative);
  return [...paths].sort();
}

export async function scanGuardStatus(context, enabledHosts, scopeHosts) {
  const results = [];
  for (const host of new Set(scopeHosts)) {
    const configs = await Promise.all(hostFiles(host).map((file) => configState(context, file)));
    const pending = configs.some(({ text, next }) => text !== next);
    results.push({ host, state: pending ? 'pending-removal' : 'inactive', expected: 'absent',
      valid: !pending, reason: 'PAC tool interception has been removed' });
  }
  return results;
}

// Migration only. Selecting Skills, enabling hosts, and applying PAC never
// installs a tool gate, reads a search registry, or probes native hook trust.
export async function reconcileScanGuard(context, enabledHosts, scopeHosts) {
  const hosts = [];
  for (const host of new Set(scopeHosts)) {
    let changed = false;
    for (const relative of hostFiles(host)) {
      const { file, text, next } = await configState(context, relative);
      if (text === next) continue;
      if (await fsp.readFile(file, 'utf8') !== text) {
        throw new PacError('SCAN_GUARD_CONFIG_CHANGED', `Host config changed during hook retirement: ${file}`);
      }
      const stat = await fsp.stat(file);
      await atomicWriteFile(file, next, stat.mode & 0o777);
      changed = true;
    }
    hosts.push({ host, action: changed ? 'retired' : 'absent' });
  }
  const file = path.join(context.home, STATE);
  await assertSafeManagedObject(context.home, file, 'retired PAC hook ownership', 'file');
  const prior = ownership(context);
  if (prior.hosts && [...new Set(scopeHosts)].some((host) => prior.hosts[host])) {
    for (const host of new Set(scopeHosts)) delete prior.hosts[host];
    await atomicWriteFile(file, `${JSON.stringify(prior, null, 2)}\n`, 0o600);
  }
  return { skipped: false, retired: true, hosts };
}

export async function hasPriorScanGuardState(context, host) {
  hostFiles(host);
  return Boolean(ownership(context).hosts?.[host]);
}
