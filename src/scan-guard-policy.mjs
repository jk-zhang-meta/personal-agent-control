import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is intentionally dependency-free.  PAC stages an exact copy in
// the local runtime and the host hooks execute that copy, never a live
// OneDrive checkout.  Keep the policy lexical and side-effect free: it must
// not walk a workspace while deciding whether a command may run.
export const SCAN_GUARD_POLICY_VERSION = 2;
export const SCAN_GUARD_MARKER = '--pac-scan-guard-v2';

// Normalize the common native/Windows spellings and the small set of tools
// that are functionally equivalent to rg/find.  The hook must not rely on the
// spelling an agent happened to choose (`rg.exe`, `ripgrep`, `ag`, ...).
const SCAN_ALIASES = new Map([
  ['ripgrep', 'rg'], ['ack', 'rg'], ['ag', 'rg'], ['sift', 'rg'],
  ['bfs', 'find'], ['walk', 'find'], ['fselect', 'find'],
  ['plocate', 'locate'], ['mlocate', 'locate'], ['fd-find', 'fd'],
  ['the_silver_searcher', 'rg'], ['silver-searcher', 'rg'], ['pt', 'rg'],
  ['rga', 'rg'], ['ripgrep-all', 'rg'], ['ugrep', 'rg'],
]);
const SCAN_BINARIES = new Set([
  'rg', 'grep', 'find', 'fd', 'fdfind', 'tree', 'du', 'ls', 'eza', 'lsd',
  'locate', 'updatedb', 'ctags', 'codegraph', 'semgrep', 'codeql', 'cloc',
  'scc', 'tokei', 'dust', 'gdu', 'ncdu', 'broot', 'comby', 'global',
  'sourcegraph',
]);
// `du` is intentionally not brokerable: even `du --max-depth 0` must walk
// every descendant to calculate the root total. Use the locator's metadata
// index for size/path questions instead of turning a depth flag into a false
// promise of bounded I/O.
const BROKER_SCAN_BINARIES = new Set(['rg', 'grep', 'find', 'fd', 'fdfind', 'tree', 'ls', 'eza', 'lsd']);
const GIT_SCAN_SUBCOMMANDS = new Set(['grep', 'ls-files', 'ls-tree']);
const GIT_SAFE_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'cat-file', 'describe',
  'shortlog', 'count-objects', 'version', 'help', 'blame', 'branch',
  'tag', 'remote', 'init', 'add', 'commit', 'restore', 'switch',
]);
// Git's nominally read-only commands can invoke repository-configured
// external diff/textconv/fsmonitor/pager helpers or change executable lookup.
// Keep these options out of the direct shell path; a brokered build/test can
// choose an explicitly reviewed environment instead.
const GIT_UNSAFE_OPTIONS = new Set([
  '--ext-diff', '--no-ext-diff', '--textconv', '--no-textconv', '--fsmonitor',
  '--no-fsmonitor', '--exec-path', '--config-env', '--paginate', '--no-pager',
  '--upload-pack', '--receive-pack', '--attr-source', '--super-prefix',
  '--no-index', '--pathspec-from-file', '--pathspec-file-nul',
  '--literal-pathspecs-from-file', '--glob-pathspecs-from-file',
]);
const GIT_BROAD_OPTIONS = new Set([
  '--all', '--branches', '--remotes', '--tags', '--glob', '--reflog', '--walk-reflogs',
  '--name-only', '--name-status', '--stat', '--numstat', '--shortstat', '--dirstat',
  '--patch', '-p', '--raw', '--patch-with-raw', '--full-diff', '--binary',
  '--batch', '--batch-check', '--batch-all-objects', '--batch-command',
  '--recurse-submodules', '--submodules', '--ignored', '--untracked-files',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'cmd.exe']);
const WRAPPERS = new Set(['command', 'exec', 'env', 'nice', 'ionice', 'timeout']);
const INTERPRETERS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'python2', 'pypy',
  'ruby', 'perl', 'php', 'lua', 'luajit', 'java', 'jshell', 'r', 'rscript',
  'julia', 'groovy', 'kotlin', 'kotlinc', 'swift', 'tclsh', 'wish', 'guile',
  'elixir', 'erl', 'ocaml', 'ocamlrun', 'racket', 'clojure', 'sqlite3', 'm4',
]);
const SCRIPT_CAPABLE_COMMANDS = new Set([
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'gsed', 'perl', 'ruby', 'php', 'lua',
  'r', 'rscript', 'julia', 'groovy', 'kotlin', 'kotlinc', 'swift', 'tclsh',
  'wish', 'guile', 'elixir', 'erl', 'ocaml', 'ocamlrun', 'racket', 'clojure',
  'sqlite3', 'm4',
]);
const SCRIPT_BUILTINS = new Set(['source', '.']);
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'bunx', 'mise']);
const SHELL_STATE_COMMANDS = new Set([
  'alias', 'unalias', 'function', 'hash', 'unhash', 'enable', 'disable', 'builtin',
  'export', 'unset', 'readonly', 'declare', 'typeset', 'set', 'shopt', 'autoload',
  'compdef', 'compinit', 'compgen', 'which', 'whereis', 'type',
]);
const SCAN_TASK_RUNNERS = new Set([
  ...SCRIPT_RUNNERS, 'make', 'just', 'task', 'cargo', 'bazel', 'buck', 'ninja',
  'cmake', 'gradle', 'gradlew', 'mvn', 'mvnw', 'go', 'tox', 'pytest', 'docker', 'podman',
  'dotnet', 'msbuild', 'terraform', 'tofu', 'ansible', 'ansible-playbook',
  'qjs', 'quickjs',
]);
// These launchers can dispatch a script/remote command whose scan behavior is
// not visible in the current argv (`sudo make`, `ssh host command`,
// `busybox sh`, ...). They are intentionally unavailable on the shell path;
// an agent must submit the concrete workload to resource-guard so the host
// can apply a budget and receipt.
const OPAQUE_LAUNCHERS = new Set([
  'sudo', 'doas', 'setsid', 'nohup', 'chrt', 'systemd-run', 'busybox', 'ssh',
  'mosh', 'srun', 'watch', 'screen', 'tmux', 'env', 'command', 'exec', 'xargs',
  'parallel', 'time', 'strace', 'dtrace', 'gdb', 'lldb', 'kubectl',
]);
// These commands can affect host services/apps or remote infrastructure. A
// resource budget cannot make those side effects safe, so the agent hook
// rejects them outright instead of treating them as ordinary local work.
const HOST_CONTROL_COMMANDS = new Set([
  'systemctl', 'service', 'launchctl', 'open', 'osascript', 'flatpak', 'snap',
  'helm', 'terraform', 'tofu', 'ansible', 'ansible-playbook', 'docker', 'podman',
]);
const OPAQUE_CODE_OPTIONS = new Set([
  '-c', '-e', '--command', '--exec', '--execute', '--eval', '--expression',
  '--run', '--script', '--program', '--code',
]);
const OPAQUE_SCRIPT_OPTIONS = new Set(['-f', '--file']);
const BROKERED_WORKLOADS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'python2', 'pypy',
  'ruby', 'perl', 'php', 'lua', 'luajit', 'torchrun', 'accelerate',
  'deepspeed', 'vllm', 'ollama', 'llama-server', 'mlx.launch',
]);
const GUARDED_WORKLOADS = new Set([
  ...SCAN_TASK_RUNNERS, ...BROKERED_WORKLOADS,
  'rustc', 'msbuild', 'dotnet', 'pip', 'pipx', 'uv', 'conda', 'terraform',
  'ansible', 'pytest', 'mocha', 'jest', 'vitest', 'gradlew', 'mvnw', 'qjs', 'quickjs',
]);
const SAFE_LITERAL_COMMANDS = new Set([
  'echo', 'printf', 'true', 'false', 'pwd', 'cd', 'test', '[', 'head', 'tail', 'cat',
]);
// Commands in this set treat scanner-looking words as data or ordinary file
// operands rather than as a nested command. They are still subject to their
// own write/path policy and are not a bypass for an actual scanner segment.
const SAFE_ARGUMENT_COMMANDS = new Set([
  // Keep this set to commands whose argv cannot read/write an arbitrary
  // pathname or spawn another process. Git is handled by `gitUnsafe` below;
  // all other file utilities, filters, archives, and network clients must
  // cross the PAC resource broker so CPU/RAM/I/O and output are measured.
  ...SAFE_LITERAL_COMMANDS, 'git',
]);
const COMMON_NON_SCAN_COMMANDS = new Set([
  ...SAFE_ARGUMENT_COMMANDS, 'clear', 'reset', 'date', 'uname', 'whoami', 'id', 'sleep',
  'which', 'whereis', 'type',
  ...SHELL_STATE_COMMANDS, ...INTERPRETERS, ...SHELLS,
]);
// PreToolUse is matched broadly so a newly introduced shell-capable tool
// cannot bypass the gate. Known host-native tools are not a passive string
// allowlist: each class below receives its own bounded input/resource schema
// before the generic command/MCP heuristics run. This is important for Codex
// `apply_patch`, whose patch text is carried in a field named `command` but is
// not a shell command, and for source text that legitimately mentions rg/find.
const NATIVE_PATCH_TOOLS = new Set(['apply_patch', 'ApplyPatch']);
const NATIVE_READ_TOOLS = new Set(['Read', 'ReadFile', 'read_file']);
const NATIVE_WRITE_TOOLS = new Set(['Write', 'WriteFile', 'write_file']);
const NATIVE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit']);
const NATIVE_NOTEBOOK_READ_TOOLS = new Set(['NotebookRead']);
const NATIVE_NOTEBOOK_EDIT_TOOLS = new Set(['NotebookEdit']);
const NATIVE_IMAGE_READ_TOOLS = new Set(['view_image']);
const NATIVE_WEB_TOOLS = new Set(['WebSearch', 'WebFetch', 'Fetch', 'web__run']);
const NATIVE_IMAGE_GENERATION_TOOLS = new Set(['image_gen__imagegen']);
const NATIVE_SCHEMA_TOOLS = new Set([
  ...NATIVE_PATCH_TOOLS, ...NATIVE_READ_TOOLS, ...NATIVE_WRITE_TOOLS,
  ...NATIVE_EDIT_TOOLS, ...NATIVE_NOTEBOOK_READ_TOOLS,
  ...NATIVE_NOTEBOOK_EDIT_TOOLS, ...NATIVE_IMAGE_READ_TOOLS,
  ...NATIVE_WEB_TOOLS, ...NATIVE_IMAGE_GENERATION_TOOLS,
]);
const DANGEROUS_ENV_NAMES = /^(?:PATH|IFS|HOME|SHELLOPTS|BASHOPTS|PAGER|GIT_PAGER|GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|LESSOPEN|LESSCLOSE|GIT_SSH|GIT_SSH_COMMAND|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|RIPGREP_CONFIG_PATH|RG_CONFIG_PATH|GREP_OPTIONS|FD_OPTIONS|FD_DEFAULT_OPTS|FZF_DEFAULT_COMMAND|FZF_DEFAULT_OPTS|TREE_OPTIONS|DU_OPTIONS|LS_OPTIONS|NODE_OPTIONS|NODE_PATH|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|GLIBC_TUNABLES|GCONV_PATH|LOCPATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|PERL5OPT|PERL5LIB|BASH_ENV|ENV|ENVIRONMENT|GIT_CONFIG_[A-Z0-9_]+|GIT_EXEC_PATH|NPM_CONFIG_USERCONFIG|NPM_CONFIG_GLOBALCONFIG|PHP_INI_SCAN_DIR|CDPATH|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CONFIG_DIRS|TMPDIR|TEMP|PIP_CONFIG_FILE|CURL_HOME|WGETRC)$/iu;
const DANGEROUS_INHERITED_GIT_ENV = /^(?:GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|LESSOPEN|LESSCLOSE|GIT_SSH|GIT_SSH_COMMAND|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_CONFIG_[A-Z0-9_]+|GIT_EXEC_PATH|GIT_TEMPLATE_DIR)$/iu;
const SHELL_OPERATORS = new Set([';', '&&', '||', '|', '|&', '&', '(', ')', '>', '>>', '<', '<<', '\n']);
const SUBSTITUTION_RE = /(?:\$\(|`)/u;
const VARIABLE_RE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})/u;
// Parameter forms not represented by VARIABLE_RE (`$@`, `$?`, `$'...'`,
// arithmetic expansion, etc.) can alter the executable after tokenisation.
// They are unsafe around every non-literal command and must go through the
// fixed broker where argv is constructed without shell expansion.
const PARAM_EXPANSION_RE = /\$(?:\(|\{|['"`]|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?!_$-])/u;
const CONTEXT_TOOL_PREFIX = 'mcp__(?:plugin_)?context(?:-|_)mode(?:_context(?:-|_)mode)?__ctx_';
const KNOWN_SHELL_TOOL_RE = new RegExp(`^(?:Bash|Shell|local_shell|shell|shell_command|exec_command|ctx_execute|ctx_execute_file|ctx_batch_execute|ctx_index|ctx_fetch_and_index|ctx_search|${CONTEXT_TOOL_PREFIX}(?:execute|execute_file|batch_execute|index|fetch_and_index|search))$`, 'u');
const CONTEXT_INDEX_TOOL_RE = new RegExp(`^(?:ctx_index|ctx_fetch_and_index|${CONTEXT_TOOL_PREFIX}(?:index|fetch_and_index))$`, 'u');
const CONTEXT_SEARCH_TOOL_RE = new RegExp(`^(?:ctx_search|${CONTEXT_TOOL_PREFIX}search)$`, 'u');
const CONTEXT_EXECUTE_TOOL_RE = new RegExp(`^(?:ctx_execute|ctx_execute_file|ctx_batch_execute|${CONTEXT_TOOL_PREFIX}(?:execute|execute_file|batch_execute))$`, 'u');
// CodeGraph is the only non-context MCP provider declared by PAC Core today.
// Keep the default to its single, documented read-only tool. A provider
// prefix is deliberately not enough: re-enabling `codegraph_node` or a future
// server tool can change the filesystem surface without changing the prefix.
// New tools/providers must add an exact read-only allowlist entry during PAC
// reconciliation; unknown `mcp__*` tools fail closed instead of relying on
// payload-key heuristics.
const DEFAULT_APPROVED_MCP_TOOLS = Object.freeze([
  'mcp__codegraph__codegraph_explore',
  'mcp__plugin_codegraph_codegraph__codegraph_explore',
  'mcp__plugin_codegraph__codegraph_explore',
]);
const DEFAULT_REGISTRY_RELATIVE = '.config/personal-agent-control/search-roots.json';
const MAX_REGISTERED_ROOTS = 128;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_DEPTH = 2;
const MAX_ROOTS = 1;
const MAX_RESULTS = 200;
const MAX_DIRECT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DIRECT_CONTEXT = 20;
const MAX_DIRECT_COLUMNS = 2000;
const MAX_PIPE_LITERAL_BYTES = 64 * 1024;
const MAX_PIPE_ARGUMENTS = 32;
const MAX_NATIVE_INPUT_BYTES = 512 * 1024;
const MAX_NATIVE_CONTENT_BYTES = 1024 * 1024;
const MAX_NATIVE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_PATH_BYTES = 4096;
const MAX_NATIVE_PATCH_FILES = 64;
const MAX_NATIVE_PATCH_HUNKS = 1024;
const MAX_NATIVE_WEB_REQUESTS = 64;
const MAX_LOCATOR_QUERY = 512;
const MAX_LOCATOR_RESULTS = 50;
const SCAN_INTENT_RE = /(?:--(?:files|glob|hidden|no-ignore|follow|max-depth|max-files|max-read-bytes)|(?:^|\s)-{1,2}(?:R|r|L|H|P|type|iname|name|path|maxdepth|exec|delete)(?:\b|=)|(?:^|\s)\/(?:etc|home|root|tmp|var|usr|opt|proc|sys)(?:\/|\s|$)|(?:^|\s)\/(?:\s|$))/iu;
const SCRIPT_EXTENSIONS_RE = /\.(?:sh|bash|zsh|fish|ps1|cmd|bat|py|py3|rb|pl|pm|php|lua|js|mjs|cjs|ts|tsx|jar)$/iu;
const SCRIPT_EXECUTION_RE = /(?:\bsystem\s*\(|\b(?:getline|popen|exec|spawn|fork)\b|(?:^|[;\s])e(?:[;\s]|$)|\/e(?:[;\s]|$))/iu;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function commandName(token) {
  let name = path.basename(String(token || '').replaceAll('\\', '/')).toLowerCase();
  // Native Windows command names are often surfaced with an extension even
  // when the same tool is invoked bare on WSL/macOS.
  name = name.replace(/\.(?:exe|cmd|bat)$/u, '');
  return SCAN_ALIASES.get(name) || name;
}

function quotePosix(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function tokenize(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let unsafeSyntax = false;
  let unclosedQuote = false;
  const push = () => {
    if (current !== '') { tokens.push(current); current = ''; }
  };
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaped) {
      // In POSIX shells a backslash-newline is a line continuation, so it can
      // turn two harmless-looking fragments into `find`, `rg`, or another
      // scanner. Keep the resulting token but mark the syntax untrusted.
      if (ch === '\n' || ch === '\r') { escaped = false; unsafeSyntax = true; continue; }
      current += ch; escaped = false; continue;
    }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\n' || ch === '\r') {
      push(); tokens.push('\n'); unsafeSyntax = true; continue;
    }
    if (ch === '$' && command[index + 1] === '(') unsafeSyntax = true;
    if (ch === '`') unsafeSyntax = true;
    if (';&|()<>'.includes(ch)) {
      push();
      const pair = command.slice(index, index + 2);
      if (['&&', '||', '>>', '<<', '|&'].includes(pair)) { tokens.push(pair); index += 1; }
      else tokens.push(ch);
      continue;
    }
    if (/\s/u.test(ch)) { push(); continue; }
    current += ch;
  }
  if (escaped) { current += '\\'; unsafeSyntax = true; }
  push();
  if (quote) { unclosedQuote = true; unsafeSyntax = true; }
  return { tokens, unsafeSyntax, unclosedQuote };
}

function commandSegments(tokens) {
  const result = [];
  let current = [];
  let preceding = null;
  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token)) {
      if (current.length) result.push({ tokens: current, preceding });
      current = [];
      preceding = token;
    } else current.push(token);
  }
  if (current.length) result.push({ tokens: current, preceding });
  return result;
}

function unwrap(tokens) {
  let index = 0;
  let wrapped = false;
  // Shell assignment words are part of the command prefix, not an
  // executable.  Consume them before looking through PAC's small wrapper
  // grammar so `FOO=bar find ...` cannot make the scanner disappear from the
  // lexical gate.  `dangerousAssignment()` still runs before this result is
  // used and rejects PATH/config/loader indirection explicitly.
  while (index < tokens.length && leadingAssignment(tokens[index])) index += 1;
  while (index < tokens.length) {
    const name = commandName(tokens[index]);
    if (!WRAPPERS.has(name)) break;
    wrapped = true;
    index += 1;
    if (name === 'env') {
      while (index < tokens.length && (
        /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]) ||
        ['-i', '--ignore-environment'].includes(tokens[index])
      )) index += 1;
      while (index < tokens.length) {
        const option = String(tokens[index]);
        if (option === '-u' || option === '--unset' || option === '-C' || option === '--chdir') {
          index += 2; continue;
        }
        if (option.startsWith('--unset=') || option.startsWith('--chdir=')) {
          index += 1; continue;
        }
        if (option === '-0') { index += 1; continue; }
        break;
      }
      if (tokens[index] === '--') index += 1;
      continue;
    }
    if (name === 'timeout') {
      // A timeout duration is a value, not an executable.  Unknown timeout
      // options are deliberately not interpreted here; they fail closed.
      if (tokens[index] && !tokens[index].startsWith('-')) index += 1;
      continue;
    }
    while (index < tokens.length && tokens[index].startsWith('-')) {
      index += 1;
      if (tokens[index - 1] === '-n' || tokens[index - 1] === '-t') index += 1;
    }
  }
  return { index, wrapped };
}

