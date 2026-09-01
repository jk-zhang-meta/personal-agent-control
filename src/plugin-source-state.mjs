import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Some native Plugin runtimes perform a deterministic, local self-heal at
// startup.  context-mode, for example, resolves ${CLAUDE_PLUGIN_ROOT} and the
// Node executable in its Claude hook manifests on Linux.  The self-heal is
// useful for the host, but it must not turn a pinned source checkout into an
// arbitrary mutable trust root.  This module recognizes only that narrow,
// semantics-preserving rewrite.  Everything else remains a source drift.

const PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
const ALLOWED_FILES = new Set(['.claude-plugin/plugin.json', 'hooks/hooks.json']);

function git(directory, args) {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function normalizedRoot(directory) {
  return path.resolve(directory).replaceAll('\\', '/').replace(/\/$/u, '');
}

function isAbsoluteNode(value, allowBun = false) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value)) return false;
  const base = path.posix.basename(value).toLowerCase();
  return base === 'node' || (allowBun && base === 'bun');
}

function readHeadJson(directory, relative) {
  return JSON.parse(git(directory, ['show', `HEAD:${relative}`]));
}

function readWorktreeJson(directory, relative) {
  const absolute = path.join(directory, ...relative.split('/'));
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function restorePluginCommand(value, canonical) {
  if (value === canonical) return { value, changed: false, valid: true };
  if (canonical !== 'node' || !isAbsoluteNode(value)) {
    return { value, changed: true, valid: false };
  }
  return { value: canonical, changed: true, valid: true, rootRewrite: false };
}

function restorePluginArg(value, canonical, root) {
  if (value === canonical) return { value, changed: false, valid: true };
  if (typeof canonical !== 'string' || !canonical.includes(PLACEHOLDER)) {
    return { value, changed: true, valid: false };
  }
  const expected = canonical.replaceAll(PLACEHOLDER, root);
  if (value !== expected) return { value, changed: true, valid: false };
  return { value: canonical, changed: true, valid: true, rootRewrite: true };
}

function restorePluginJson(current, canonical, root) {
  const restored = structuredClone(current);
  const expected = structuredClone(canonical);
  let changed = false;
  let rootRewrite = false;

  if (!current || typeof current !== 'object' || !canonical || typeof canonical !== 'object') {
    return null;
  }
  const currentServers = current.mcpServers;
  const canonicalServers = canonical.mcpServers;
  if (!currentServers || typeof currentServers !== 'object' ||
      !canonicalServers || typeof canonicalServers !== 'object' ||
      JSON.stringify(Object.keys(currentServers)) !== JSON.stringify(Object.keys(canonicalServers))) {
    return null;
  }

  for (const name of Object.keys(canonicalServers)) {
    const currentServer = currentServers[name];
    const canonicalServer = canonicalServers[name];
    if (!currentServer || typeof currentServer !== 'object' ||
        !canonicalServer || typeof canonicalServer !== 'object') return null;

    const command = restorePluginCommand(currentServer.command, canonicalServer.command);
    if (!command.valid) return null;
    const args = Array.isArray(canonicalServer.args) && Array.isArray(currentServer.args)
      ? currentServer.args.map((value, index) => restorePluginArg(value, canonicalServer.args[index], root))
      : null;
    if (args === null || args.length !== canonicalServer.args.length || args.some((item) => !item.valid)) {
      return null;
    }
    const serverRestored = structuredClone(currentServer);
    serverRestored.command = command.value;
    serverRestored.args = args.map((item) => item.value);
    restored.mcpServers[name] = serverRestored;
    changed ||= command.changed || args.some((item) => item.changed);
    rootRewrite ||= args.some((item) => item.rootRewrite === true);
  }

  if (!changed || !rootRewrite || JSON.stringify(restored) !== JSON.stringify(expected)) return null;
  return restored;
}

function restoreHookCommand(value, canonical, root) {
  if (value === canonical) return { value, changed: false, valid: true };
  if (typeof value !== 'string' || typeof canonical !== 'string') {
    return { value, changed: true, valid: false };
  }

  // normalize-hooks.mjs emits: "<absolute node/bun>" "<absolute root>/...".
  // Keep the parser deliberately strict: no shell fragments or extra tokens
  // are accepted as a "known" runtime rewrite.
  const match = /^"([^"\n]+)" "([^"\n]+)"$/u.exec(value);
  const prefix = `node "${PLACEHOLDER}`;
  if (!match || !isAbsoluteNode(match[1], true) ||
      !canonical.startsWith(prefix) || !canonical.endsWith('"') ||
      !match[2].startsWith(`${root}/`)) {
    return { value, changed: true, valid: false };
  }
  const suffix = canonical.slice(prefix.length, -1);
  const expectedPath = `${root}${suffix}`;
  if (match[2] !== expectedPath) return { value, changed: true, valid: false };
  return { value: canonical, changed: true, valid: true, rootRewrite: true };
}

function restoreHooksJson(current, canonical, root) {
  if (!current || typeof current !== 'object' || !canonical || typeof canonical !== 'object') {
    return null;
  }
  const restored = structuredClone(current);
  let changed = false;
  let rootRewrite = false;
  const currentHooks = current.hooks;
  const canonicalHooks = canonical.hooks;
  if (!currentHooks || typeof currentHooks !== 'object' ||
      !canonicalHooks || typeof canonicalHooks !== 'object' ||
      JSON.stringify(Object.keys(currentHooks)) !== JSON.stringify(Object.keys(canonicalHooks))) {
    return null;
  }

  for (const event of Object.keys(canonicalHooks)) {
    const currentMatchers = currentHooks[event];
    const canonicalMatchers = canonicalHooks[event];
    if (!Array.isArray(currentMatchers) || !Array.isArray(canonicalMatchers) ||
        currentMatchers.length !== canonicalMatchers.length) return null;
    restored.hooks[event] = currentMatchers.map((currentMatcher, index) => {
      const canonicalMatcher = canonicalMatchers[index];
      if (!currentMatcher || typeof currentMatcher !== 'object' ||
          !canonicalMatcher || typeof canonicalMatcher !== 'object' ||
          !Array.isArray(currentMatcher.hooks) || !Array.isArray(canonicalMatcher.hooks) ||
          currentMatcher.hooks.length !== canonicalMatcher.hooks.length) return null;
      const next = structuredClone(currentMatcher);
      next.hooks = currentMatcher.hooks.map((currentHook, hookIndex) => {
        const canonicalHook = canonicalMatcher.hooks[hookIndex];
        if (!currentHook || typeof currentHook !== 'object' ||
            !canonicalHook || typeof canonicalHook !== 'object') return null;
        const command = restoreHookCommand(currentHook.command, canonicalHook.command, root);
        if (!command.valid) return null;
        const restoredHook = structuredClone(currentHook);
        restoredHook.command = command.value;
        changed ||= command.changed;
        rootRewrite ||= command.rootRewrite === true;
        return restoredHook;
      });
      if (next.hooks.some((hook) => hook === null)) return null;
      return next;
    });
    if (restored.hooks[event].some((matcher) => matcher === null)) return null;
  }

  if (!changed || !rootRewrite || JSON.stringify(restored) !== JSON.stringify(canonical)) return null;
  return restored;
}

function allowedStatusPaths(directory) {
  const status = git(directory, ['status', '--porcelain=v1', '--untracked-files=all']);
  const lines = status.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) return [];
  const paths = [];
  for (const line of lines) {
    // Only a worktree modification (" M") of one of the two manifests is
    // eligible. Index changes, deletions, renames, and untracked files fail.
    if (!/^ M (.+)$/u.test(line)) return null;
    const relative = line.slice(3);
    if (!ALLOWED_FILES.has(relative)) return null;
    paths.push(relative);
  }
  return [...new Set(paths)];
}

/**
 * Return true only when a pinned Plugin checkout contains the exact
 * semantics-preserving normalization emitted by context-mode's startup
 * self-heal.  The Git commit/tree and all non-manifest files are still checked
 * by the caller; this function is intentionally not a general dirty-tree
 * bypass.
 */
export function isKnownRuntimeMutation(directory) {
  const absolute = path.resolve(directory);
  const paths = allowedStatusPaths(absolute);
  if (paths === null || paths.length === 0) return false;
  const root = normalizedRoot(absolute);
  for (const relative of paths) {
    let current;
    let canonical;
    try {
      current = readWorktreeJson(absolute, relative);
      canonical = readHeadJson(absolute, relative);
    } catch {
      return false;
    }
    const restored = relative === '.claude-plugin/plugin.json'
      ? restorePluginJson(current, canonical, root)
      : restoreHooksJson(current, canonical, root);
    if (!restored) return false;
  }
  return true;
}

function main() {
  const [command, directory] = process.argv.slice(2);
  if (command !== 'check' || !directory || !isKnownRuntimeMutation(directory)) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('known runtime normalization\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