function shellInner(tokens, index) {
  const executable = commandName(tokens[index]);
  if (!SHELLS.has(executable)) return null;
  const rest = tokens.slice(index + 1);
  for (let offset = 0; offset < rest.length; offset += 1) {
    const token = String(rest[offset]);
    // POSIX shells accept clustered short options (`-ec`, `-fc`, `-ic`) and
    // PowerShell/cmd use long or slash-prefixed command options. Treat every
    // command-bearing form as opaque and inspect the following script.
    if (/^(?:--command|-command|-c|\/c)$/iu.test(token)) {
      const script = rest[offset + 1];
      return script === undefined ? { opaque: true } : { script };
    }
    if (/^(?:--command|-command)=/iu.test(token)) return { script: token.slice(token.indexOf('=') + 1) };
    if (/^-[^-]*c/iu.test(token) || token === '-c' || token === '-lc') {
      const script = rest[offset + 1];
      return script === undefined ? { opaque: true } : { script };
    }
  }
  // A shell with any remaining arguments is still an opaque interpreter. It
  // is only reported by the caller when a traversal primitive is present.
  return rest.length ? { opaque: true } : null;
}

function isSyncedStorage(value) {
  const lower = String(value || '').replaceAll('\\', '/').toLowerCase();
  return lower.includes('/onedrive') || lower.includes('/cloudstorage') ||
    lower.includes('/dropbox') || lower.includes('/google drive') ||
    // Any WSL drvfs mount can be backed by a synchronizer or a Windows ACL
    // whose mode bits are not observable from Linux.  Keep all such roots on
    // the index-only path; a project can opt in to a narrower local WSL root
    // instead of making a whole mounted drive searchable by the agent.
    /^\/mnt\/[a-z](?:\/|$)/u.test(lower);
}

function defaultRegistryPath(home) {
  return path.join(home || process.env.HOME || process.cwd(), DEFAULT_REGISTRY_RELATIVE);
}

function registryRoots(options, home) {
  let entries = options._registeredRootEntries;
  if (entries === undefined) {
    if (Array.isArray(options.registeredRoots)) entries = options.registeredRoots;
    else {
      const file = options.registryPath || defaultRegistryPath(home);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
          return { roots: [], error: 'search registry is not a private regular file' };
        }
        const raw = fs.readFileSync(file);
        if (raw.length > MAX_REGISTRY_BYTES) return { roots: [], error: 'search registry exceeds 1 MiB' };
        if (options.registrySha256 && digest(raw) !== options.registrySha256) return { roots: [], error: 'search registry digest differs from PAC state' };
        const value = JSON.parse(raw.toString('utf8'));
        if (!value || value.schemaVersion !== 1 || !Array.isArray(value.roots)) {
          return { roots: [], error: 'search registry has an invalid schema' };
        }
        entries = value.roots;
        options._registrySha256 = digest(raw);
      } catch (error) {
        if (error.code === 'ENOENT') return { roots: [], error: 'search registry is missing' };
        return { roots: [], error: `search registry cannot be read: ${error.message}` };
      }
    }
  }
  if (!Array.isArray(entries) || entries.length > MAX_REGISTERED_ROOTS) {
    return { roots: [], error: `search registry exceeds ${MAX_REGISTERED_ROOTS} roots` };
  }
  const roots = [];
  for (const entry of entries) {
    const value = typeof entry === 'string' ? entry : entry?.path;
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      return { roots: [], error: 'search registry contains a non-absolute root' };
    }
    const info = safeCwd(path.resolve(value), home);
    if (!info) return { roots: [], error: `registered root is unsafe or missing: ${value}` };
    const id = typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : null;
    roots.push({ ...info, id });
  }
  return { roots, sha256: options._registrySha256 || null };
}

function registeredWorkspace(cwdInfo, options, home) {
  const loaded = options._registeredRootInfo || registryRoots(options, home);
  if (loaded.error) return { root: null, error: loaded.error };
  const matches = loaded.roots.filter((root) => {
    const suffix = path.relative(root.absolute, cwdInfo.absolute);
    return suffix === '' || (!suffix.startsWith('..') && !path.isAbsolute(suffix));
  });
  matches.sort((left, right) => right.absolute.length - left.absolute.length);
  return { root: matches[0] || null, error: null };
}

function safeCwd(cwd, home) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const absolute = path.resolve(cwd);
  if (absolute === path.parse(absolute).root || (home && absolute === path.resolve(home))) return null;
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return null; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  let cursor = path.parse(absolute).root;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const synced = isSyncedStorage(absolute);
  for (const component of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const item = fs.lstatSync(cursor);
      if (item.isSymbolicLink()) return null;
      // On a normal local filesystem, a writable ancestor or an unrelated
      // owner makes a registered root raceable.  WSL drvfs is the one
      // deliberate exception: its 0777 mode is a projection of Windows ACLs,
      // so the synchronized-storage decision above still forces index-only
      // handling while preserving usability of a clean OneDrive checkout.
      if (!synced && ((item.mode & 0o022) !== 0 ||
          (uid !== null && item.uid !== uid && item.uid !== 0))) return null;
    } catch { return null; }
  }
  // Do not spend the host's I/O budget recursively exploring a synchronized
  // mount. Exact-file reads remain possible; directory scans go to the index.
  return { absolute, synced };
}

function safePathOperand(value, cwdInfo, kind) {
  if (!value || value.startsWith('-') || value.includes('\0') || /[*?{}[\]]/u.test(value)) return null;
  if (value === '~' || value.startsWith('~/') || value.startsWith('$') || path.isAbsolute(value)) return null;
  const pieces = value.replaceAll('\\', '/').split('/');
  if (pieces.some((piece) => piece === '..' || piece === '')) return null;
  const candidate = path.resolve(cwdInfo.absolute, value);
  const relative = path.relative(cwdInfo.absolute, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const workspace = cwdInfo.workspaceRoot?.absolute;
  if (workspace) {
    const workspaceRelative = path.relative(workspace, candidate);
    if (workspaceRelative !== '' && (workspaceRelative === '..' ||
        workspaceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(workspaceRelative))) return null;
  }
  let cursor = cwdInfo.absolute;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch { return null; }
    if (stat.isSymbolicLink()) return null;
    if (component !== relative.split(path.sep).at(-1) && !stat.isDirectory()) return null;
    if (component === relative.split(path.sep).at(-1)) {
      if (kind === 'file' && !stat.isFile()) return null;
      if (kind === 'directory' && !stat.isDirectory()) return null;
    }
  }
  if (kind === 'directory' && relative === '') return cwdInfo;
  if (kind === 'file' && relative === '') return null;
  return { absolute: candidate, relative, synced: isSyncedStorage(candidate) };
}

function numericOption(args, names) {
  const values = numericOptions(args, names);
  return values.length ? values.at(-1) : null;
}

function numericOptions(args, names) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    for (const name of names) {
      if (token === name && args[index + 1] !== undefined) {
        values.push(Number(args[index + 1]));
        index += 1;
        break;
      }
      if (name.endsWith('=')) {
        if (token.startsWith(name)) { values.push(Number(token.slice(name.length))); break; }
      } else if (token.startsWith(`${name}=`)) { values.push(Number(token.slice(name.length + 1))); break; }
    }
  }
  return values;
}

function hasDuplicateNumericOption(args, names) {
  return numericOptions(args, names).length > 1;
}

function boundedNumericOption(args, names, maximum, minimum = 0) {
  if (hasDuplicateNumericOption(args, names)) return null;
  const values = numericOptions(args, names);
  if (values.length !== 1) return null;
  const value = values[0];
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function hasFlag(args, names) {
  return args.some((token) => names.includes(String(token)));
}

function nonOptionArgs(args, valueOptions = new Set()) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (valueOptions.has(token)) { index += 1; continue; }
    if (token.startsWith('--') || (token.startsWith('-') && token !== '-')) continue;
    result.push(token);
  }
  return result;
}

const SAFE_QUERY_FLAGS = new Set([
  '-n', '--line-number', '-H', '--with-filename', '-h', '--no-filename',
  '-i', '--ignore-case', '-w', '--word-regexp', '-F', '--fixed-strings',
  '-v', '--invert-match', '-l', '--files-with-matches', '--no-messages',
]);
const SAFE_QUERY_VALUE_OPTIONS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-C', '--context', '-A', '--after-context',
  '-B', '--before-context', '--max-columns',
]);
const DIRECT_READ_COMMANDS = new Set(['cat', 'head', 'tail']);
const FILE_ACCESS_OPTIONS = Object.freeze({
  jq: new Set(['-f', '--from-file', '--slurpfile', '--rawfile', '--argfile', '--library-path']),
  sed: new Set(['-f', '--file']), awk: new Set(['-f', '--file']), gawk: new Set(['-f', '--file']),
  mawk: new Set(['-f', '--file']), nawk: new Set(['-f', '--file']),
});

function unsafeFileAccessMentioned(executable, args) {
  const options = FILE_ACCESS_OPTIONS[executable];
  if (options) {
    for (const token of args.map(String)) {
      const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (options.has(name) || options.has(token)) return true;
    }
  }
  if (['curl', 'wget', 'fetch'].includes(executable)) {
    return args.some((token) => {
      const value = String(token);
      // Curl/wget/fetch have many file-bearing aliases (cookies, CA/key
      // material, netrc/config, upload/data, input-file, and file:// URLs).
      // Check both `--option=value` and compact short forms before the broad
      // safe-argument set sees the token as ordinary text.  This is
      // intentionally conservative: a direct network transfer must use an
      // explicit reviewed broker route when a pathname is involved.
      const localPath = /(?:^|[=@])(?:\/|\.\.?[\\/])/u.test(value) ||
        /^file:/iu.test(value) || /^\\\\/u.test(value);
      const fileOption = /^(?:--(?:config|ca-certificate|capath|certificate|cert|crlfile|egd-file|private-key|proxy-cacert|proxy-capath|netrc-file|upload-file|data(?:-ascii|-binary|-raw|-urlencode)?|form(?:-string)?|input-file|post-file|load-cookies|save-cookies|url|cookie|output|referer)|-[KkIiTtubBEecOo])(?:=|$)/u.test(value);
      const compactFile = /^-[A-Za-z]*[dDFTKkIiubBE](?:=)?@?(?:\/|\.\.?[\\/])/u.test(value);
      return localPath || fileOption || compactFile;
    });
  }
  return false;
}

function safeExactQueryOptions(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (token === '--') return false;
    if (!token.startsWith('-') || token === '-') continue;
    if (token.includes('=')) {
      const name = token.slice(0, token.indexOf('='));
      if (!SAFE_QUERY_VALUE_OPTIONS.has(name)) return false;
      if (token.slice(token.indexOf('=') + 1) === '') return false;
      continue;
    }
    if (SAFE_QUERY_FLAGS.has(token)) continue;
    if (SAFE_QUERY_VALUE_OPTIONS.has(token)) {
      if (args[index + 1] === undefined || String(args[index + 1]).startsWith('-')) return false;
      index += 1;
      continue;
    }
    // Unknown long options and compact/clustered short options are rejected
    // rather than guessed (e.g. --pre, --threads, -m100000).
    return false;
  }
  return true;
}

function exactFileQuery(executable, args, cwdInfo) {
  if (!['rg', 'grep'].includes(executable)) return false;
  if (!safeExactQueryOptions(args)) return false;
  const maxCount = boundedNumericOption(args, ['-m', '--max-count'], MAX_RESULTS);
  const contextValues = numericOptions(args, ['-C', '--context', '-A', '--after-context', '-B', '--before-context']);
  const columns = boundedNumericOption(args, ['--max-columns'], MAX_DIRECT_COLUMNS);
  if (maxCount === null) return false;
  if (contextValues.length > 1 || contextValues.some((value) =>
    !Number.isInteger(value) || value < 0 || value > MAX_DIRECT_CONTEXT)) return false;
  if (columns === null && numericOptions(args, ['--max-columns']).length) return false;
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    let patternFile = null;
    if (token === '-f' || token === '--file') patternFile = args[++index];
    else if (token.startsWith('-f=') || token.startsWith('--file=')) patternFile = token.slice(token.indexOf('=') + 1);
    if (patternFile === null) continue;
    const file = safePathOperand(String(patternFile || ''), cwdInfo, 'file');
    if (!file || file.synced) return false;
    try { if (fs.statSync(file.absolute).size > MAX_DIRECT_FILE_BYTES) return false; }
    catch { return false; }
  }
  // A file operand must be explicit and real.  The first positional token is
  // the pattern for both rg and grep; subsequent positional tokens are files.
  const positional = nonOptionArgs(args, new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-C', '--context', '-A', '--after-context', '-B', '--before-context']));
  if (positional.length < 2) return false;
  const files = positional.slice(1);
  const file = files.length === 1 ? safePathOperand(files[0], cwdInfo, 'file') : null;
  if (!file) return false;
  try { return fs.statSync(file.absolute).size <= MAX_DIRECT_FILE_BYTES; }
  catch { return false; }
}

function exactReadQuery(executable, args, cwdInfo) {
  if (!DIRECT_READ_COMMANDS.has(executable) || !cwdInfo) return false;
  const positional = [];
  let lineLimit = null;
  let byteLimit = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (token === '--') {
      positional.push(...args.slice(index + 1).map(String));
      break;
    }
    if (executable === 'cat') {
      // `cat` has a large option surface (including arbitrary numbered file
      // descriptors); accept only an optional `--` and one explicit file.
      if (token.startsWith('-')) return false;
      positional.push(token);
      continue;
    }
    if (token === '-n' || token === '--lines') {
      if (lineLimit !== null || args[index + 1] === undefined || !/^\d+$/u.test(String(args[++index]))) return false;
      lineLimit = Number(args[index]);
      continue;
    }
    if (token.startsWith('--lines=')) {
      if (lineLimit !== null || !/^\d+$/u.test(token.slice(8))) return false;
      lineLimit = Number(token.slice(8));
      continue;
    }
    if (token === '-c' || token === '--bytes') {
      if (byteLimit !== null || args[index + 1] === undefined || !/^\d+$/u.test(String(args[++index]))) return false;
      byteLimit = Number(args[index]);
      continue;
    }
    if (token.startsWith('--bytes=')) {
      if (byteLimit !== null || !/^\d+$/u.test(token.slice(8))) return false;
      byteLimit = Number(token.slice(8));
      continue;
    }
    if (token.startsWith('-')) return false;
    positional.push(token);
  }
  if (positional.length !== 1) return false;
  if (executable !== 'cat' && lineLimit === null && byteLimit === null) lineLimit = 10;
  if (lineLimit !== null && (!Number.isInteger(lineLimit) || lineLimit < 1 || lineLimit > MAX_RESULTS)) return false;
  if (byteLimit !== null && (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > MAX_DIRECT_FILE_BYTES)) return false;
  const file = safePathOperand(String(positional[0]), cwdInfo, 'file');
  if (!file || file.synced) return false;
  try { return fs.statSync(file.absolute).size <= MAX_DIRECT_FILE_BYTES; }
  catch { return false; }
}

function stdinFilter(executable, args, preceding) {
  if (!['rg', 'grep'].includes(executable)) return false;
  // A standalone `rg PATTERN`/`grep PATTERN` opens the current directory when
  // the caller leaves stdin unused.  It is not a bounded stdin query merely
  // because `-m` is present.  Only an actual, parser-validated pipe supplies
  // the provenance required for this form; broker argv has no pipe provenance
  // and must name an exact file or an explicit directory grammar instead.
  if (!['|', '|&'].includes(preceding)) return false;
  if (!safeExactQueryOptions(args)) return false;
  const maxCount = boundedNumericOption(args, ['-m', '--max-count'], MAX_RESULTS);
  if (maxCount === null) return false;
  const contextValues = numericOptions(args, ['-C', '--context', '-A', '--after-context', '-B', '--before-context']);
  if (contextValues.length > 1 || contextValues.some((value) =>
    !Number.isInteger(value) || value < 0 || value > MAX_DIRECT_CONTEXT)) return false;
  // A pipeline producer is checked separately; requiring an explicit result
  // cap prevents a large stdin stream from flooding the host output.
  if (maxCount === null) return false;
  const columns = numericOptions(args, ['--max-columns']);
  if (columns.length > 1 || columns.some((value) => !Number.isInteger(value) || value < 1 || value > MAX_DIRECT_COLUMNS)) return false;
  const positional = nonOptionArgs(args, new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-C', '--context', '-A', '--after-context', '-B', '--before-context']));
  // One pattern and no path means the command consumes the already bounded
  // stream on stdin rather than opening a directory itself.
  return positional.length === 1;
}

function safePipeProducer(segment, cwdInfo) {
  if (!segment?.tokens?.length) return false;
  const { index, wrapped } = unwrap(segment.tokens);
  // A PATH-resolved `cat`, `head`, or wrapper can be replaced by an agent
  // controlled executable.  Exact-file rg/grep is the safe alternative; the
  // pipe producer is intentionally restricted to short shell literals.
  if (wrapped || index !== 0) return false;
  const executable = commandName(segment.tokens[index]);
  if (!['printf', 'echo', 'true', 'false'].includes(executable)) return false;
  const raw = String(segment.tokens[index] || '');
  if (raw.includes('/') || raw.includes('\\')) return false;
  const args = segment.tokens.slice(index + 1);
  if (args.length > MAX_PIPE_ARGUMENTS || args.some((value) =>
    VARIABLE_RE.test(String(value)) || SUBSTITUTION_RE.test(String(value)) || String(value).includes('\0'))) return false;
  if (executable === 'true' || executable === 'false') return args.length === 0;
  const totalBytes = args.reduce((sum, value) => sum + Buffer.byteLength(String(value)), 0);
  if (totalBytes > MAX_PIPE_LITERAL_BYTES) return false;
  if (executable === 'echo' && args.some((value) => ['-e', '--enable-escape'].includes(String(value)))) return false;
  if (executable === 'printf') {
    // Permit ordinary `%s`/`%b`/`%c`/`%%` formats, but reject dynamic or
    // giant width/precision directives that can manufacture an unbounded
    // stdin stream without a large-looking argument.
    for (const value of args) {
      const text = String(value);
      if (/%[*]/u.test(text)) return false;
      for (const match of text.matchAll(/%(?:[-+ #0]*)(\d+)(?:\.\d+)?[a-z%]/giu)) {
        if (Number(match[1]) > MAX_PIPE_LITERAL_BYTES) return false;
      }
      for (const match of text.matchAll(/%(?:[-+ #0]*)(?:\d+)?(?:\.\d+)?([a-z%])/giu)) {
        if (!['b', 'c', 's', '%'].includes(String(match[1]).toLowerCase())) return false;
      }
    }
  }
  return true;
}

function safePipeConsumer(segment) {
  if (!segment?.tokens?.length) return false;
  const { index, wrapped, executable } = segmentInfo(segment.tokens);
  if (wrapped || index !== 0) return false;
  const args = segment.tokens.slice(index + 1).map(String);
  if (['rg', 'grep'].includes(executable)) return stdinFilter(executable, args, '|');
  // A tiny output truncator is safe after the producer's 64 KiB literal cap;
  // every other consumer (shell, interpreter, launcher, script runner, or
  // unknown command) can execute arbitrary stdin and is rejected.
  if (!['head', 'tail'].includes(executable)) return false;
  let lines = null;
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    const token = args[cursor];
    if (token === '-n' || token === '--lines') {
      if (lines !== null || args[cursor + 1] === undefined || !/^\d+$/u.test(args[cursor + 1])) return false;
      lines = Number(args[++cursor]);
    } else if (/^(?:-n|--lines)=\d+$/u.test(token)) {
      if (lines !== null) return false;
      lines = Number(token.slice(token.indexOf('=') + 1));
    } else return false;
  }
  return Number.isInteger(lines) && lines >= 1 && lines <= MAX_RESULTS;
}

function isRecursiveFlag(token) {
  return token === '-r' || token === '-R' || token === '--recursive' || token === '--hidden' ||
    token === '--follow' || token === '--no-ignore' || token === '--no-ignore-vcs' ||
    token === '--unrestricted' ||
    /^-u{2,4}$/u.test(token);
}

function isDynamicToken(token) {
  const value = String(token || '');
  return VARIABLE_RE.test(value) || SUBSTITUTION_RE.test(value) || value.startsWith('~') || /[*?{}[\]]/u.test(value);
}

function leadingAssignment(token) {
  const match = String(token || '').match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
  return match ? match[1] : null;
}

function dangerousAssignment(tokens) {
  return tokens.some((token) => {
    const name = leadingAssignment(token);
    return name && DANGEROUS_ENV_NAMES.test(name);
  });
}

function dangerousInheritedGitEnvironment() {
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !DANGEROUS_INHERITED_GIT_ENV.test(name)) continue;
    // `cat` is the normal non-interactive pager used by this workflow. Plain
    // pager names do not dispatch another process; shell syntax, paths, and
    // every external-diff/transport indirection remain fail-closed.
    if ((name === 'PAGER' || name === 'GIT_PAGER') && /^(?:cat|less|more|most|true|:)$/u.test(value.trim())) continue;
    return name;
  }
  for (const name of ['PAGER', 'GIT_PAGER']) {
    const value = process.env[name];
    if (value && !/^(?:cat|less|more|most|true|:)$/u.test(value.trim())) return name;
  }
  return null;
}

function segmentInfo(tokens) {
  const unwrapped = unwrap(tokens);
  const raw = String(tokens[unwrapped.index] || '');
  return { ...unwrapped, raw, executable: commandName(raw) };
}

function codeTraversalMentioned(text) {
  const value = String(text || '');
  return /\bos\s*\.\s*(?:walk|listdir|scandir)|\bpathlib\s*\.\s*Path\s*\([^)]*\)\s*\.\s*(?:rglob|glob)|\b(?:fs|fss?)\s*\.\s*(?:readdir|readdirSync|opendir|opendirSync|glob|globSync)|\bDirectory\s*\.\s*(?:GetFiles|EnumerateFiles)|\b(?:Get-ChildItem|gci)\b/iu.test(value) ||
    /\b(?:rglob|glob\.iglob|walkdir|readdir|opendir)\s*\(/iu.test(value);
}

function scriptPathToken(token) {
  const value = String(token || '');
  return (value.includes('/') || value.includes('\\')) &&
    (SCRIPT_EXTENSIONS_RE.test(value) || value.startsWith('./') || value.startsWith('../'));
}

function pathBearingToken(token) {
  const value = String(token || '');
  return value === '.' || value === '..' || path.isAbsolute(value) ||
    value.startsWith('./') || value.startsWith('../') || value.includes('/') ||
    value.includes('\\') || /[*?{}[\]]/u.test(value);
}

function interpreterInvocation(executable, args) {
  if (!INTERPRETERS.has(executable)) return false;
  // Version/help probes do not execute user code. Every other interpreter
  // form is opaque to a lexical hook and must go through the guarded broker.
  if (args.length && args.every((token) => ['--version', '-V', '--help', '-h'].includes(String(token)))) return false;
  return true;
}

function scriptRunnerScan(executable, args) {
  if (!SCAN_TASK_RUNNERS.has(executable)) return false;
  return args.some((token) => /^(?:scan|search|walk|glob|index|find|grep|ls-files|ls-tree)$/iu.test(String(token))) ||
    args.some((token) => SCAN_INTENT_RE.test(String(token)));
}

function shellStateMutation(tokens) {
  const rawText = tokens.map(String).join(' ');
  const stateCouldHideScan = SCAN_INTENT_RE.test(rawText) ||
    /\b(?:rg|grep|find|fd|fdfind|tree|du|ls|eza|lsd|locate|updatedb|ctags|codegraph)\b/iu.test(rawText) ||
    codeTraversalMentioned(rawText);
  if (commandName(tokens[0]) === 'command') {
    return stateCouldHideScan;
  }
  const { index, executable } = segmentInfo(tokens);
  if (!executable) return false;
  if (SHELL_STATE_COMMANDS.has(executable)) {
    // `shopt` changes globstar/brace expansion and `compgen` enumerates the
    // resulting filesystem names. Neither can be treated as a harmless shell
    // state probe when the host gate is the only pre-execution control.
    return executable === 'shopt' || executable === 'compgen' || stateCouldHideScan;
  }
  const rest = tokens.slice(index + 1).map(String);
  // POSIX and zsh function declarations are tokenized around parentheses.
  if (rest.some((token) => /^function$/iu.test(token) || /^\w+\(\)$/u.test(token))) return stateCouldHideScan;
  if (tokens.some((token) => /^\w+\(\)$/u.test(String(token)))) return stateCouldHideScan;
  return false;
}

function potentialScanSegment(tokens) {
  const { index, executable } = segmentInfo(tokens);
  if (!executable) return false;
  if (SCAN_BINARIES.has(executable)) return true;
  if (executable === 'git') return Boolean(gitUnsafe(tokens));
  if (scriptRunnerScan(executable, tokens.slice(index + 1))) return true;
  const args = tokens.slice(index + 1).map(String);
  return SCAN_INTENT_RE.test(args.join(' '));
}

function gitInvocation(tokens) {
  const { index } = segmentInfo(tokens);
  if (commandName(tokens[index]) !== 'git') return null;
  let cursor = index + 1;
  let configOption = false;
  while (cursor < tokens.length) {
    const token = String(tokens[cursor]);
    if (token === '--') { cursor += 1; break; }
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(token)) {
      configOption = true; cursor += 2; continue;
    }
    if (token.startsWith('-C') || token.startsWith('-c') || token.startsWith('--git-dir=') ||
        token.startsWith('--work-tree=') || token.startsWith('--namespace=') || token.startsWith('--config-env=')) {
      configOption = true; cursor += 1; continue;
    }
    if (token.startsWith('-')) { cursor += 1; continue; }
    return { subcommand: token.toLowerCase(), configOption };
  }
  return { subcommand: null, configOption };
}

function commandMentionsScan(tokens) {
  const info = segmentInfo(tokens);
  if (!info.executable) return false;
  if (SCAN_BINARIES.has(info.executable)) return true;
  if (info.executable === 'git') return Boolean(gitScan(tokens.slice(info.index)));
  if (SHELLS.has(info.executable)) {
    const shell = shellInner(tokens, info.index);
    return Boolean(shell?.script && (commandMentionsScan(tokenize(shell.script).tokens) || codeTraversalMentioned(shell.script)));
  }
  if (INTERPRETERS.has(info.executable)) return codeTraversalMentioned(tokens.slice(info.index + 1).join(' '));
  return false;
}

function findRoot(args, cwdInfo) {
  // PAC accepts the conventional `find ROOT ...` form only. Requiring ROOT
  // first avoids guessing whether a later bare token is a predicate value.
  const rootValue = args[0] === '--' ? args[1] : args[0];
  if (!rootValue || rootValue.startsWith('-')) return null;
  return safePathOperand(rootValue, cwdInfo, 'directory');
}

function findDirectoryQuery(args, cwdInfo) {
  // `find` has no portable result-count or byte limit. Its direct shell form
  // is therefore intentionally not accepted by the host hook; this parser is
  // used only for the trusted resource-guard route, which supplies those
  // caps. Keep the grammar strict so a second root cannot hide after a
  // predicate value.
  let index = 0;
  if (args[index] === '--') index += 1;
  const rootValue = args[index];
  const root = findRoot(args.slice(index), cwdInfo);
  if (!root) return null;
  index += 1;
  let depth = null;
  let minDepthSeen = false;
  const valuePredicates = new Set(['-type', '-name', '-iname', '-path', '-ipath']);
  const flagPredicates = new Set(['-print', '-print0', '-xdev', '-mount', '-depth', '-prune']);
  const rejectTokens = new Set([
    '-L', '-H', '-P', '-exec', '-execdir', '-delete', '-ok', '-okdir', '-printf', '-fprintf', '-ls',
    '-o', '-or', '-a', '-and', '!', '(', ')', ',', '-D', '-O', '-ignore_readdir_race',
  ]);
  while (index < args.length) {
    const token = String(args[index]);
    if (rejectTokens.has(token)) return null;
    if (token === '-maxdepth' || token === '--max-depth' || token.startsWith('-maxdepth=') || token.startsWith('--max-depth=')) {
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(String(value))) return null;
      if (!token.includes('=')) index += 1;
      if (depth !== null) return null;
      depth = Number(value);
      index += 1;
      continue;
    }
    if (token === '-mindepth' || token === '--min-depth' || token.startsWith('-mindepth=')) {
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[index + 1];
      if (minDepthSeen || value === undefined || !/^[0-9]+$/u.test(String(value)) || Number(value) > MAX_DEPTH) return null;
      minDepthSeen = true;
      if (!token.includes('=')) index += 1;
      index += 1;
      continue;
    }
    if (valuePredicates.has(token)) {
      const value = args[index + 1];
      if (value === undefined || String(value).startsWith('-') || String(value).includes('\0')) return null;
      // Name patterns are data, but path predicates must not introduce a
      // second absolute/parent root.
      if (['-path', '-ipath'].includes(token) &&
          (path.isAbsolute(String(value)) || String(value).replaceAll('\\', '/').split('/').includes('..'))) return null;
      index += 2;
      continue;
    }
    if (flagPredicates.has(token)) { index += 1; continue; }
    // Any remaining bare token is a second root or an unknown action.
    return null;
  }
  if (depth === null || !Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) return null;
  return { root, depth };
}

function strictDirectoryOptions(executable, args) {
  // Directory scanners have many “convenience” switches that execute a
  // helper, follow links, sort by metadata, or spawn worker threads.  The
  // broker accepts a deliberately tiny read-only grammar and rejects every
  // option not listed here instead of trying to infer its effect.
  const spec = {
    rg: {
      flags: new Set(['--files', '--files-with-matches', '--files-without-match',
        '--no-messages', '--line-number', '-n', '--with-filename', '-H', '-h',
        '--no-filename', '-i', '--ignore-case', '-w', '--word-regexp', '-F',
        '--fixed-strings', '-v', '--invert-match', '--glob-case-insensitive', '--json']),
      values: new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count',
        '--max-columns', '-C', '--context', '-A', '--after-context', '-B',
        '--before-context', '--glob', '-g', '--type', '-t', '--max-depth']),
      repeatable: new Set(['-e', '--regexp', '--glob', '-g', '--type', '-t']),
    },
    fd: {
      flags: new Set(['--absolute-path', '--full-path', '--case-sensitive', '--ignore-case',
        '--hidden', '--no-ignore', '--no-ignore-vcs', '--print0']),
      values: new Set(['-e', '--extension', '-E', '--exclude', '-t', '--type', '-d',
        '--depth', '--max-depth', '--max-results']),
      repeatable: new Set(['-e', '--extension', '-E', '--exclude', '-t', '--type']),
    },
    tree: {
      flags: new Set(['--noreport', '--dirsfirst']),
      values: new Set(['-L', '--level']),
      repeatable: new Set(),
    },
    ls: {
      flags: new Set(['-d', '--directory', '-1', '-l', '--classify', '-F',
        '--color=never', '--color=auto', '--color=always']),
      values: new Set(), repeatable: new Set(),
    },
  }[executable];
  if (!spec) return false;
  const seen = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (token === '--') return false;
    if (!token.startsWith('-') || token === '-') continue;
    const equal = token.indexOf('=');
    const name = equal >= 0 ? token.slice(0, equal) : token;
    if (spec.flags.has(token)) continue;
    if (!spec.values.has(name)) return false;
    const value = equal >= 0 ? token.slice(equal + 1) : args[index + 1];
    if (value === undefined || String(value).startsWith('-') || String(value).includes('\0')) return false;
    const count = seen.get(name) || 0;
    if (count && !spec.repeatable.has(name)) return false;
    seen.set(name, count + 1);
    if (equal < 0) index += 1;
  }
  return true;
}

function rgDirectoryQuery(args, cwdInfo) {
  if (cwdInfo.synced || args.some((token) => isRecursiveFlag(String(token)) || String(token).includes('\\0')) ||
      !strictDirectoryOptions('rg', args)) return null;
  const depth = numericOption(args, ['--max-depth']);
  if (depth === null || !Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH ||
      hasDuplicateNumericOption(args, ['--max-depth'])) return null;
  const valueOptions = new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '--max-columns',
    '-C', '--context', '-A', '-B', '--glob', '-g', '--glob-case-insensitive', '--type', '-t',
    '--max-depth']);
  const positional = nonOptionArgs(args, valueOptions);
  const filesMode = hasFlag(args, ['--files', '--files-with-matches', '--files-without-match']);
  // File enumeration has no native result-count bound in rg. Keep it on the
  // persistent locator/index path rather than claiming that a byte cap makes
  // a potentially huge directory walk small.
  if (filesMode) return null;
  const roots = filesMode ? positional : positional.slice(1);
  const maxCount = numericOption(args, ['--max-count']);
  if (hasDuplicateNumericOption(args, ['--max-count']) ||
      (maxCount !== null && (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > MAX_RESULTS))) return null;
  if (!filesMode && maxCount === null) return null;
  const maxColumns = numericOption(args, ['--max-columns']);
  if (hasDuplicateNumericOption(args, ['--max-columns']) ||
      (maxColumns !== null && (!Number.isInteger(maxColumns) || maxColumns < 1 || maxColumns > MAX_DIRECT_COLUMNS))) return null;
  const contexts = numericOptions(args, ['-C', '--context', '-A', '--after-context', '-B', '--before-context']);
  if (contexts.length > 1 || contexts.some((value) => !Number.isInteger(value) || value < 0 || value > MAX_DIRECT_CONTEXT)) return null;
  // Pattern files are data inputs, but they must remain inside the same
  // authenticated workspace and may not be supplied repeatedly.
  for (let index = 0; index < args.length; index += 1) {
    if (['-f', '--file'].includes(String(args[index]))) {
      const value = args[index + 1];
      if (!safePathOperand(String(value || ''), cwdInfo, 'file')) return null;
      index += 1;
    }
  }
  if (roots.length !== 1) return null;
  const root = safePathOperand(roots[0], cwdInfo, 'directory');
  return root && !root.synced ? { root, depth } : null;
}

function boundedDirectoryQuery(executable, args, cwdInfo) {
  if (cwdInfo.synced) return null;
  if (args.some((token) => isRecursiveFlag(String(token)))) return null;
  if (executable !== 'find' && !strictDirectoryOptions(
    ['fdfind'].includes(executable) ? 'fd' : (['eza', 'lsd'].includes(executable) ? 'ls' : executable), args)) return null;
  const depth = numericOption(args, ['-maxdepth', '--max-depth', '--max-depth=', '-d', '--depth', '-L', '--level']);
  if (executable === 'find') {
    const parsed = findDirectoryQuery(args, cwdInfo);
    return parsed && !parsed.root.synced ? parsed : null;
  }
  if (executable === 'fd' || executable === 'fdfind') {
    if (depth === null || !Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) return null;
    if (hasDuplicateNumericOption(args, ['-d', '--depth', '--max-depth'])) return null;
    const maxResults = numericOption(args, ['--max-results']);
    if (hasDuplicateNumericOption(args, ['--max-results']) ||
        maxResults === null || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) return null;
    const roots = nonOptionArgs(args, new Set(['-e', '--extension', '-E', '--exclude', '-t', '--type',
      '-d', '--depth', '--max-depth', '--max-results']));
    // fd's first positional is the pattern, the optional second is root.
    const rootValue = roots.length > 1 ? roots.at(-1) : '.';
    const root = safePathOperand(rootValue, cwdInfo, 'directory');
    return root && !root.synced ? { root, depth } : null;
  }
  if (executable === 'tree') {
    if (depth === null || !Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) return null;
    if (hasDuplicateNumericOption(args, ['-L', '--level'])) return null;
    const roots = nonOptionArgs(args, new Set(['-L', '--level']));
    if (roots.length > MAX_ROOTS) return null;
    const root = safePathOperand(roots[0] || '.', cwdInfo, 'directory');
    return root && !root.synced ? { root, depth } : null;
  }
  if (executable === 'ls' || executable === 'eza' || executable === 'lsd') {
    // Directory listings have no portable output cap.  Permit metadata-only
    // `-d`/`--directory` and exact files; directory enumeration goes through
    // the index or resource-guard.
    if (!hasFlag(args, ['-d', '--directory'])) return null;
    const roots = nonOptionArgs(args, new Set());
    if (roots.length > 1) return null;
    const root = safePathOperand(roots[0] || '.', cwdInfo, 'directory');
    return root && !root.synced ? { root, depth: 0 } : null;
  }
  return null;
}

function routeAllow() { return { allow: true }; }
function routeBlock(reason) { return { blocked: true, reason }; }

function optionOccurrences(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (token === name) {
      values.push(args[index + 1]); index += 1;
    } else if (token.startsWith(`${name}=`)) values.push(token.slice(name.length + 1));
  }
  return values;
}

function trustedRuntimePath(options) {
  return path.resolve(options.runtimePath || path.join(
    options.home || process.env.HOME || process.cwd(), '.agent-work/runtime/pac',
  ));
}

function secureFileDigest(file) {
  try { return digest(fs.readFileSync(file)); } catch { return null; }
}

function trustedFileMatches(targetPath, options, base) {
  const expected = options.trustedDigests?.[base];
  // An omitted digest is not a trust assertion. Generated PAC hook entries
  // always carry a content pin; accepting a missing pin would let a stale or
  // hand-written command promote any same-named script into the broker.
  return typeof expected === 'string' && /^[0-9a-f]{64}$/u.test(expected) &&
    secureFileDigest(targetPath) === expected;
}

function trustedHelperTarget(tokens, options, expectedBase) {
  const { index, wrapped } = unwrap(tokens);
  if (wrapped) return false;
  const launcher = commandName(tokens[index]);
  if (!['node', 'nodejs', 'bun', 'deno'].includes(launcher)) return false;
  const target = tokens[index + 1];
  if (!target) return false;
  const resolved = path.resolve(String(target));
  if (commandName(target) !== expectedBase ||
      !(options.trustedExecutables || []).some((candidate) => path.resolve(candidate) === resolved)) return false;
  if (!options.trustedLauncher || path.resolve(String(tokens[index])) !== path.resolve(options.trustedLauncher)) return false;
  if (!options.trustedLauncherDigest || secureFileDigest(path.resolve(options.trustedLauncher)) !== options.trustedLauncherDigest) return false;
  try {
    const root = path.parse(resolved).root;
    let cursor = root;
    for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return false;
    }
    const stat = fs.lstatSync(resolved);
    return stat.isFile() && !stat.isSymbolicLink() && !isSyncedStorage(resolved) &&
      trustedFileMatches(resolved, options, expectedBase);
  } catch { return false; }
}

function parseLocatorRoute(args, options, cwd) {
  const expectedRegistry = path.resolve(options.registryPath || defaultRegistryPath(options.home));
  const expectedRuntime = trustedRuntimePath(options);
  const allowedFlags = new Set(['--json', '--force']);
  const allowedValues = new Set(['--registry', '--registry-sha256', '--runtime', '--mode', '--limit', '--max-files', '--max-ms', '--max-read-bytes']);
  const positional = [];
  const seen = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const equal = token.indexOf('=');
    const name = equal >= 0 ? token.slice(0, equal) : token;
    if (allowedFlags.has(name)) {
      if (equal >= 0 || seen.has(name)) return routeBlock(`locator flag ${name} is duplicated or has an inline value`);
      seen.set(name, (seen.get(name) || 0) + 1);
      continue;
    }
    if (!allowedValues.has(name)) return routeBlock(`locator option ${name} is not PAC-approved`);
    const value = equal >= 0 ? token.slice(equal + 1) : args[++index];
    if (value === undefined || String(value).startsWith('-') || seen.has(name)) {
      return routeBlock(`locator option ${name} is missing or duplicated`);
    }
    seen.set(name, String(value));
  }
  if (seen.get('--registry') !== expectedRegistry || seen.get('--runtime') !== expectedRuntime) {
    return routeBlock('locator must use the PAC-bound local registry and runtime');
  }
  if (!options.registrySha256 || seen.get('--registry-sha256') !== options.registrySha256) {
    return routeBlock('locator must bind the PAC registry digest explicitly');
  }
  if (!positional.length) return routeBlock('locator action is missing');
  const action = positional[0];
  if (action === 'search') {
    if (seen.has('--force') || ['--max-files', '--max-ms', '--max-read-bytes'].some((name) => seen.has(name))) {
      return routeBlock('locator search may not carry index-refresh limits');
    }
    if (positional.length < 3 || positional.length > 3) return routeBlock('locator search requires exactly one root id and one query');
    const id = positional[1];
    const query = positional[2];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id) ||
        typeof query !== 'string' || query.length > MAX_LOCATOR_QUERY || query.includes('\0')) {
      return routeBlock('locator search id/query is outside the bounded grammar');
    }
    const loaded = registryRoots(options, options.home);
    // Searching an existing local index does not traverse the source.  It is
    // therefore valid for a clean OneDrive/WSL-drvfs root as well as a native
    // WSL root; only direct scans remain local-only.
    if (!loaded.roots?.some((root) => root.id === id)) return routeBlock('locator search root id is not registered');
    const mode = seen.get('--mode') || 'path';
    if (!['path', 'text', 'tree'].includes(mode) || (seen.has('--mode') && typeof mode !== 'string')) {
      return routeBlock('locator search mode is invalid');
    }
    if (seen.has('--limit')) {
      const limit = Number(seen.get('--limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOCATOR_RESULTS) return routeBlock('locator result limit is too large');
    }
    if (mode === 'tree' && (path.isAbsolute(query) || query.replaceAll('\\', '/').split('/').includes('..'))) {
      return routeBlock('locator tree prefix escapes the indexed root');
    }
    return routeAllow();
  }
  if (action === 'status' || action === 'recover') {
    if (!options._trustedScanRoute) return routeBlock(`locator ${action} must run through the PAC scan broker`);
    if (seen.has('--mode') || seen.has('--limit') ||
        ['--max-files', '--max-ms', '--max-read-bytes'].some((name) => seen.has(name))) {
      return routeBlock(`locator ${action} does not accept search or index-refresh options`);
    }
    if (action === 'status' && seen.has('--force')) return routeBlock('locator status does not accept --force');
    if (positional.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(positional[1])) {
      return routeBlock(`locator ${action} requires one registered root id`);
    }
    const loaded = registryRoots(options, options.home);
    const entry = loaded.roots?.find((root) => root.id === positional[1]);
    if (!entry || entry.absolute !== path.resolve(options._trustedScanRoot || cwd)) {
      return routeBlock(`locator ${action} id is not the authenticated registered scan root`);
    }
    return routeAllow();
  }
  if (action === 'index') {
    if (seen.has('--mode') || seen.has('--limit')) return routeBlock('locator index does not accept search options');
    // Refreshing an index is the one operation that can walk a source tree;
    // it is accepted only as the inner command of the fixed scan broker.
    if (!options._trustedScanRoute) return routeBlock('locator index must run through the PAC scan broker');
    if (positional.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(positional[1])) {
      return routeBlock('locator index requires one registered root id');
    }
    if (!options.registrySha256 || seen.get('--registry-sha256') !== options.registrySha256) {
      return routeBlock('locator index requires the PAC-bound registry digest');
    }
    for (const name of ['--max-files', '--max-ms', '--max-read-bytes']) {
      const value = Number(seen.get(name));
      if (!Number.isInteger(value) || value <= 0) return routeBlock(`locator index requires ${name}`);
    }
    if (Number(seen.get('--max-files')) > 50_000 || Number(seen.get('--max-ms')) > 30_000 ||
        Number(seen.get('--max-read-bytes')) > 256 * 1024 * 1024) {
      return routeBlock('locator index caps exceed the PAC scan ceiling');
    }
    const loaded = registryRoots(options, options.home);
    const entry = loaded.roots?.find((root) => root.id === positional[1]);
    if (!entry || entry.absolute !== path.resolve(options._trustedScanRoot || cwd)) {
      return routeBlock('locator index id is not the authenticated registered scan root');
    }
    const synced = Boolean(entry.synced);
    if (synced && (Number(seen.get('--max-files')) > 10_000 ||
        Number(seen.get('--max-ms')) > 15_000 || Number(seen.get('--max-read-bytes')) > 128 * 1024 * 1024)) {
      return routeBlock('OneDrive/Windows-backed locator index requires the tighter 10000-file/15s/128MiB caps');
    }
    return routeAllow();
  }
  return routeBlock(`locator action ${action} is not agent-readable`);
}

const BUILD_PATH_OPTIONS = new Set([
  '-C', '-f', '--file', '--manifest-path', '--path', '--project', '--project-file',
  '--prefix', '--target-dir', '--build-dir', '--out-dir', '--output-dir', '--output',
  '-o', '--directory', '--cwd', '--config', '--cache-dir', '--source-dir', '--work-dir',
]);
const BUILD_UNSAFE_OPTIONS = new Set([
  '--eval', '-E', '--execute', '--exec', '--include', '--include-dir', '--debug', '-d',
  '--trace', '--profile', '--preload', '--require', '--loader', '--config-env',
]);
const BUILD_JOB_OPTIONS = new Set([
  '-j', '--jobs', '--jobserver-auth', '--workers', '--parallel', '--max-workers',
  '--num-workers', '--local_cpu_resources', '--loading_phase_threads', '--maxcpucount',
]);
const GO_EXTERNAL_TOOL_OPTIONS = new Set([
  '-exec', '-toolexec', '-gcflags', '-asmflags', '-ldflags', '-gccgoflags',
  '-modfile', '-overlay', '-tags', '-toolchain',
]);
function attachedBuildJobValue(token) {
  const match = /^(?:-j|--jobs|--workers|--parallel|--max-workers|--num-workers|--local_cpu_resources|--loading_phase_threads|--maxcpucount)(?:=)?(\d+)$/u.exec(String(token));
  return match ? Number(match[1]) : null;
}
function boundedNumeric(value, label, { min = 1, max = 64 } = {}) {
  if (!/^\d+$/u.test(String(value ?? '')) || Number(value) < min || Number(value) > max) {
    return `${label} must be an integer between ${min} and ${max}`;
  }
  return null;
}
function optionValue(args, index, names) {
  const token = String(args[index]);
  for (const name of names) {
    if (token === name) return { name, value: args[index + 1] };
    if (token.startsWith(`${name}=`)) return { name, value: token.slice(name.length + 1) };
    if (token.startsWith(name) && token.length > name.length &&
        (name.startsWith('-') || name.startsWith('/'))) {
      const tail = token.slice(name.length);
      if (tail.startsWith(':')) return { name, value: tail.slice(1) };
      if (/^\d/u.test(tail)) return { name, value: tail };
    }
  }
  return null;
}
function specialParallelFinding(executable, args) {
  if (['mvn', 'mvnw'].includes(executable)) {
    for (let index = 0; index < args.length; index += 1) {
      const found = optionValue(args, index, ['-T', '--threads']);
      if (!found) continue;
      const match = /^(\d+(?:\.\d+)?)(C)?$/iu.exec(String(found.value ?? ''));
      if (!match || Number(match[1]) < 0.01 || Number(match[1]) > 64) {
        return 'Maven -T/--threads must be a numeric count or <=64C';
      }
    }
  }
  if (['msbuild', 'dotnet'].includes(executable)) {
    for (let index = 0; index < args.length; index += 1) {
      const found = optionValue(args, index, ['/m', '-m', '/maxcpucount', '--maxcpucount']);
      if (!found) continue;
      const error = boundedNumeric(found.value, `${executable} ${found.name}`);
      if (error) return error;
    }
  }
  if (['pytest', 'tox', 'mocha', 'jest', 'vitest'].includes(executable)) {
    for (let index = 0; index < args.length; index += 1) {
      const names = executable === 'pytest' ? ['-n', '--numprocesses']
        : executable === 'tox' ? ['-p', '--parallel']
          : ['-w', '--maxWorkers', '--max-workers'];
      const found = optionValue(args, index, names);
      if (!found) continue;
      const error = boundedNumeric(found.value, `${executable} ${found.name}`);
      if (error) return error;
    }
  }
  if (executable === 'go') {
    for (let index = 0; index < args.length; index += 1) {
      const count = optionValue(args, index, ['-count']);
      if (count) {
        const error = boundedNumeric(count.value, 'Go -count', { min: 0 });
        if (error) return error;
      }
      const parallel = optionValue(args, index, ['-parallel']);
      if (parallel) {
        const error = boundedNumeric(parallel.value, 'Go -parallel');
        if (error) return error;
      }
      const cpu = optionValue(args, index, ['-cpu']);
      if (cpu) {
        const values = String(cpu.value ?? '').split(',');
        if (values.length > 8 || values.some((value) => boundedNumeric(value, 'Go -cpu'))) {
          return 'Go -cpu must contain at most 8 numeric values between 1 and 64';
        }
      }
      for (const name of ['-fuzztime', '-benchtime', '-bench']) {
        if (String(args[index]) === name || String(args[index]).startsWith(`${name}=`)) {
          return `Go ${name} requires an explicitly reviewed experiment manifest`;
        }
      }
      const timeout = optionValue(args, index, ['-timeout']);
      if (timeout) {
        const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/iu.exec(String(timeout.value ?? ''));
        if (!match || Number(match[1]) * ({ ms: 0.001, s: 1, m: 60 }[match[2].toLowerCase()]) > 600) {
          return 'Go -timeout must be a duration no longer than 10 minutes';
        }
      }
    }
  }
  return null;
}

function brokerBuildOptionFinding(executable, args) {
  const special = specialParallelFinding(executable, args);
  if (special) return special;
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      return 'build argv environment assignments require a reviewed task manifest';
    }
    if (BUILD_UNSAFE_OPTIONS.has(name) || BUILD_UNSAFE_OPTIONS.has(token)) {
      return `build option ${name} can evaluate/include arbitrary code or unbounded diagnostics`;
    }
    const attachedJobs = attachedBuildJobValue(token);
    if (attachedJobs !== null) {
      if (attachedJobs < 1 || attachedJobs > 64) {
        return 'build parallelism option -j/--jobs must be an integer between 1 and 64';
      }
    } else if (/^(?:-j|--jobs|--workers|--parallel|--max-workers|--num-workers|--local_cpu_resources|--loading_phase_threads|--maxcpucount)(?:=)?/u.test(token) &&
      !BUILD_JOB_OPTIONS.has(token)) {
      return 'build parallelism option -j/--jobs must be an integer between 1 and 64';
    }
    if (BUILD_JOB_OPTIONS.has(name)) {
      const raw = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[index + 1];
      if (!token.includes('=')) index += 1;
      if (!/^\d+$/u.test(String(raw || '')) || Number(raw) < 1 || Number(raw) > 64) {
        return `build parallelism option ${name} must be an integer between 1 and 64`;
      }
    }
    if (executable === 'go') {
      const goName = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (GO_EXTERNAL_TOOL_OPTIONS.has(goName) || GO_EXTERNAL_TOOL_OPTIONS.has(token)) {
        return `Go option ${goName} can dispatch an external tool or alter the build graph`;
      }
      const attachedGoParallel = /^-p(?:=)?(\d+)$/u.exec(token);
      if (attachedGoParallel) {
        const value = Number(attachedGoParallel[1]);
        if (value < 1 || value > 64) return 'Go package parallelism -p must be an integer between 1 and 64';
      } else if (goName === '-p') {
        const raw = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[index + 1];
        if (!token.includes('=')) index += 1;
        if (!/^\d+$/u.test(String(raw || '')) || Number(raw) < 1 || Number(raw) > 64) {
          return 'Go package parallelism -p must be an integer between 1 and 64';
        }
      } else if (/^-p(?:=)?/u.test(token)) {
        return 'Go package parallelism -p must be an integer between 1 and 64';
      }
    }
    if (executable === 'go' && (token === '...' || /(?:^|[\\/])\.\.\.(?:$|[\\/])/u.test(token))) {
      return 'Go package wildcard ... is not a bounded project target';
    }
  }
  return null;
}

function safeBuildRouteOperand(value, cwdInfo) {
  const token = String(value || '');
  if (!token || token.includes('\0') || token.startsWith('~') || token.startsWith('$') || /[*?{}[\]]/u.test(token)) return null;
  const workspace = cwdInfo?.workspaceRoot?.absolute;
  if (!workspace) return null;
  const candidate = path.resolve(cwdInfo.absolute, token);
  const suffix = path.relative(workspace, candidate);
  if (suffix !== '' && (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) || isSyncedStorage(candidate)) return null;
  const parts = suffix.split(path.sep).filter(Boolean);
  let cursor = workspace;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) {
      if (cursor !== candidate) return null;
      break;
    }
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== process.getuid())) return null;
    if (cursor !== candidate && !stat.isDirectory()) return null;
  }
  return candidate;
}

function brokerBuildPathFinding(executable, args, cwdInfo) {
  if (!SCAN_TASK_RUNNERS.has(executable)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    const equal = token.indexOf('=');
    let name = equal >= 0 ? token.slice(0, equal) : token;
    let value = equal >= 0 ? token.slice(equal + 1) : undefined;
    if (equal < 0 && !BUILD_PATH_OPTIONS.has(name)) {
      const attached = ['-C', '-f', '-o'].find((option) => token.startsWith(option) && token.length > option.length);
      if (attached) {
        name = attached;
        value = token.slice(attached.length);
      }
    }
    if (BUILD_PATH_OPTIONS.has(name)) {
      if (value === undefined) value = args[++index];
      if (value === undefined || !safeBuildRouteOperand(value, cwdInfo)) {
        return `build path option ${name} must stay inside the registered project root`;
      }
      continue;
    }
    if (token === '.' || token === '..' || token.startsWith('./') || token.startsWith('../') ||
        path.isAbsolute(token) || token.includes('/') || token.includes('\\')) {
      if (!safeBuildRouteOperand(token, cwdInfo)) return 'build path arguments must stay inside the registered project root';
    }
  }
  return null;
}

function brokerWorkloadFinding(executable, args, profile, cwdInfo) {
  if (SCAN_TASK_RUNNERS.has(executable) && !['build', 'expensive'].includes(profile)) {
    return 'build/task workloads require the build or expensive resource profile';
  }
  const buildOptionFinding = brokerBuildOptionFinding(executable, args);
  if (buildOptionFinding) return buildOptionFinding;
  const buildPathFinding = brokerBuildPathFinding(executable, args, cwdInfo);
  if (buildPathFinding) return buildPathFinding;
  if (['gradlew', 'mvnw'].includes(executable)) {
    if (profile !== 'build') return `${executable} requires the build resource profile`;
    const launcher = safePathOperand(`./${executable}`, cwdInfo, 'file');
    if (!launcher) return `${executable} must be the private in-root wrapper ./` + executable;
  }
  if (executable === 'dotnet') {
    if (profile !== 'build') return 'dotnet workloads require the build resource profile';
    const action = args.find((token) => !String(token).startsWith('-'));
    if (!['build', 'test', 'restore'].includes(String(action || '').toLowerCase())) {
      return 'dotnet broker permits only build, test, or restore';
    }
  }
  if (executable === 'msbuild') {
    if (profile !== 'build') return 'msbuild requires the build resource profile';
    const project = args.find((token) => /\.(?:sln|csproj|fsproj|vbproj|proj)$/iu.test(String(token)));
    if (!project || !safePathOperand(String(project), cwdInfo, 'file')) {
      return 'msbuild must name one private in-root project file';
    }
  }
  if (['qjs', 'quickjs'].includes(executable)) {
    if (!['build', 'expensive'].includes(profile)) return `${executable} requires an expensive/build profile`;
    if (args.some((token) => OPAQUE_CODE_OPTIONS.has(String(token).split('=', 1)[0]))) {
      return `${executable} inline code is not accepted; name one in-root script file`;
    }
    const script = args.find((token) => SCRIPT_EXTENSIONS_RE.test(String(token)) || String(token).startsWith('./'));
    if (!script || !safePathOperand(String(script), cwdInfo, 'file')) return `${executable} must name one private in-root script`;
  }
  return null;
}

function parseResourceRoute(args, options, cwd) {
  const separator = args.indexOf('--');
  if (separator < 0 || args.slice(separator + 1).length === 0) return routeBlock('resource-guard requires an explicit command after --');
  const before = args.slice(0, separator);
  if (before.filter((token) => String(token) === 'run').length !== 1) return routeBlock('resource-guard route requires exactly one run action');
  const expectedRegistry = path.resolve(options.registryPath || defaultRegistryPath(options.home));
  const seen = new Map();
  // `--no-systemd` is intentionally not an agent-selectable option.  It
  // downgrades the only hard CPU/memory/I/O containment tier to the soft
  // fallback, so PAC-generated broker invocations must be the sole authority
  // that can choose that mode (and currently PAC never emits it).
  const allowedFlags = new Set(['run', '--json', '--allow-expensive', '--force']);
  const allowedValues = new Set(['--profile', '--cwd', '--root', '--registry', '--registry-sha256', '--lease-key']);
  for (let index = 0; index < before.length; index += 1) {
    const token = String(before[index]);
    if (allowedFlags.has(token)) {
      if (seen.has(token)) return routeBlock(`resource-guard option ${token} is duplicated`);
      seen.set(token, true); continue;
    }
    const equal = token.indexOf('=');
    const name = equal >= 0 ? token.slice(0, equal) : token;
    if (!allowedValues.has(name)) return routeBlock(`resource-guard option ${name} is not PAC-approved`);
    const value = equal >= 0 ? token.slice(equal + 1) : before[++index];
    if (value === undefined || String(value).startsWith('-') || seen.has(name)) return routeBlock(`resource-guard option ${name} is missing or duplicated`);
    seen.set(name, String(value));
  }
  const profile = seen.get('--profile');
  if (!['scan', 'cheap', 'bounded', 'expensive', 'build'].includes(profile)) {
    return routeBlock('resource-guard route requires an explicit approved profile');
  }
  const wrapperCwd = path.resolve(String(seen.get('--cwd') || ''));
  const wrapperRoot = path.resolve(String(seen.get('--root') || ''));
  const wrapperRegistry = path.resolve(String(seen.get('--registry') || ''));
  if (!seen.has('--cwd') || !seen.has('--root') || !seen.has('--registry') ||
      wrapperCwd !== path.resolve(cwd) || wrapperRegistry !== expectedRegistry) {
    return routeBlock('resource-guard must bind cwd, root, and the PAC registry explicitly');
  }
  if (!options.registrySha256 || seen.get('--registry-sha256') !== options.registrySha256) {
    return routeBlock('resource-guard must bind the PAC registry digest explicitly');
  }
  const loaded = options._registeredRootInfo || registryRoots(options, options.home);
  const rootEntry = loaded.roots?.find((entry) => entry.absolute === wrapperRoot);
  if (!rootEntry) return routeBlock('resource-guard root is not a local registered root');
  const suffix = path.relative(wrapperRoot, wrapperCwd);
  if (suffix !== '' && (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix))) {
    return routeBlock('resource-guard cwd escapes its registered root');
  }
  const wrapperCwdInfo = { absolute: wrapperCwd, workspaceRoot: rootEntry, synced: Boolean(rootEntry.synced) };
  const inner = args.slice(separator + 1).map((token) => quotePosix(token)).join(' ');
  const innerLexical = tokenize(inner);
  if (innerLexical.unsafeSyntax || innerLexical.unclosedQuote || SUBSTITUTION_RE.test(inner)) {
    return routeBlock('resource-guard broker does not accept shell substitution or malformed quoting');
  }
  if (innerLexical.tokens.some((token) => isDynamicToken(token))) {
    return routeBlock('resource-guard broker accepts literal argv only; glob/brace/tilde expansion is disabled');
  }
  const innerSegments = commandSegments(innerLexical.tokens);
  if (innerSegments.length !== 1) return routeBlock('resource-guard broker accepts one command segment only');
  const innerSegment = innerSegments[0];
  const innerInfo = segmentInfo(innerSegment.tokens);
  const innerHasKnownScan = commandMentionsScan(innerSegment.tokens);
  const innerIsLocator = trustedHelperTarget(innerSegment.tokens, options, 'locator.mjs');
  const innerHasPotentialScan = potentialScanSegment(innerSegment.tokens);
  if (rootEntry.synced && !innerIsLocator) {
    return routeBlock('OneDrive/Windows-backed roots may use only the bounded local locator index, not direct scans or workloads');
  }
  if (innerIsLocator && profile !== 'scan') {
    return routeBlock('workspace-locator index must use the scan profile');
  }
  if (profile === 'scan' && innerHasPotentialScan && !innerHasKnownScan && !innerIsLocator) {
    return routeBlock('resource-guard inner command has an unknown filesystem-scan implementation');
  }
  if (profile === 'scan' && !innerHasKnownScan && !innerIsLocator) {
    return routeBlock('scan profile is limited to the PAC bounded scanner/index grammar');
  }
  if (profile !== 'scan') {
    // Heavy work is allowed without a second interactive approval only after
    // it has crossed this exact broker. Keep the inner argv deliberately
    // boring: no shell/interpreter code strings, wrappers, scanner aliases,
    // or unknown launchers. The resource-guard process then owns the actual
    // profile/pressure/lease decision and receipt.
    const innerArgs = innerSegment.tokens.slice(innerInfo.index + 1).map(String);
    if (innerHasKnownScan || SCAN_BINARIES.has(innerInfo.executable) ||
        SHELLS.has(innerInfo.executable) || OPAQUE_LAUNCHERS.has(innerInfo.executable) ||
        HOST_CONTROL_COMMANDS.has(innerInfo.executable) ||
        innerInfo.wrapped || !GUARDED_WORKLOADS.has(innerInfo.executable)) {
      return routeBlock('non-scan resource work must use a known direct workload, not a shell/scan/unknown launcher');
    }
    if (innerArgs.some((token) => PARAM_EXPANSION_RE.test(token) || SHELL_OPERATORS.has(token) ||
        OPAQUE_CODE_OPTIONS.has(token.split('=', 1)[0]) ||
        (INTERPRETERS.has(innerInfo.executable) && OPAQUE_SCRIPT_OPTIONS.has(token.split('=', 1)[0])))) {
      return routeBlock('resource workload may not carry shell expansion or inline code options');
    }
    if (INTERPRETERS.has(innerInfo.executable)) {
      const script = innerArgs.find((token) => SCRIPT_EXTENSIONS_RE.test(token) || token.startsWith('./'));
      const file = script ? safePathOperand(script, wrapperCwdInfo, 'file') : null;
      let fileBytes = null;
      try { fileBytes = file ? fs.statSync(file.absolute).size : null; } catch { fileBytes = null; }
      if (!file || fileBytes === null || fileBytes > MAX_DIRECT_FILE_BYTES) {
        return routeBlock('interpreter workload must name one small in-root script file');
      }
    }
    const workloadFinding = brokerWorkloadFinding(innerInfo.executable, innerArgs, profile, wrapperCwdInfo);
    if (workloadFinding) return routeBlock(workloadFinding);
  }
  if (innerHasKnownScan && (!BROKER_SCAN_BINARIES.has(innerInfo.executable) ||
      !BROKER_SCAN_BINARIES.has(String(innerInfo.raw).toLowerCase()) ||
      innerInfo.raw.includes('/') || innerInfo.raw.includes('\\'))) {
    return routeBlock('resource-guard accepts only a bare fixed-PATH scanner');
  }
  if (innerSegment.tokens.some((token) => SHELL_OPERATORS.has(token))) {
    return routeBlock('scan broker does not accept composed shell syntax');
  }
  const nested = inspectCommand(inner, wrapperCwd, {
    ...options,
    allowDirectBoundedScans: true,
    allowGuardedOpaque: profile !== 'scan',
    _trustedScanRoute: true,
    _trustedScanRoot: wrapperRoot,
    _trustedRouteDepth: (options._trustedRouteDepth || 0) + 1,
  });
  return nested ? routeBlock(nested.reason || 'inner command failed the scan policy') : routeAllow();
}

function trustedRoute(tokens, options, cwd = process.cwd()) {
  const { index, wrapped } = unwrap(tokens);
  if (wrapped) return null;
  const trusted = new Set((options.trustedExecutables || []).filter(Boolean).map((value) => path.resolve(value)));
  let executable = tokens[index];
  let target = executable;
  let argumentStart = index + 1;
  const launcher = commandName(executable);
  if (['node', 'nodejs', 'bun', 'deno'].includes(launcher) && tokens[index + 1]) {
    target = tokens[index + 1];
    argumentStart = index + 2;
  }
  if (!target || !trusted.has(path.resolve(String(target)))) return null;
  // Leading shell assignments execute before the pinned launcher is reached.
  // Even a seemingly harmless `FOO=bar` can alter module/config lookup or
  // loader behavior, so a trusted broker command must begin with its exact
  // executable and no assignment prefix.
  if (tokens.slice(0, index).some((token) => leadingAssignment(token))) {
    return routeBlock('trusted PAC brokers may not be preceded by shell environment assignments');
  }
  // A trusted helper is meaningful only when launched by the exact PAC-pinned
  // runtime. A PATH executable named `node` (or a copied helper) is not a
  // broker and must never create an exemption.
  if (launcher === 'node' || launcher === 'nodejs' || launcher === 'bun' || launcher === 'deno') {
    if (!options.trustedLauncher || path.resolve(String(executable)) !== path.resolve(options.trustedLauncher)) {
      return routeBlock('trusted helper must be launched by PAC\'s pinned runtime');
    }
    if (!options.trustedLauncherDigest || secureFileDigest(path.resolve(options.trustedLauncher)) !== options.trustedLauncherDigest) {
      return routeBlock('PAC launcher digest does not match PAC state');
    }
  } else return routeBlock('trusted helper requires an explicit PAC runtime');
  // A trusted route is useful only when the exact file still exists as a
  // regular, non-symlinked file. The host hook never follows a projected Skill
  // symlink here; agents can call the neutral local Skill path instead.
  try {
    const targetPath = path.resolve(String(target));
    const root = path.parse(targetPath).root;
    let cursor = root;
    for (const component of targetPath.slice(root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const componentStat = fs.lstatSync(cursor);
      if (componentStat.isSymbolicLink()) return routeBlock('trusted helper path contains a symlink');
      if ((componentStat.mode & 0o022) !== 0) return routeBlock('trusted helper path is group/world writable');
    }
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) return routeBlock('trusted helper file is unsafe');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return routeBlock('trusted helper owner is not the current user');
    if (isSyncedStorage(targetPath)) return routeBlock('trusted helper may not live on synchronized storage');
    const baseName = commandName(targetPath);
    if (!trustedFileMatches(targetPath, options, baseName)) return routeBlock('trusted helper digest does not match PAC state');
  } catch { return routeBlock('trusted helper path is unsafe or missing'); }
  const args = tokens.slice(argumentStart);
  const base = commandName(target);
  if (base === 'scan-guard-hook.mjs') return routeBlock('the PAC hook cannot be invoked as an agent broker');
  // Only the policy-owned resource guard and locator are trusted.  Their own
  // argument validators enforce root/depth/byte budgets; this hook must not
  // infer trust from a substring such as “resource-guard” in an arbitrary
  // command or path.
  if (base === 'resource-guard.mjs') {
    if ((options._trustedRouteDepth || 0) > 0) return routeBlock('nested resource-guard brokers are not allowed');
    if (args.some((token) => SHELL_OPERATORS.has(token))) return routeBlock('resource-guard arguments may not compose shell commands');
    return parseResourceRoute(args, options, cwd);
  }
  if (base === 'locator.mjs') {
    if (args.some((token) => SHELL_OPERATORS.has(token))) return routeBlock('locator arguments may not compose shell commands');
    return parseLocatorRoute(args, options, cwd);
  }
  return routeBlock('trusted executable is not an approved PAC broker');
}

function scanMentioned(tokens) {
  return commandMentionsScan(tokens) || codeTraversalMentioned(tokens.join(' '));
}

// A shell hook cannot know the complete set of launchers an agent may have
// installed (`sudo`, `setsid`, `busybox`, `systemd-run`, a project wrapper,
// ...).  If an otherwise-opaque command contains a scanner-looking token,
// treat it as a hidden scan and fail closed.  Literal data commands are kept
// out of this heuristic so `echo find` and `printf '%s' find` remain harmless.
const SCAN_WORD_RE = /(?:^|[^A-Za-z0-9_./])(?:rg|ripgrep|grep|find|fd|fdfind|tree|du|ls|eza|lsd|locate|updatedb|ctags|codegraph|semgrep|codeql|cloc|scc|tokei|rga|ripgrep-all|ugrep|dust|gdu|ncdu|broot|comby|global|sourcegraph|the_silver_searcher|silver-searcher|pt)(?:\.exe|\.cmd|\.bat)?(?=$|[^A-Za-z0-9_./])/iu;
function hiddenScanMentioned(tokens) {
  const info = segmentInfo(tokens);
  if (!info.executable || SAFE_ARGUMENT_COMMANDS.has(info.executable)) return false;
  if (SCAN_WORD_RE.test(String(info.raw))) return true;
  if (SCAN_BINARIES.has(info.executable)) return true;
  return tokens.slice(info.index + 1).some((token) => {
    const value = String(token);
    return SCAN_WORD_RE.test(value) ||
      // Opaque launchers commonly spell the real scanner as an absolute or
      // relative path (`sudo /bin/find`, `busybox ./rg`).  Basename matching is
      // intentional here; safe literal/data commands exited above, while an
      // unknown launcher must fail closed rather than execute a path-resolved
      // scanner outside PAC's fixed broker.
      SCAN_BINARIES.has(commandName(value));
  });
}

function scriptExecutionMentioned(executable, args) {
  if (!SCRIPT_CAPABLE_COMMANDS.has(executable)) return false;
  if (!args.length || args.every((token) => ['--version', '-V', '--help', '-h'].includes(String(token)))) return false;
  // AWK/sed and the less common language runtimes can invoke a child or walk
  // the filesystem through syntax that is impossible to prove safe with a
  // token regex (concatenated strings, coprocesses, dynamic eval, ...). Any
  // non-help invocation is therefore opaque and must be brokered.
  if (args.some((token) => ['-f', '--file', '--file=', '-e', '--expression'].some((flag) =>
    String(token) === flag || String(token).startsWith(`${flag}=`)))) return true;
  return true;
}

function gitScan(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (commandName(tokens[index]) !== 'git') continue;
    let cursor = index + 1;
    while (cursor < tokens.length) {
      const token = String(tokens[cursor]);
      if (token === '--') { cursor += 1; break; }
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(token)) {
        cursor += 2; continue;
      }
      if (token.startsWith('-C') || token.startsWith('-c') || token.startsWith('--git-dir=') ||
          token.startsWith('--work-tree=') || token.startsWith('--namespace=') || token.startsWith('--config-env=')) {
        cursor += 1; continue;
      }
      if (token.startsWith('-')) { cursor += 1; continue; }
      if (GIT_SCAN_SUBCOMMANDS.has(token.toLowerCase())) return true;
      break;
    }
  }
  return false;
}

function gitConfigUnsafe(cwdInfo) {
  // Read at most the single repository config associated with the verified
  // workspace. This is metadata-only (no Git process, no recursive walk) and
  // prevents `status`/`diff`/`log` from dispatching a repository-configured
  // fsmonitor, pager, external diff, textconv, or filter helper.
  if (process.env.GIT_CONFIG_GLOBAL && process.env.GIT_CONFIG_GLOBAL !== '/dev/null') return 'inherited GIT_CONFIG_GLOBAL can redirect Git configuration';
  if (process.env.GIT_CONFIG_SYSTEM && process.env.GIT_CONFIG_SYSTEM !== '/dev/null') return 'inherited GIT_CONFIG_SYSTEM can redirect Git configuration';
  const workspace = cwdInfo?.workspaceRoot?.absolute || cwdInfo?.absolute;
  if (!workspace) return null;
  try {
    const configFiles = [];
    const gitPath = path.join(workspace, '.git');
    const gitStat = fs.lstatSync(gitPath, { throwIfNoEntry: false });
    if (gitStat) {
      if (gitStat.isSymbolicLink()) return 'repository .git path is a symlink';
      if (!gitStat.isDirectory()) return 'worktree .git indirection is not inspectable on the direct Git path';
      configFiles.push(path.join(gitPath, 'config'));
    }
  // Git also reads global/system config that can install pagers, diff
  // drivers, filters, and includes. Inspect only the conventional bounded
  // files; an explicitly redirected config is rejected above.
    const userHome = process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : null;
    if (userHome) {
      configFiles.push(path.join(userHome, '.gitconfig'));
      configFiles.push(path.join(process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
        ? process.env.XDG_CONFIG_HOME : path.join(userHome, '.config'), 'git', 'config'));
    }
    configFiles.push('/etc/gitconfig');
    for (const config of [...new Set(configFiles)]) {
      const stat = fs.lstatSync(config, { throwIfNoEntry: false });
      if (!stat) continue;
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
          (stat.mode & 0o022) !== 0 || (uid !== null && stat.uid !== 0 && stat.uid !== uid)) {
        return 'Git config is not a small private owner-controlled regular file';
      }
      const raw = fs.readFileSync(config, 'utf8');
      let section = '';
      for (const line of raw.split(/\r?\n/u)) {
        const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/u);
        if (sectionMatch) {
          section = sectionMatch[1].trim().toLowerCase();
          if (section === 'include' || section.startsWith('include ') || section.startsWith('includeif') ||
              section.startsWith('alias') || section.startsWith('credential')) {
            return `Git config section ${sectionMatch[1]} can redirect or dispatch a helper`;
          }
          continue;
        }
        const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:[#;].*)?$/u);
        if (!match) {
          if (!line.trim() || /^[\s[#;]/u.test(line)) continue;
          return 'Git config contains an unrecognised or indirect directive';
        }
      const key = `${section ? `${section}.` : ''}${match[1].toLowerCase()}`;
      const value = match[2].trim().replace(/^(["']).*\1$/u, '').trim().toLowerCase();
      if (/(?:external|textconv|process|smudge|clean|hooks?path|include|alias|credential|sshcommand|askpass|gitproxy|uploadpack|receivepack|mergetool|fsmonitor)/u.test(key)) {
        return `repository Git config key ${match[1]} can dispatch a helper`;
      }
      if (key.endsWith('fsmonitor') || key.endsWith('fsmonitorhook')) {
        if (!['false', '0', 'no', ''].includes(value)) return `repository Git config key ${match[1]} can dispatch a fsmonitor helper`;
      }
      if (key === 'core.pager' || key.startsWith('pager.')) {
        if (!['cat', 'true', ':'].includes(value)) return `repository Git config key ${match[1]} can dispatch a pager`;
      }
      }
    }
  } catch { return 'Git config cannot be inspected safely'; }
  return null;
}

function gitUnsafe(tokens, cwdInfo = null) {
  const invocation = gitInvocation(tokens);
  if (!invocation) return null;

  // Direct Git is intentionally not a shell-safe workload.  Even commands
  // that look read-only can consult repository/global config, invoke pagers,
  // fsmonitor/textconv/filter helpers, walk an unbounded object graph, or
  // interpret selectors such as `:/pattern` and `HEAD:/`.  A parser that tries
  // to enumerate every Git option will eventually miss a new mode (and the
  // caller's Git version may add one).  Even `git --version` is an executable
  // lookup on the host shell surface: a PATH-provided script can run arbitrary
  // code before printing a version. Keep every Git invocation behind PAC's
  // fixed executable/configuration route (the locator owns its scrubbed Git
  // broker).
  return { reason: 'direct Git inspection/mutation must use PAC\'s isolated broker path' };

  /*
   * Keep the bounded grammar below as documentation for the broker migration
   * and for older callers that import these helpers.  It is unreachable from
   * the direct shell hook by design: a future Git option must not silently
   * become permitted merely because it was omitted from a deny list.
   */
  if (invocation.configOption || dangerousAssignment(tokens)) {
    return { reason: 'git configuration/environment indirection is not allowed in a shell scan path' };
  }
  const inherited = dangerousInheritedGitEnvironment();
  if (inherited) {
    return { reason: `inherited ${inherited} can dispatch helpers or redirect Git outside the bounded project path` };
  }
  const configFinding = gitConfigUnsafe(cwdInfo);
  if (configFinding) return { reason: configFinding };
  for (const token of tokens.map(String)) {
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    const normalized = name.toLowerCase();
    if (name === '-c' || (name.startsWith('-c') && name.length > 2) ||
        name === '-C' || name.startsWith('-C') || name === '--git-dir' || name.startsWith('--git-dir=') ||
        name === '--work-tree' || name.startsWith('--work-tree=') || name === '--namespace' || name.startsWith('--namespace=')) {
      return { reason: 'git config/repository redirection options are not allowed on the direct shell path' };
    }
    if (GIT_UNSAFE_OPTIONS.has(name) || GIT_UNSAFE_OPTIONS.has(token) ||
        GIT_UNSAFE_OPTIONS.has(normalized)) {
      return { reason: `git option ${name} may invoke an external helper or alter executable lookup` };
    }
    if (GIT_BROAD_OPTIONS.has(name) || GIT_BROAD_OPTIONS.has(token) || GIT_BROAD_OPTIONS.has(normalized) ||
        /^-u(?:all|true)$/iu.test(token) || /^--(?:untracked-files|ignored)=(?:all|true)$/iu.test(token)) {
      return { reason: `git option ${name} may traverse an unbounded history, object set, or worktree` };
    }
  }
  if (!invocation.subcommand) return { reason: 'git command has no statically known subcommand' };
  const subcommandIndex = tokens.findIndex((token) => String(token).toLowerCase() === invocation.subcommand);
  // Mutating Git commands can run repository hooks (commit), rewrite the
  // worktree/index (add/restore/switch), or initialize/retarget an arbitrary
  // repository (init/branch/tag/remote).  A shell hook cannot install the
  // isolated config and cgroup that make those effects safe, so they must use
  // PAC's explicit transaction/broker path.  Keep only read-only inspection
  // commands on the direct shell surface.
  const readOnly = new Set(['status', 'log', 'diff', 'show', 'cat-file', 'describe', 'shortlog', 'blame', 'count-objects']).has(invocation.subcommand);
  if (!readOnly && invocation.subcommand !== 'version' && invocation.subcommand !== 'help' && invocation.subcommand !== 'rev-parse') {
    return { reason: 'mutating or remote Git commands must use PAC\'s isolated transaction/broker path' };
  }
  if (invocation.subcommand === 'add' || invocation.subcommand === 'commit') {
    return { reason: 'Git index/commit mutation must use PAC\'s isolated transaction/broker path' };
  }
  if (readOnly && subcommandIndex >= 0 && tokens.slice(subcommandIndex + 1).some((token) => {
    const value = String(token);
    return path.isAbsolute(value) || value === '~' || value.startsWith('~/') || value === '..' || value.startsWith('../') ||
      value === '.' || value.startsWith('./') || /[*?{}[\]]/u.test(value);
  })) {
    return { reason: 'Git read-only command may not name an absolute or parent filesystem path' };
  }
  if (invocation.subcommand === 'log') {
    const limits = [];
    for (let index = subcommandIndex + 1; index < tokens.length; index += 1) {
      const value = String(tokens[index]);
      if (value === '-n' || value === '--max-count') {
        const next = Number(tokens[index + 1]);
        if (!Number.isSafeInteger(next)) return { reason: 'git log requires a numeric bounded --max-count' };
        limits.push(next); index += 1;
      } else if (value.startsWith('--max-count=')) {
        limits.push(Number(value.slice(value.indexOf('=') + 1)));
      }
    }
    if (limits.length !== 1 || limits.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 200)) {
      return { reason: 'git log requires exactly one --max-count/-n between 1 and 200' };
    }
  }
  if (GIT_SCAN_SUBCOMMANDS.has(invocation.subcommand)) {
    return { reason: 'git filesystem discovery must use workspace-locator or resource-guard' };
  }
  if (!GIT_SAFE_SUBCOMMANDS.has(invocation.subcommand)) {
    return { reason: 'unknown git subcommand/alias must use an explicit PAC broker' };
  }
  return null;
}

function inspectSegment(segment, cwdInfo, options) {
  const { tokens, preceding } = segment;
  if (!tokens.length) return null;
  const route = trustedRoute(tokens, options, cwdInfo.absolute);
  if (route?.allow) return null;
  if (route?.blocked) return route;
  const { index, wrapped, raw, executable } = segmentInfo(tokens);
  if (!executable) return null;
  // A bare command name is resolved only after the host's trusted PATH is
  // established.  Absolute/relative executable paths on the shell surface
  // would let a project-provided `/tmp/echo`, interpreter, or wrapper bypass
  // that identity check (even for harmless-looking `--version`/`--help`).
  // PAC broker routes are returned above and are the sole path exception.
  if (index === 0 && (raw.includes('/') || raw.includes('\\'))) {
    return { executable, reason: 'raw executable paths are not trusted on the shell surface; use a PAC broker or bare fixed-PATH command' };
  }

  if (dangerousAssignment(tokens)) {
    return { executable, reason: 'dangerous environment indirection is not allowed around agent commands' };
  }
  if (tokens.slice(index + 1).some((token) => isDynamicToken(token))) {
    return { executable, reason: 'glob/brace/tilde/parameter expansion must use an explicit PAC argv broker' };
  }
  if (shellStateMutation(tokens)) {
    return { executable, reason: 'shell alias/function/PATH state must not hide a filesystem scan' };
  }
  if (tokens.some((token) => isDynamicToken(token)) && (index === 0 || tokens.slice(0, index).some((token) => isDynamicToken(token)))) {
    return { executable: 'shell', reason: 'dynamic executable/argument expansion must use an explicit PAC broker' };
  }

  const shell = shellInner(tokens, index);
  if (shell) {
    if (!shell.script) return { executable, reason: 'opaque shell wrapper must use the PAC resource broker' };
    const nested = inspectCommand(shell.script, cwdInfo.absolute, options);
    if (nested) return nested;
    if (codeTraversalMentioned(shell.script) || !options.allowGuardedOpaque) {
      return { executable, reason: 'opaque shell/script execution must use the PAC resource broker' };
    }
    return null;
  }

  if (executable === 'eval' || executable === 'xargs' || executable === 'parallel') {
    return scanMentioned(tokens.slice(index + 1))
      ? { executable, reason: 'nested scan driver' } : null;
  }
  if (executable === 'git') {
    const finding = gitUnsafe(tokens, cwdInfo);
    if (finding) return { executable, ...finding };
  }
  const args = tokens.slice(index + 1);
  if (['cd', 'test', '['].includes(executable) && args.some((token) => {
    const value = String(token);
    return path.isAbsolute(value) || value === '~' || value.startsWith('~/') ||
      value === '..' || value.startsWith('../') || value.includes('/') || value.includes('\\');
  })) {
    return { executable, reason: 'shell metadata/path probes must stay within an explicit PAC workspace' };
  }
  if (HOST_CONTROL_COMMANDS.has(executable)) {
    return { executable, reason: 'host/remote control command is outside the agent resource contract' };
  }
  if (!options.allowGuardedOpaque && (SCAN_TASK_RUNNERS.has(executable) || OPAQUE_LAUNCHERS.has(executable))) {
    return { executable, reason: 'script/build/remote launcher must run through the PAC resource broker' };
  }
  if (!options.allowGuardedOpaque && !SAFE_ARGUMENT_COMMANDS.has(executable) &&
      args.some((token) => OPAQUE_CODE_OPTIONS.has(String(token).split('=', 1)[0]) ||
        (!GUARDED_WORKLOADS.has(executable) && OPAQUE_SCRIPT_OPTIONS.has(String(token).split('=', 1)[0])))) {
    return { executable, reason: 'opaque code/script option must run through the PAC resource broker' };
  }
  if (SCRIPT_BUILTINS.has(executable)) {
    return { executable, reason: 'sourced scripts are opaque; use the PAC resource broker' };
  }
  if (interpreterInvocation(executable, args)) {
    if (codeTraversalMentioned(args.join(' '))) {
      return { executable, reason: 'interpreter filesystem traversal must use workspace-locator or resource-guard' };
    }
    if (!options.allowGuardedOpaque) {
      return { executable, reason: 'interpreter/script execution must use the PAC resource broker' };
    }
    return null;
  }
  if (INTERPRETERS.has(executable) && !options.allowGuardedOpaque) {
    return { executable, reason: 'interpreter probes and scripts must use the PAC resource broker with a fixed executable' };
  }
  if (scriptPathToken(raw)) {
    return { executable, reason: 'direct script paths must use the PAC resource broker' };
  }
  if (DIRECT_READ_COMMANDS.has(executable)) {
    if (!options.allowGuardedOpaque) {
      return { executable, reason: 'file reads must use the PAC fixed resource route so the system binary and I/O budget are bound' };
    }
    if (!exactReadQuery(executable, args, cwdInfo)) {
      return { executable, reason: 'file reads require one small explicit in-root file' };
    }
  }
  if (['curl', 'wget', 'fetch'].includes(executable)) {
    return { executable, reason: 'network clients must use an explicit PAC broker/task with bounded input/output' };
  }
  if (unsafeFileAccessMentioned(executable, args)) {
    return { executable, reason: 'file-loading options require an explicit bounded broker route' };
  }
  if (['curl', 'wget', 'fetch'].includes(executable) &&
      args.some((token) => /^file:/iu.test(String(token)) || /^\\\\/u.test(String(token)))) {
    return { executable, reason: 'local file URLs/UNC reads are outside the in-root read contract' };
  }
  if (!SCAN_BINARIES.has(executable)) {
    // Inline interpreters and loops are opaque.  If they mention a known scan
    // or filesystem traversal primitive, fail closed instead of guessing.
    const text = tokens.join(' ');
    if (['gci', 'dir'].includes(executable) || codeTraversalMentioned(text) || SCAN_INTENT_RE.test(text)) {
      return { executable, reason: wrapped ? 'wrapped opaque scan' : 'opaque scan implementation' };
    }
    if (!options.allowGuardedOpaque && !COMMON_NON_SCAN_COMMANDS.has(executable)) {
      return { executable, reason: 'unknown command/path must use the PAC resource broker' };
    }
    return null;
  }

  const rawExecutable = String(tokens[index] || '');
  if (wrapped) {
    return { executable, reason: 'scan executable may not be hidden behind a shell/wrapper; use the PAC resource-guard route' };
  }
  if ((rawExecutable.includes('/') || rawExecutable.includes('\\')) && !options.allowDirectBoundedScans) {
    return { executable, reason: 'unverified scan executable path; use the PAC resource-guard route' };
  }

  if (args.some((token) => SHELL_OPERATORS.has(token) || PARAM_EXPANSION_RE.test(String(token)))) {
    return { executable, reason: 'shell expansion or command composition' };
  }
  if (args.some((token) => isRecursiveFlag(String(token)))) {
    return { executable, reason: 'recursive/hidden/no-ignore scan flags' };
  }
  // Even an exact-file query can be altered by scanner config files or an
  // inherited PATH. The host hook cannot change the environment of the shell
  // tool that follows it, so every scanner invocation must use the fixed
  // resource-guard environment. `allowDirectBoundedScans` is an internal flag
  // set only after that authenticated broker has validated the wrapper.
  if (!options.allowDirectBoundedScans) {
    return { executable, reason: 'scanner commands must use the PAC resource-guard environment' };
  }
  if ((rawExecutable.includes('/') || rawExecutable.includes('\\')) && !options._trustedScanExecutable) {
    return { executable, reason: 'scan broker accepts only a fixed PATH scanner executable' };
  }
  if (exactFileQuery(executable, args, cwdInfo) || stdinFilter(executable, args, preceding)) return null;
  if (executable === 'rg' && rgDirectoryQuery(args, cwdInfo)) {
    if (options.allowDirectBoundedScans) return null;
    return { executable, reason: 'directory scan must use workspace-locator or resource-guard' };
  }
  if (boundedDirectoryQuery(executable, args, cwdInfo)) {
    // `ls -d` is metadata-only and remains cheap; all enumeration forms go
    // through the capped resource-guard route. The trusted route sets this
    // flag only after validating the exact local wrapper path.
    if ((executable === 'ls' || executable === 'eza' || executable === 'lsd') &&
        hasFlag(args, ['-d', '--directory'])) return null;
    if (options.allowDirectBoundedScans) return null;
    return { executable, reason: 'directory scan must use workspace-locator or resource-guard' };
  }
  return { executable, reason: 'unbounded directory scan; use the workspace index or resource-guard' };
}

export function inspectCommand(command, cwd = process.cwd(), options = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const cwdInfo = safeCwd(cwd, options.home || process.env.HOME);
  const lexical = tokenize(command);
  // Input redirection can turn an apparently argument-free shell or
  // interpreter into an arbitrary script runner (`sh < script.sh`,
  // `python3 </dev/stdin`).  The hook cannot authenticate or bound the bytes
  // delivered through a shell redirection, so reject every parsed input
  // redirection.  Process substitution is the same execution surface even
  // when it is attached to output redirection (`> >(sh ...)`).
  const inputRedirection = lexical.tokens.find((token) => token === '<' || token === '<<');
  if (inputRedirection) {
    return { blocked: true, executable: 'shell', reason: 'input redirection is not an authenticated PAC argv; use the resource broker' };
  }
  const processSubstitution = lexical.tokens.some((token, index) =>
    (token === '>' || token === '>>' || token === '<' || token === '<<') && lexical.tokens[index + 1] === '(');
  if (processSubstitution) {
    return { blocked: true, executable: 'shell', reason: 'process substitution may execute an unbounded child; use the resource broker' };
  }
  const redirectionIndex = lexical.tokens.findIndex((token) => ['<', '<<'].includes(token));
  // Here-strings/heredocs and process redirections can carry an executable
  // script that the segment splitter sees only as data (`sh <<< 'find .'`).
  // A raw scanner word in such a payload is never safe for direct execution.
  if (redirectionIndex >= 0 && SCAN_WORD_RE.test(lexical.tokens.slice(redirectionIndex + 1).join(' '))) {
    return { blocked: true, executable: 'shell', reason: 'redirection payload may hide a filesystem scan' };
  }
  // Command substitution is executable code, even when hidden inside a
  // quoted argument. A lexical hook cannot prove its side effects, so it is
  // rejected before any scan-word test and must use the broker.
  if (SUBSTITUTION_RE.test(command) || lexical.unclosedQuote) {
    return { blocked: true, executable: 'shell', reason: 'command substitution/backticks or an unclosed quote require the PAC resource broker' };
  }
  const parsedSegments = commandSegments(lexical.tokens);
  // Validate pipelines before deciding whether a scanner word is present.
  // Otherwise `printf 'find .' | sh` looks like harmless literal data and the
  // shell/interpreter on the right can execute it from stdin unchecked.
  for (let index = 1; index < parsedSegments.length; index += 1) {
    if (!['|', '|&'].includes(parsedSegments[index].preceding)) continue;
    if (!cwdInfo || !safePipeProducer(parsedSegments[index - 1], cwdInfo)) {
      return { blocked: true, executable: 'shell', reason: 'pipeline producer is not a bounded literal' };
    }
    if (!safePipeConsumer(parsedSegments[index])) {
      return { blocked: true, executable: 'shell', reason: 'pipeline consumer may not execute arbitrary stdin; use a PAC broker' };
    }
  }
  const earlyFinding = parsedSegments.map((segment) => {
    const tokens = segment.tokens;
    const info = segmentInfo(tokens);
    const args = tokens.slice(info.index + 1);
    if (!info.executable) return null;
    if (['cd', 'test', '['].includes(info.executable) && args.some((token) => {
      const value = String(token);
      return path.isAbsolute(value) || value === '~' || value.startsWith('~/') ||
        value === '..' || value.startsWith('../') || value.includes('/') || value.includes('\\');
    })) {
      return { blocked: true, executable: info.executable, reason: 'shell metadata/path probes must stay within an explicit PAC workspace' };
    }
    const route = trustedRoute(tokens, options, cwdInfo?.absolute || cwd);
    if (route?.allow) return null;
    if (route?.blocked) return route;
    if (info.index === 0 && (info.raw.includes('/') || info.raw.includes('\\'))) {
      return { blocked: true, executable: info.executable, reason: 'raw executable paths are not trusted on the shell surface; use a PAC broker or bare fixed-PATH command' };
    }
    if (dangerousAssignment(tokens)) {
      return { blocked: true, executable: info.executable, reason: 'dangerous environment indirection is not allowed around agent commands' };
    }
    if (args.some((token) => isDynamicToken(token))) {
      return { blocked: true, executable: info.executable, reason: 'glob/brace/tilde/parameter expansion must use an explicit PAC argv broker' };
    }
    if (shellStateMutation(tokens)) {
      return { blocked: true, executable: info.executable, reason: 'shell alias/function/PATH state must not hide a filesystem scan' };
    }
    if (isDynamicToken(info.raw) || tokens.slice(0, info.index).some((token) => isDynamicToken(token))) {
      return { blocked: true, executable: 'shell', reason: 'dynamic executable expansion must use an explicit PAC broker' };
    }
    if (!SAFE_ARGUMENT_COMMANDS.has(info.executable) && PARAM_EXPANSION_RE.test(tokens.join(' ')) &&
        (SCAN_WORD_RE.test(tokens.join(' ')) || !SAFE_LITERAL_COMMANDS.has(info.executable))) {
      return { blocked: true, executable: info.executable, reason: 'unparsed shell parameter expansion must use the PAC resource broker' };
    }
    if (SCRIPT_BUILTINS.has(info.executable) || scriptPathToken(info.raw)) {
      return { blocked: true, executable: info.executable, reason: 'sourced/direct scripts must use the PAC resource broker' };
    }
    if (DIRECT_READ_COMMANDS.has(info.executable)) {
      if (!options.allowGuardedOpaque) {
        return { blocked: true, executable: info.executable, reason: 'file reads must use the PAC fixed resource route so the system binary and I/O budget are bound' };
      }
      if (!exactReadQuery(info.executable, args, cwdInfo)) {
        return { blocked: true, executable: info.executable, reason: 'file reads require one small explicit in-root file' };
      }
    }
    if (['curl', 'wget', 'fetch'].includes(info.executable)) {
      return { blocked: true, executable: info.executable, reason: 'network clients must use an explicit PAC broker/task with bounded input/output' };
    }
    if (unsafeFileAccessMentioned(info.executable, args)) {
      return { blocked: true, executable: info.executable, reason: 'file-loading options require an explicit bounded broker route' };
    }
    if (['curl', 'wget', 'fetch'].includes(info.executable) &&
        args.some((token) => /^file:/iu.test(String(token)) || /^\\\\/u.test(String(token)))) {
      return { blocked: true, executable: info.executable, reason: 'local file URLs/UNC reads are outside the in-root read contract' };
    }
    if (INTERPRETERS.has(info.executable) && !options.allowGuardedOpaque) {
      return { blocked: true, executable: info.executable, reason: 'interpreter probes and scripts must use the PAC resource broker with a fixed executable' };
    }
    if (SHELLS.has(info.executable) && !options.allowGuardedOpaque) {
      return { blocked: true, executable: info.executable, reason: 'opaque shell execution must use the PAC resource broker' };
    }
    if (['eval', 'xargs', 'parallel'].includes(info.executable) && !options.allowGuardedOpaque) {
      return { blocked: true, executable: info.executable, reason: 'dynamic command drivers must use the PAC resource broker' };
    }
    const gitFinding = info.executable === 'git' ? gitUnsafe(tokens, cwdInfo) : null;
    if (gitFinding) return { blocked: true, executable: 'git', ...gitFinding };
    if (scriptRunnerScan(info.executable, args)) {
      return { blocked: true, executable: info.executable, reason: 'script runner scan task must use the PAC resource broker' };
    }
    if (HOST_CONTROL_COMMANDS.has(info.executable)) {
      return { blocked: true, executable: info.executable, reason: 'host/remote control command is outside the agent resource contract' };
    }
    if (!options.allowGuardedOpaque && (SCAN_TASK_RUNNERS.has(info.executable) || OPAQUE_LAUNCHERS.has(info.executable))) {
      return { blocked: true, executable: info.executable, reason: 'script/build/remote launcher must run through the PAC resource broker' };
    }
    if (!options.allowGuardedOpaque && !SAFE_ARGUMENT_COMMANDS.has(info.executable) &&
        args.some((token) => OPAQUE_CODE_OPTIONS.has(String(token).split('=', 1)[0]) ||
          (!GUARDED_WORKLOADS.has(info.executable) && OPAQUE_SCRIPT_OPTIONS.has(String(token).split('=', 1)[0])))) {
      return { blocked: true, executable: info.executable, reason: 'opaque code/script option must run through the PAC resource broker' };
    }
    if (scriptExecutionMentioned(info.executable, args)) {
      return { blocked: true, executable: info.executable, reason: 'script-capable command may execute a scan or external process; use the PAC resource broker' };
    }
    if (hiddenScanMentioned(tokens) && !options.allowDirectBoundedScans) {
      return { blocked: true, executable: info.executable, reason: 'opaque launcher hides a filesystem scan; use the PAC resource broker' };
    }
    if (potentialScanSegment(tokens) && !commandMentionsScan(tokens) &&
        !SAFE_LITERAL_COMMANDS.has(info.executable) && SCAN_INTENT_RE.test(tokens.join(' '))) {
      return { blocked: true, executable: info.executable, reason: 'opaque command has filesystem-scan intent' };
    }
    if (!options.allowGuardedOpaque && !SCAN_BINARIES.has(info.executable) && !COMMON_NON_SCAN_COMMANDS.has(info.executable)) {
      return { blocked: true, executable: info.executable, reason: 'unknown command/path must use the PAC resource broker' };
    }
    return null;
  }).find(Boolean);
  if (earlyFinding) return earlyFinding;
  const mentionsScan = parsedSegments.some((segment) => commandMentionsScan(segment.tokens) || hiddenScanMentioned(segment.tokens)) ||
    parsedSegments.some((segment) => {
      const info = segmentInfo(segment.tokens);
      return SCAN_BINARIES.has(info.executable) || (info.executable === 'git' && Boolean(gitScan(segment.tokens)));
    });
  if (!mentionsScan) return null;
  if (!cwdInfo) return { blocked: true, executable: 'shell', reason: 'scan cwd is not a verified project directory' };
  if (lexical.unsafeSyntax || lexical.unclosedQuote || SUBSTITUTION_RE.test(command)) {
    return { blocked: true, executable: 'shell', reason: 'shell substitution/expansion around a scan' };
  }
  const rootInfo = options._registeredRootInfo || registryRoots(options, options.home || process.env.HOME);
  const workspace = registeredWorkspace(cwdInfo, { ...options, _registeredRootInfo: rootInfo }, options.home || process.env.HOME);
  if (!workspace.root) {
    return { blocked: true, executable: 'shell', reason: workspace.error
      ? `scan workspace registry unavailable: ${workspace.error}`
      : 'scan cwd is not inside an explicitly registered workspace root' };
  }
  if (workspace.root.synced) {
    return { blocked: true, executable: 'shell', reason: 'directory scans on synchronized storage must use the local index' };
  }
  const scopedCwdInfo = { ...cwdInfo, workspaceRoot: workspace.root };
  const scopedOptions = { ...options, _registeredRootInfo: rootInfo };
  const operators = lexical.tokens.filter((token) => SHELL_OPERATORS.has(token));
  // A safe scan followed by another command is still an unbounded composite
  // from the host's perspective. A single stdin pipe is the only composition
  // accepted, and each side must independently pass the policy.
  if (operators.some((operator) => !['|'].includes(operator))) {
    return { blocked: true, executable: 'shell', reason: 'multi-command shell composition around a scan' };
  }
  for (let index = 1; index < parsedSegments.length; index += 1) {
    if (['|', '|&'].includes(parsedSegments[index].preceding) && !safePipeProducer(parsedSegments[index - 1], scopedCwdInfo)) {
      return { blocked: true, executable: 'shell', reason: 'pipeline producer is not a bounded literal or exact in-root file' };
    }
    if (['|', '|&'].includes(parsedSegments[index].preceding) && !safePipeConsumer(parsedSegments[index])) {
      return { blocked: true, executable: 'shell', reason: 'pipeline consumer may not execute arbitrary stdin; use a PAC broker' };
    }
  }
  for (const segment of parsedSegments) {
    const finding = inspectSegment(segment, scopedCwdInfo, scopedOptions);
    if (finding) return { blocked: true, ...finding };
  }
  // A scan name used as data to an opaque command is not proof of safety.  The
  // conservative fallback catches eval/loop forms the tokeniser cannot model.
  if (/(?:\beval\b|\bfor\b|\bwhile\b|\bxargs\b|\bparallel\b)[\s\S]*\b(?:rg|grep|find|fd|fdfind|tree|du|ls|eza|lsd)\b/u.test(command)) {
    return { blocked: true, executable: 'shell', reason: 'nested scan loop/driver' };
  }
  return null;
}

const DIRECT_COMMAND_KEYS = ['command', 'cmd', 'shell_command', 'shellCommand', 'code', 'run', 'program', 'shell', 'script'];
const COMMAND_SHAPE_KEYS = new Set([
  ...DIRECT_COMMAND_KEYS.map((key) => key.toLowerCase()), 'argv', 'commands', 'args', 'arguments', 'execute',
]);
const MCP_EXECUTION_KEY_RE = /^(?:command|cmd|shell(?:_command)?|script|exec(?:ute)?|argv|code|program|run|spawn|process|args|arguments)$/iu;
const MCP_FILESYSTEM_KEY_RE = /^(?:root|cwd|directory|dir|folder|path|file|files|glob|pattern|index|walk|recursive|include[_-]?hidden)$/iu;
const MCP_RISKY_TOOL_RE = /(?:shell|exec|command|run|code|file(?:system)?|search|index|scan|walk|tree|grep|ripgrep|rg|find)/iu;
const CONTEXT_SEARCH_MAX_QUERIES = 8;
const CONTEXT_SEARCH_MAX_QUERY_BYTES = 512;
const CONTEXT_SEARCH_MAX_RESULTS = 20;
const CODEGRAPH_ALLOWED_KEYS = new Set(['query', 'projectPath', 'maxFiles', 'includeCode']);

function commandShapePresent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Object.keys(input).some((key) => {
    const normalized = String(key).replaceAll('-', '_').toLowerCase();
    return COMMAND_SHAPE_KEYS.has(normalized);
  });
}

function mcpInputSignals(input, budget = { nodes: 128, chars: 8192 }, depth = 0) {
  const result = { execution: false, filesystem: false, scanText: false, truncated: false };
  if (depth > 4 || budget.nodes <= 0 || budget.chars <= 0) {
    result.truncated = true;
    return result;
  }
  budget.nodes -= 1;
  if (typeof input === 'string') {
    const value = input.slice(0, Math.max(0, budget.chars));
    if (value.length < input.length) result.truncated = true;
    budget.chars -= value.length;
    result.scanText = SCAN_WORD_RE.test(value) || SCAN_INTENT_RE.test(value);
    return result;
  }
  if (!input || typeof input !== 'object') return result;
  const entries = Object.entries(input);
  if (entries.length > 64) result.truncated = true;
  for (const [key, value] of entries.slice(0, 64)) {
    const name = String(key);
    result.execution ||= MCP_EXECUTION_KEY_RE.test(name);
    result.filesystem ||= MCP_FILESYSTEM_KEY_RE.test(name);
    if (budget.chars > 0) {
      const child = mcpInputSignals(value, budget, depth + 1);
      result.execution ||= child.execution;
      result.filesystem ||= child.filesystem;
      result.scanText ||= child.scanText;
      result.truncated ||= child.truncated;
    } else result.truncated = true;
    if (result.execution && result.filesystem && result.scanText) break;
  }
  return result;
}

function jsonByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function objectInputError(input, label, maxBytes = MAX_NATIVE_INPUT_BYTES) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return `${label} input must be an object`;
  if (jsonByteLength(input) > maxBytes) return `${label} input exceeds the bounded payload size`;
  return null;
}

function unsupportedKeys(input, allowed) {
  return Object.keys(input).filter((key) => !allowed.has(key));
}

function nativePathValue(input, keys) {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (present.length !== 1) return { error: `exactly one of ${keys.join(', ')} is required` };
  const value = input[present[0]];
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > MAX_NATIVE_PATH_BYTES || value.includes('\0')) {
    return { error: `${present[0]} must be one short exact path` };
  }
  // Native file tools receive this as one path value and do not perform shell
  // expansion, so characters such as `[` or `*` may be legitimate filenames.
  if (/[\r\n]/u.test(value)) return { error: `${present[0]} must not contain multiline syntax` };
  return { key: present[0], value };
}

function nativeFileStat(input, keys, cwd, label, { mayBeMissing = true, maxBytes = MAX_NATIVE_FILE_BYTES } = {}) {
  const selected = nativePathValue(input, keys);
  if (selected.error) return { error: `${label} ${selected.error}` };
  const target = path.resolve(cwd, selected.value);
  let stat;
  try { stat = fs.statSync(target, { throwIfNoEntry: false }); }
  catch { return { error: `${label} path metadata is unavailable` }; }
  if (!stat) return mayBeMissing ? { target, stat: null } : { error: `${label} target does not exist` };
  if (!stat.isFile()) return { error: `${label} target must be one regular file` };
  if (stat.size > maxBytes) return { error: `${label} target exceeds the exact-file byte cap` };
  return { target, stat };
}

function boundedInteger(value, { min = 0, max, label }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) return `${label} is outside the bounded integer range`;
  return null;
}

function pageSelectionError(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) return 'Read pages must be a short page range';
  let pages = 0;
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
    if (!match) return 'Read pages has invalid range syntax';
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 100000) {
      return 'Read pages is outside the bounded page range';
    }
    pages += end - start + 1;
    if (pages > MAX_DIRECT_CONTEXT) return `Read pages exceeds ${MAX_DIRECT_CONTEXT} pages`;
  }
  return null;
}

function patchInputError(input, cwd) {
  const base = objectInputError(input, 'apply_patch', 2 * MAX_NATIVE_CONTENT_BYTES + 64 * 1024);
  if (base) return base;
  const extra = unsupportedKeys(input, new Set(['command', 'patch']));
  if (extra.length) return `apply_patch contains unsupported field ${extra[0]}`;
  const fields = ['command', 'patch'].filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (fields.length !== 1 || typeof input[fields[0]] !== 'string') return 'apply_patch requires exactly one patch string';
  const patch = input[fields[0]];
  if (Buffer.byteLength(patch, 'utf8') > MAX_NATIVE_CONTENT_BYTES || patch.includes('\0')) return 'apply_patch exceeds the patch byte cap';
  if (!/^\*\*\* Begin Patch\r?\n[\s\S]*\r?\n\*\*\* End Patch\r?\n?$/u.test(patch)) {
    return 'apply_patch must use one complete Begin/End Patch envelope';
  }
  if ((patch.match(/^\*\*\* Begin Patch\r?$/gmu) || []).length !== 1 ||
      (patch.match(/^\*\*\* End Patch\r?$/gmu) || []).length !== 1) {
    return 'apply_patch must contain exactly one patch envelope';
  }
  const fileLines = patch.match(/^\*\*\* (?:Add|Update|Delete) File: .+$/gmu) || [];
  const moveLines = patch.match(/^\*\*\* Move to: .+$/gmu) || [];
  const hunkLines = patch.match(/^@@/gmu) || [];
  if (fileLines.length < 1 || fileLines.length + moveLines.length > MAX_NATIVE_PATCH_FILES) {
    return `apply_patch must target 1-${MAX_NATIVE_PATCH_FILES} exact files`;
  }
  if (hunkLines.length > MAX_NATIVE_PATCH_HUNKS) return 'apply_patch exceeds the hunk cap';
  let existingBytes = 0;
  const targets = new Set();
  for (const line of [...fileLines, ...moveLines]) {
    const target = line.slice(line.indexOf(':') + 1).trim();
    if (nativePathValue({ path: target }, ['path']).error) return 'apply_patch contains an unsafe target path';
    targets.add(path.resolve(cwd, target));
  }
  for (const target of targets) {
    let stat;
    try { stat = fs.statSync(target, { throwIfNoEntry: false }); }
    catch { return 'apply_patch target metadata is unavailable'; }
    if (!stat) continue;
    if (!stat.isFile()) return 'apply_patch target must be a regular file';
    existingBytes += stat.size;
    if (existingBytes > MAX_NATIVE_FILE_BYTES) return 'apply_patch existing targets exceed the aggregate byte cap';
  }
  // Native edits are still governed by the host sandbox/project policy; this
  // hook supplies exact-operand resource bounds, not a second authority model.
  return null;
}

function nativeReadInputError(tool, input, cwd) {
  const base = objectInputError(input, tool);
  if (base) return base;
  const allowed = new Set(['file_path', 'filePath', 'path', 'offset', 'limit', 'pages', 'line_start', 'line_end']);
  const extra = unsupportedKeys(input, allowed);
  if (extra.length) return `${tool} contains unsupported field ${extra[0]}`;
  const file = nativeFileStat(input, ['file_path', 'filePath', 'path'], cwd, tool);
  if (file.error) return file.error;
  if (input.offset !== undefined) {
    const error = boundedInteger(input.offset, { min: 0, max: 1_000_000_000, label: `${tool} offset` });
    if (error) return error;
  }
  if (input.limit !== undefined) {
    const error = boundedInteger(input.limit, { min: 1, max: MAX_DIRECT_COLUMNS, label: `${tool} limit` });
    if (error) return error;
  }
  for (const key of ['line_start', 'line_end']) {
    if (input[key] !== undefined) {
      const error = boundedInteger(input[key], { min: 1, max: 1_000_000_000, label: `${tool} ${key}` });
      if (error) return error;
    }
  }
  if (input.line_start !== undefined && input.line_end !== undefined &&
      (input.line_end < input.line_start || input.line_end - input.line_start + 1 > MAX_DIRECT_COLUMNS)) {
    return `${tool} line range exceeds ${MAX_DIRECT_COLUMNS} lines`;
  }
  const pages = pageSelectionError(input.pages);
  if (pages) return pages;
  const boundedWindow = input.limit !== undefined || input.pages !== undefined || input.line_end !== undefined;
  if (file.stat?.size > MAX_DIRECT_FILE_BYTES && !boundedWindow) {
    return `${tool} must chunk a file larger than ${MAX_DIRECT_FILE_BYTES} bytes`;
  }
  return null;
}

function nativeWriteInputError(tool, input, cwd) {
  const base = objectInputError(input, tool, 2 * MAX_NATIVE_CONTENT_BYTES + 64 * 1024);
  if (base) return base;
  const extra = unsupportedKeys(input, new Set(['file_path', 'filePath', 'path', 'content']));
  if (extra.length) return `${tool} contains unsupported field ${extra[0]}`;
  const file = nativeFileStat(input, ['file_path', 'filePath', 'path'], cwd, tool);
  if (file.error) return file.error;
  if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_NATIVE_CONTENT_BYTES) {
    return `${tool} content exceeds the write byte cap`;
  }
  return null;
}

function editEntryError(edit, label) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return `${label} must be an object`;
  const extra = unsupportedKeys(edit, new Set(['old_string', 'new_string', 'replace_all']));
  if (extra.length) return `${label} contains unsupported field ${extra[0]}`;
  if (typeof edit.old_string !== 'string' || edit.old_string.length < 1 || typeof edit.new_string !== 'string') {
    return `${label} requires non-empty old_string and string new_string`;
  }
  if (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean') return `${label} replace_all must be boolean`;
  if (Buffer.byteLength(edit.old_string, 'utf8') + Buffer.byteLength(edit.new_string, 'utf8') > MAX_NATIVE_CONTENT_BYTES) {
    return `${label} text exceeds the edit byte cap`;
  }
  return null;
}

function nativeEditInputError(tool, input, cwd) {
  const base = objectInputError(input, tool, 2 * MAX_NATIVE_CONTENT_BYTES + 64 * 1024);
  if (base) return base;
  const multi = tool === 'MultiEdit';
  const allowed = multi
    ? new Set(['file_path', 'filePath', 'path', 'edits'])
    : new Set(['file_path', 'filePath', 'path', 'old_string', 'new_string', 'replace_all']);
  const extra = unsupportedKeys(input, allowed);
  if (extra.length) return `${tool} contains unsupported field ${extra[0]}`;
  const file = nativeFileStat(input, ['file_path', 'filePath', 'path'], cwd, tool);
  if (file.error) return file.error;
  if (!multi) return editEntryError({
    old_string: input.old_string,
    new_string: input.new_string,
    ...(input.replace_all === undefined ? {} : { replace_all: input.replace_all }),
  }, tool);
  if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 128) return 'MultiEdit requires 1-128 edits';
  for (let index = 0; index < input.edits.length; index += 1) {
    const error = editEntryError(input.edits[index], `MultiEdit edits[${index}]`);
    if (error) return error;
  }
  return null;
}

function notebookInputError(tool, input, cwd, edit) {
  const base = objectInputError(input, tool, edit ? 2 * MAX_NATIVE_CONTENT_BYTES + 64 * 1024 : MAX_NATIVE_INPUT_BYTES);
  if (base) return base;
  const allowed = edit
    ? new Set(['notebook_path', 'cell_id', 'new_source', 'cell_type', 'edit_mode'])
    : new Set(['notebook_path', 'cell_id', 'pages']);
  const extra = unsupportedKeys(input, allowed);
  if (extra.length) return `${tool} contains unsupported field ${extra[0]}`;
  const file = nativeFileStat(input, ['notebook_path'], cwd, tool);
  if (file.error) return file.error;
  if (input.cell_id !== undefined && (typeof input.cell_id !== 'string' || input.cell_id.length > 256 || input.cell_id.includes('\0'))) {
    return `${tool} cell_id is invalid`;
  }
  if (!edit) return pageSelectionError(input.pages);
  if (typeof input.new_source !== 'string' || Buffer.byteLength(input.new_source, 'utf8') > MAX_NATIVE_CONTENT_BYTES) {
    return 'NotebookEdit new_source exceeds the write byte cap';
  }
  if (input.cell_type !== undefined && !['code', 'markdown'].includes(input.cell_type)) return 'NotebookEdit cell_type is invalid';
  if (input.edit_mode !== undefined && !['replace', 'insert', 'delete'].includes(input.edit_mode)) return 'NotebookEdit edit_mode is invalid';
  return null;
}

function privateLiteralHost(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '').replace(/\.+$/u, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // Static policy cannot resolve or pin DNS safely. Reject every direct IPv6
  // literal (including IPv4-mapped spellings) and the private/special IPv4
  // ranges below; public DNS/redirect enforcement remains the web provider's
  // responsibility and is reported as an unobservable boundary.
  if (host.includes(':')) return true;
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return false;
  const [a, b] = octets.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function webUrlError(value, label) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > MAX_NATIVE_PATH_BYTES || value.includes('\0')) {
    return `${label} must be one short URL`;
  }
  if (value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return `${label} must not contain raw whitespace/control bytes`;
  let parsed;
  try { parsed = new URL(value); } catch { return `${label} must be an absolute URL`; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return `${label} must use http or https`;
  if (parsed.username || parsed.password) return `${label} must not contain URL credentials`;
  if (privateLiteralHost(parsed.hostname)) return `${label} must not target a local/private literal address`;
  return null;
}

function nativeWebInputError(tool, input) {
  const base = objectInputError(input, tool);
  if (base) return base;
  if (tool === 'WebFetch' || tool === 'Fetch') {
    const extra = unsupportedKeys(input, new Set(['url', 'prompt']));
    if (extra.length) return `${tool} contains unsupported field ${extra[0]}`;
    const url = webUrlError(input.url, `${tool} url`);
    if (url) return url;
    if (input.prompt !== undefined && (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt, 'utf8') > 32 * 1024)) {
      return `${tool} prompt exceeds the input cap`;
    }
    return null;
  }
  if (tool === 'WebSearch') {
    const extra = unsupportedKeys(input, new Set(['query', 'allowed_domains', 'blocked_domains']));
    if (extra.length) return `WebSearch contains unsupported field ${extra[0]}`;
    if (typeof input.query !== 'string' || input.query.length < 1 || Buffer.byteLength(input.query, 'utf8') > 4096 || input.query.includes('\0')) {
      return 'WebSearch query exceeds the input cap';
    }
    for (const key of ['allowed_domains', 'blocked_domains']) {
      if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 20 ||
          input[key].some((value) => typeof value !== 'string' || value.length > 253 || value.includes('\0')))) {
        return `WebSearch ${key} is invalid`;
      }
    }
    return null;
  }
  let requests = 0;
  let nodes = 0;
  const inspect = (value, key = '', depth = 0) => {
    nodes += 1;
    if (nodes > 512) return 'web__run exceeds the structural node cap';
    if (depth > 5) return 'web__run input exceeds the nesting cap';
    if (Array.isArray(value)) {
      requests += value.length;
      if (requests > MAX_NATIVE_WEB_REQUESTS) return 'web__run exceeds the request-count cap';
      for (const item of value) {
        const error = inspect(item, key, depth + 1);
        if (error) return error;
      }
      return null;
    }
    if (!value || typeof value !== 'object') {
      if (key === 'url') return webUrlError(value, 'web__run url');
      if (key === 'ref_id' && typeof value === 'string') {
        if (value !== value.trim() || /^(?:\/\/|\\\\)/u.test(value)) return 'web__run ref_id has an unsafe URL form';
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return webUrlError(value, 'web__run ref_id');
      }
      return null;
    }
    for (const [childKey, child] of Object.entries(value)) {
      const error = inspect(child, childKey, depth + 1);
      if (error) return error;
    }
    return null;
  };
  return inspect(input);
}

function imageGenerationInputError(input, cwd) {
  const base = objectInputError(input, 'image generation');
  if (base) return base;
  const extra = unsupportedKeys(input, new Set(['prompt', 'referenced_image_paths', 'num_last_images_to_include']));
  if (extra.length) return `image generation contains unsupported field ${extra[0]}`;
  if (typeof input.prompt !== 'string' || input.prompt.length < 1 || Buffer.byteLength(input.prompt, 'utf8') > 256 * 1024) {
    return 'image generation prompt exceeds the input cap';
  }
  if (input.referenced_image_paths !== undefined && input.referenced_image_paths !== null) {
    if (!Array.isArray(input.referenced_image_paths) || input.referenced_image_paths.length > 5) return 'image generation accepts at most five exact image paths';
    for (const imagePath of input.referenced_image_paths) {
      const file = nativeFileStat({ path: imagePath }, ['path'], cwd, 'image generation');
      if (file.error) return file.error;
    }
  }
  if (input.num_last_images_to_include !== undefined && input.num_last_images_to_include !== null) {
    const error = boundedInteger(input.num_last_images_to_include, { min: 1, max: 5, label: 'num_last_images_to_include' });
    if (error) return error;
  }
  if (input.referenced_image_paths != null && input.num_last_images_to_include != null) {
    return 'image generation must use paths or recent images, not both';
  }
  return null;
}

// Return {handled:false} for shell/MCP/future tools so the generic fail-closed
// logic remains authoritative. Known native tools never flow through the MCP
// scan-word heuristic: source text such as "use grep" is data, not execution.
function nativeToolInput(tool, input, cwd) {
  if (!NATIVE_SCHEMA_TOOLS.has(tool)) return { handled: false, error: null };
  if (NATIVE_PATCH_TOOLS.has(tool)) return { handled: true, error: patchInputError(input, cwd) };
  if (NATIVE_READ_TOOLS.has(tool)) return { handled: true, error: nativeReadInputError(tool, input, cwd) };
  if (NATIVE_WRITE_TOOLS.has(tool)) return { handled: true, error: nativeWriteInputError(tool, input, cwd) };
  if (NATIVE_EDIT_TOOLS.has(tool)) return { handled: true, error: nativeEditInputError(tool, input, cwd) };
  if (NATIVE_NOTEBOOK_READ_TOOLS.has(tool)) return { handled: true, error: notebookInputError(tool, input, cwd, false) };
  if (NATIVE_NOTEBOOK_EDIT_TOOLS.has(tool)) return { handled: true, error: notebookInputError(tool, input, cwd, true) };
  if (NATIVE_IMAGE_READ_TOOLS.has(tool)) {
    const base = objectInputError(input, tool);
    if (base) return { handled: true, error: base };
    const extra = unsupportedKeys(input, new Set(['path', 'detail', 'environment_id']));
    const file = extra.length ? { error: `${tool} contains unsupported field ${extra[0]}` }
      : nativeFileStat(input, ['path'], cwd, tool);
    if (!file.error && input.detail !== undefined && !['high', 'original', 'auto', 'low'].includes(input.detail)) file.error = `${tool} detail is invalid`;
    return { handled: true, error: file.error || null };
  }
  if (NATIVE_WEB_TOOLS.has(tool)) return { handled: true, error: nativeWebInputError(tool, input) };
  if (NATIVE_IMAGE_GENERATION_TOOLS.has(tool)) return { handled: true, error: imageGenerationInputError(input, cwd) };
  return { handled: true, error: objectInputError(input, tool) };
}

function codegraphInputError(input, cwd, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'CodeGraph input must be an object';
  if (Object.keys(input).some((key) => !CODEGRAPH_ALLOWED_KEYS.has(key))) {
    return 'CodeGraph explore accepts only query, projectPath, maxFiles, and includeCode';
  }
  if (typeof input.query !== 'string' || input.query.length < 1 || input.query.length > MAX_LOCATOR_QUERY || input.query.includes('\0')) {
    return 'CodeGraph query must be a short non-empty string';
  }
  if (input.maxFiles !== undefined &&
      (!Number.isSafeInteger(Number(input.maxFiles)) || Number(input.maxFiles) < 1 || Number(input.maxFiles) > MAX_LOCATOR_RESULTS)) {
    return 'CodeGraph maxFiles exceeds the result cap';
  }
  if (input.includeCode !== undefined && typeof input.includeCode !== 'boolean') return 'CodeGraph includeCode must be boolean';
  if (typeof input.projectPath !== 'string' || !path.isAbsolute(input.projectPath) ||
      input.projectPath.length > 512 || input.projectPath.includes('\0')) {
    return 'CodeGraph projectPath must name one absolute registered project path';
  }
  const target = path.resolve(input.projectPath);
  const loaded = options._registeredRootInfo || registryRoots(options, options.home || process.env.HOME);
  const registered = loaded.roots?.find((root) => {
    const suffix = path.relative(root.absolute, target);
    return !root.synced && (suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix)));
  });
  if (!registered) return 'CodeGraph projectPath must be inside an explicitly registered local workspace root';
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return 'CodeGraph projectPath must be an existing real directory';
  const caller = safeCwd(cwd, options.home || process.env.HOME);
  if (!caller) return 'CodeGraph requires a verified caller workspace';
  const callerSuffix = path.relative(registered.absolute, caller.absolute);
  if (callerSuffix !== '' && (callerSuffix === '..' || callerSuffix.startsWith(`..${path.sep}`) || path.isAbsolute(callerSuffix))) {
    return 'CodeGraph caller and projectPath must use the same registered local workspace root';
  }
  return null;
}

function unknownMcpFinding(tool, input, options, cwd = process.cwd()) {
  if (!/^mcp__/iu.test(tool)) return null;
  const approved = approvedMcpTools(options);
  const explicitlyApproved = approved.has(tool);
  if (CONTEXT_SEARCH_TOOL_RE.test(tool)) return null;
  if (!explicitlyApproved) {
    return 'unknown MCP tool is denied by the immutable PAC allowlist; update and re-pin PAC to add a provider';
  }
  if (tool.endsWith('__codegraph_explore')) return codegraphInputError(input, cwd, options);
  const signals = mcpInputSignals(input);
  if (signals.truncated) return 'unknown MCP payload exceeds the bounded inspection depth/size';
  if (signals.execution) return 'unknown MCP tool exposes an executable/code schema; use an approved PAC broker';
  if (signals.filesystem && (MCP_RISKY_TOOL_RE.test(tool) || signals.scanText)) {
    return 'unknown MCP filesystem/search schema is not PAC-approved';
  }
  if (signals.scanText && MCP_RISKY_TOOL_RE.test(tool)) {
    return 'unknown MCP tool carries filesystem-scan intent';
  }
  return null;
}

// The live hook command is generated by PAC and carries the three exact
// CodeGraph names above.  Treat `approvedMcpTools` as an assertion of that
// immutable set, never as a runtime extension point: an edited hook or a
// caller-supplied option must not be able to mint a new provider allowance.
function approvedMcpTools(options = {}) {
  const requested = options.approvedMcpTools;
  if (requested === undefined) return new Set(DEFAULT_APPROVED_MCP_TOOLS);
  if (!Array.isArray(requested) || requested.some((tool) => !DEFAULT_APPROVED_MCP_TOOLS.includes(tool))) return new Set();
  return new Set(DEFAULT_APPROVED_MCP_TOOLS);
}

function contextSearchInputError(input, cwd, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'ctx_search input must be an object';
  const allowed = new Set(['queries', 'query', 'limit', 'source', 'contentType', 'sort', 'project']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return 'ctx_search contains an unsupported field';
  let queries = input.queries;
  if (typeof queries === 'string') {
    if (queries.length > CONTEXT_SEARCH_MAX_QUERY_BYTES * CONTEXT_SEARCH_MAX_QUERIES) return 'ctx_search query payload is too large';
    try { queries = JSON.parse(queries); } catch { queries = [queries]; }
  }
  if (queries !== undefined && (!Array.isArray(queries) || queries.length < 1 || queries.length > CONTEXT_SEARCH_MAX_QUERIES ||
      queries.some((query) => typeof query !== 'string' || query.length > CONTEXT_SEARCH_MAX_QUERY_BYTES || query.includes('\0')))) {
    return 'ctx_search queries exceed the bounded grammar';
  }
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > CONTEXT_SEARCH_MAX_QUERY_BYTES || input.query.includes('\0'))) {
    return 'ctx_search query exceeds the bounded grammar';
  }
  if (input.limit !== undefined && (!Number.isInteger(Number(input.limit)) || Number(input.limit) < 1 || Number(input.limit) > CONTEXT_SEARCH_MAX_RESULTS)) {
    return 'ctx_search limit exceeds the result cap';
  }
  for (const key of ['source', 'project']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256 || input[key].includes('\0'))) {
      return `ctx_search ${key} is outside the bounded grammar`;
    }
  }
  if (input.source !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(String(input.source))) {
    return 'ctx_search source must be a short non-path scope label';
  }
  if (input.project !== undefined) {
    const project = String(input.project);
    if (project === 'global') return null;
    const cwdInfo = safeCwd(cwd, options.home || process.env.HOME);
    const loaded = cwdInfo ? registryRoots(options, options.home || process.env.HOME) : { roots: [] };
    const registered = loaded.roots || [];
    const byId = registered.find((root) => root.id === project && !root.synced);
    const absolute = path.isAbsolute(project) ? path.resolve(project) : null;
    const byPath = absolute && registered.find((root) => root.absolute === absolute && !root.synced);
    if (!byId && !byPath) return 'ctx_search project must be global or an explicitly registered local root';
    if (cwdInfo && !registeredWorkspace(cwdInfo, { ...options, _registeredRootInfo: loaded }, options.home || process.env.HOME).root) {
      return 'ctx_search project is unavailable from the current verified workspace';
    }
  }
  if (input.contentType !== undefined && !['code', 'prose'].includes(input.contentType)) return 'ctx_search contentType is invalid';
  if (input.sort !== undefined && !['relevance', 'timeline'].includes(input.sort)) return 'ctx_search sort is invalid';
  return null;
}

function toolCommands(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { commands: [], error: 'tool input must be an object' };
  const direct = DIRECT_COMMAND_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  const hasArgv = Object.prototype.hasOwnProperty.call(input, 'argv');
  const hasBatch = Object.prototype.hasOwnProperty.call(input, 'commands');
  const hasArgs = Object.prototype.hasOwnProperty.call(input, 'args') ||
    Object.prototype.hasOwnProperty.call(input, 'arguments');
  if (direct.length > 1 || (direct.length && (hasArgv || hasBatch || hasArgs)) ||
      (hasArgv && (hasBatch || hasArgs)) || (hasBatch && hasArgs)) {
    return { commands: [], error: 'tool input contains conflicting command shapes' };
  }
  if (direct.length) {
    const value = input[direct[0]];
    return typeof value === 'string' && value.trim() !== ''
      ? { commands: [value] } : { commands: [], error: `${direct[0]} must be a non-empty string` };
  }
  if (hasArgv) {
    if (!Array.isArray(input.argv) || !input.argv.length || !input.argv.every((value) => typeof value === 'string' && value !== '')) {
      return { commands: [], error: 'argv must be a non-empty string array' };
    }
    return { commands: [input.argv.map((value) => quotePosix(value)).join(' ')] };
  }
  if (hasBatch) {
    if (!Array.isArray(input.commands) || !input.commands.length) return { commands: [], error: 'commands must be a non-empty array' };
    const commands = [];
    for (const item of input.commands) {
      if (typeof item === 'string' && item.trim() !== '') commands.push(item);
      else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const nested = toolCommands(item);
        if (nested.error || nested.commands.length !== 1) return { commands: [], error: nested.error || 'batch item has an ambiguous command shape' };
        commands.push(nested.commands[0]);
      } else return { commands: [], error: 'batch item must be a non-empty string or command object' };
    }
    return { commands };
  }
  return { commands: [] };
}

function denyResponse(reason) {
  const message = `PAC scan guard: ${reason}. Use workspace-locator/CodeGraph; if the index is unavailable, run one explicit-root query through resource-guard with --max-depth ${MAX_DEPTH} and a small output/read cap.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  };
}

export function hookDecision(payload, options = {}) {
  const tool = String(payload?.tool_name || payload?.tool || payload?.name || '');
  const cwd = payload?.cwd || payload?.projectDir || process.cwd();
  const input = payload?.tool_input || payload?.input || payload;
  const knownShellTool = KNOWN_SHELL_TOOL_RE.test(tool);
  const contextIndexTool = CONTEXT_INDEX_TOOL_RE.test(tool);
  const contextSearchTool = CONTEXT_SEARCH_TOOL_RE.test(tool);
  const contextExecuteTool = CONTEXT_EXECUTE_TOOL_RE.test(tool);
  // Context-mode execution is an arbitrary-code surface, not a shell argv.
  // Lexical inspection cannot constrain child_process, dynamic imports, or
  // encoded code, so it is never an allowed fallback for filesystem work.
  if (contextExecuteTool) {
    const response = denyResponse('context-mode execution is disabled; use the PAC fixed-argv resource/index broker');
    return { blocked: true, executable: 'context-mode', reason: 'context-mode execute tools require the PAC broker', response };
  }
  // context-mode's index/fetch tools can accept an absolute path and perform
  // their own recursive walk. They are intentionally not an agent-side
  // fallback; the PAC locator/resource broker owns index refreshes.
  if (contextIndexTool) {
    const response = denyResponse('context-mode index/fetch is disabled for agent calls; use the PAC workspace-locator index broker');
    return { blocked: true, executable: 'context-mode', reason: 'context-mode index/fetch must use the PAC workspace-locator broker', response };
  }
  if (contextSearchTool) {
    const reason = contextSearchInputError(input, cwd, options);
    if (reason) {
      const response = denyResponse(reason);
      return { blocked: true, executable: 'context-mode', reason, response };
    }
  }
  const native = nativeToolInput(tool, input, cwd);
  if (native.handled) {
    if (!native.error) return null;
    const response = denyResponse(native.error);
    return { blocked: true, executable: 'native-tool', reason: native.error, response };
  }
  const unknownMcpReason = unknownMcpFinding(tool, input, options, cwd);
  if (unknownMcpReason) {
    const response = denyResponse(unknownMcpReason);
    return { blocked: true, executable: 'mcp', reason: unknownMcpReason, response };
  }
  // Third-party hosts do not consistently use the `mcp__...` naming form.
  // Before treating an unknown tool as harmless, inspect a bounded recursive
  // signal view of its payload.  Nested `params.command`, `request.argv`,
  // `options.shellCommand`, or filesystem/scan fields are still an execution
  // surface; allowing them merely because the top-level key is `payload`
  // would let a future shell-capable tool bypass this hook.
  const approvedMcpTool = /^mcp__/iu.test(tool) && approvedMcpTools(options).has(tool);
  if (!knownShellTool && !contextSearchTool && !approvedMcpTool && !commandShapePresent(input)) {
    const reason = 'unknown tool is denied by default; add an explicit PAC native schema or broker route';
    const response = denyResponse(reason);
    return { blocked: true, executable: 'tool', reason, response };
  }
  if (contextSearchTool && !commandShapePresent(input)) return null;
  const parsed = toolCommands(input);
  if (parsed.error || !parsed.commands.length) {
    // A recognized shell surface, or an unknown tool carrying a command-like
    // field, is fail-closed when its payload cannot be represented exactly.
    if (!knownShellTool && !commandShapePresent(input)) return null;
    const reason = parsed.error || 'shell tool payload has no explicit command';
    const response = denyResponse(reason);
    return { blocked: true, executable: 'shell', reason, response };
  }
  for (const command of parsed.commands) {
    const finding = inspectCommand(command, cwd, options);
    if (finding) return { ...finding, response: denyResponse(finding.reason) };
  }
  return null;
}

export function hookFailure(reason) {
  return denyResponse(`hook failed closed (${reason})`);
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('hook payload exceeds 2 MiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function cliOptions(argv) {
  const options = {
    home: process.env.HOME, registryPath: undefined, registrySha256: undefined, runtimePath: undefined,
    trustedExecutables: [], trustedDigests: {}, trustedLauncher: undefined,
    trustedLauncherDigest: undefined, expectedPolicyDigest: undefined,
    approvedMcpTools: [],
  };
  let host = null;
  const requireValue = (token, index) => {
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) throw new Error(`${token} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--host') { host = requireValue(token, index); index += 1; }
    else if (token === '--home') { options.home = requireValue(token, index); index += 1; }
    else if (token === '--registry') { options.registryPath = requireValue(token, index); index += 1; }
    else if (token === '--registry-sha256') { options.registrySha256 = requireValue(token, index); index += 1; }
    else if (token === '--runtime') { options.runtimePath = requireValue(token, index); index += 1; }
    else if (token === '--launcher') { options.trustedLauncher = requireValue(token, index); index += 1; }
    else if (token === '--launcher-sha256') { options.trustedLauncherDigest = requireValue(token, index); index += 1; }
    else if (token === '--policy-sha256') { options.expectedPolicyDigest = requireValue(token, index); index += 1; }
    else if (token === '--approved-mcp-tool') {
      const value = requireValue(token, index);
      if (!DEFAULT_APPROVED_MCP_TOOLS.includes(value)) throw new Error('approved MCP tool is not in the immutable PAC allowlist');
      if (options.approvedMcpTools.includes(value)) throw new Error('approved MCP tool is duplicated');
      options.approvedMcpTools.push(value); index += 1;
    }
    else if (token === '--trusted-resource-guard' || token === '--trusted-locator') {
      const value = requireValue(token, index); index += 1;
      options.trustedExecutables.push(value);
      const digestFlag = token === '--trusted-resource-guard'
        ? '--trusted-resource-guard-sha256' : '--trusted-locator-sha256';
      const next = argv[index + 1];
      if (next === digestFlag) {
        const digestValue = requireValue(digestFlag, index + 1);
        options.trustedDigests[commandName(value)] = digestValue; index += 2;
      }
    } else if (token === '--trusted-resource-guard-sha256' || token === '--trusted-locator-sha256') {
      const value = requireValue(token, index); index += 1;
      const base = token.includes('resource-guard') ? 'resource-guard.mjs' : 'locator.mjs';
      options.trustedDigests[base] = value;
    } else if (token === '--marker') {
      if (argv[index + 1] !== SCAN_GUARD_MARKER) throw new Error('scan-guard marker is invalid');
      index += 1;
    }
    else if (token === '--hook') { /* marker for the host adapter */ }
    else throw new Error(`unknown hook option: ${token}`);
  }
  if (!host || !['codex', 'claude'].includes(host)) throw new Error('host must be codex or claude');
  if (options.trustedExecutables.some((value) => typeof value !== 'string' || !value)) throw new Error('trusted executable is missing');
  if (options.trustedLauncher && !path.isAbsolute(options.trustedLauncher)) throw new Error('trusted launcher must be absolute');
  for (const value of [options.registrySha256, options.trustedLauncherDigest, options.expectedPolicyDigest, ...Object.values(options.trustedDigests)]) {
    if (value !== undefined && !/^[0-9a-f]{64}$/u.test(String(value))) throw new Error('trusted digest is invalid');
  }
  return { host, options };
}

async function runHookCli() {
  const { host, options } = cliOptions(process.argv.slice(2));
  // A live host hook must carry the complete binding tuple.  Pure policy
  // consumers may call hookDecision() with an explicit test fixture, but the
  // stdin entry point is an authority boundary and fails closed on any
  // missing registry/policy/launcher/helper pin.
  if (!options.registrySha256 || !options.trustedLauncherDigest || !options.expectedPolicyDigest ||
      !options.trustedDigests['resource-guard.mjs'] || !options.trustedDigests['locator.mjs']) {
    process.stdout.write(`${JSON.stringify(hookFailure('scan-guard trust digests are incomplete'))}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.expectedPolicyDigest && secureFileDigest(fileURLToPath(import.meta.url)) !== options.expectedPolicyDigest) {
    process.stdout.write(`${JSON.stringify(hookFailure('staged scan policy digest does not match PAC state'))}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.trustedLauncherDigest && secureFileDigest(options.trustedLauncher) !== options.trustedLauncherDigest) {
    process.stdout.write(`${JSON.stringify(hookFailure('PAC launcher digest does not match PAC state'))}\n`);
    process.exitCode = 2;
    return;
  }
  let payload;
  try { payload = JSON.parse(await readStdin()); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(hookFailure(`invalid hook payload: ${error.message}`))}\n`);
    process.exitCode = 2;
    return;
  }
  const finding = hookDecision(payload, options);
  if (finding) process.stdout.write(`${JSON.stringify(finding.response)}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  try { await runHookCli(); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(hookFailure(error.message))}\n`);
    process.exitCode = 2;
  }
}
