#!/bin/sh
set -eu

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pac-install-test.XXXXXX")
tmp=$(unset CDPATH; cd -- "$tmp" && pwd -P)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
source="$tmp/source"
fixture_bin="$tmp/bin"
fixture_ppt="$tmp/ppt-master.SKILL.md"
PAC_TEST_REAL_GIT=$(command -v git)
export PAC_TEST_REAL_GIT
mkdir -p "$source" "$fixture_bin"
cp -Rp "$repo/." "$source/"

cat > "$fixture_ppt" <<'EOF'
---
name: ppt-master
description: Isolated PAC materializer fixture.
---
# PPT fixture
EOF
node - "$source/src/materializers.mjs" "$fixture_ppt" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [file, fixture] = process.argv.slice(2);
const hash = crypto.createHash('sha256');
hash.update('file'); hash.update('\0'); hash.update('SKILL.md'); hash.update('\0');
hash.update('-'); hash.update('\0'); hash.update(fs.readFileSync(fixture)); hash.update('\0');
const digest = hash.digest('hex');
const text = fs.readFileSync(file, 'utf8').replace(
  /contentSha256: '[0-9a-f]{64}'/u,
  `contentSha256: '${digest}'`,
);
fs.writeFileSync(file, text);
NODE

cat > "$fixture_bin/apm" <<'NODE'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.PAC_TEST_APM_LOG) fs.appendFileSync(process.env.PAC_TEST_APM_LOG, `${args.join(' ')}\n`);
if (args[0] === '--version') {
  console.log('Agent Package Manager (APM) CLI version 0.28.0 (fixture)');
  process.exit(0);
}
if (args[0] === 'lock' && args[1] === 'export') {
  JSON.parse('{}');
  console.log('{"bomFormat":"CycloneDX"}');
  process.exit(0);
}
if (args[0] === 'audit') {
  process.exit(process.env.PAC_TEST_AUDIT_FAIL === '1' ? 41 : 0);
}

const scalar = (value) => JSON.stringify(value);
function manifestRefs() {
  const lines = fs.readFileSync(path.join(process.cwd(), 'apm.yml'), 'utf8').split(/\r?\n/u);
  const start = lines.findIndex((line) => /^  apm:\s*$/u.test(line));
  const end = lines.findIndex((line, index) => index > start && /^  mcp:/u.test(line));
  return lines.slice(start + 1, end).map((line) => line.match(/^    -\s+(.+)$/u)?.[1])
    .filter(Boolean).map((value) => value.startsWith('"') ? JSON.parse(value) : value);
}
function oldNames() {
  const file = path.join(process.cwd(), 'apm.lock.yaml');
  if (!fs.existsSync(file)) return new Map();
  const text = fs.readFileSync(file, 'utf8').split(/^deployments:\s*$/mu)[0];
  const map = new Map();
  for (const block of text.split(/^-(?=\s+repo_url:)/mu).slice(1)) {
    const field = (name) => block.match(new RegExp(`^  ${name}:\\s*(.+)$`, 'mu'))?.[1]?.replace(/^['"]|['"]$/gu, '');
    const repo = field('repo_url');
    const virtual = field('virtual_path');
    const local = field('local_path');
    const name = field('name');
    if (name) map.set(local ? `local:${local}` : `${repo}/${virtual || ''}`, name);
  }
  return map;
}
function record(ref, names) {
  if (/^(?:\.\.?\/|\/)/u.test(ref)) {
    const absolute = path.resolve(process.cwd(), ref);
    const skill = fs.readFileSync(path.join(absolute, 'SKILL.md'), 'utf8');
    const name = skill.match(/^name:\s*['"]?([^'"\s]+)['"]?\s*$/mu)?.[1] || path.basename(absolute);
    return { repo: `_local/${name}`, name, local: ref };
  }
  const [withoutHash, commit = '1111111111111111111111111111111111111111'] = ref.split('#');
  const parts = withoutHash.replace(/^https:\/\/github\.com\//u, '').split('/');
  const repo = parts.slice(0, 2).join('/');
  const virtual = parts.slice(2).join('/');
  const key = `${repo}/${virtual}`;
  const fallback = path.basename(virtual || repo);
  const aliases = { 'composition-patterns': 'vercel-composition-patterns', 'react-best-practices': 'vercel-react-best-practices' };
  return { repo, name: names.get(key) || aliases[fallback] || fallback, virtual, commit };
}
function writeLock(updated = false) {
  const names = oldNames();
  const records = manifestRefs().map((ref) => record(ref, names));
  const lines = [
    "lockfile_version: '1'",
    "generated_at: '2026-01-01T00:00:00Z'",
    'apm_version: 0.28.0',
    'dependencies:',
  ];
  for (const item of records) {
    lines.push(`- repo_url: ${scalar(item.repo)}`, `  name: ${scalar(item.name)}`);
    if (item.local) lines.push(`  local_path: ${scalar(item.local)}`);
    else lines.push(
      `  resolved_commit: ${scalar(item.commit)}`,
      `  virtual_path: ${scalar(item.virtual)}`,
      `  content_hash: ${scalar(`sha256:${'1'.repeat(64)}`)}`,
    );
  }
  if (updated) lines.push('# fixture-update');
  lines.push('deployments: []', '');
  fs.writeFileSync(path.join(process.cwd(), 'apm.lock.yaml'), lines.join('\n'));
  const modules = path.join(process.cwd(), 'apm_modules');
  fs.rmSync(modules, { recursive: true, force: true });
  for (const item of records) {
    const target = path.join(modules, item.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (item.local) fs.cpSync(path.resolve(process.cwd(), item.local), target, { recursive: true });
    else {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'),
        `---\nname: ${item.name}\ndescription: Isolated staged APM fixture.\n---\n`);
    }
  }
}

if (args[0] === 'lock') {
  writeLock(false);
  process.exit(0);
}
if (args[0] === 'update') {
  writeLock(true);
  process.exit(0);
}
if (args[0] !== 'install') process.exit(2);
const root = args[args.indexOf('--root') + 1];
if (!root) process.exit(2);
const lockFile = path.join(process.cwd(), 'apm.lock.yaml');
if (!fs.existsSync(lockFile)) process.exit(3);
if (args.includes('--dry-run')) process.exit(0);
const text = fs.readFileSync(lockFile, 'utf8').split(/^deployments:\s*$/mu)[0];
const desired = new Set();
for (const block of text.split(/^-(?=\s+repo_url:)/mu).slice(1)) {
  const field = (name) => block.match(new RegExp(`^  ${name}:\\s*(.+)$`, 'mu'))?.[1]?.replace(/^['"]|['"]$/gu, '');
  const name = field('name');
  const local = field('local_path');
  const virtual = field('virtual_path');
  const physical = path.basename(local || virtual || name);
  desired.add(physical);
  const target = path.join(root, '.agents/skills', physical);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (local) fs.cpSync(path.resolve(process.cwd(), local), target, { recursive: true });
  else {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated APM fixture.\n---\n# ${name}\n`);
  }
}
const skills = path.join(root, '.agents/skills');
if (fs.existsSync(skills)) {
  for (const name of fs.readdirSync(skills)) {
    if (name !== 'ppt-master' && !desired.has(name)) fs.rmSync(path.join(skills, name), { recursive: true, force: true });
  }
}
fs.mkdirSync(path.join(root, 'apm_modules'), { recursive: true });
fs.writeFileSync(path.join(root, 'apm_modules/fixture'), 'resolved\n');
const deployed = [];
function collect(absolute) {
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) collect(child);
    else if (entry.isFile()) {
      const relative = path.relative(root, child).split(path.sep).join('/');
      const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(child)).digest('hex');
      deployed.push(`    ${relative}: sha256:${digest}`);
    } else {
      throw new Error(`unsupported fixture entry: ${child}`);
    }
  }
}
for (const physical of [...desired].sort()) collect(path.join(skills, physical));
const canonical = fs.readFileSync(lockFile, 'utf8').split(/^deployments:\s*.*$/mu)[0].trimEnd();
fs.writeFileSync(
  path.join(root, 'apm.lock.yaml'),
  `${canonical}\ndeployments:\n  fixture:\n${deployed.join('\n')}\n`,
);
if (process.env.PAC_TEST_APM_FAIL === '1') process.exit(42);
NODE

cat > "$fixture_bin/skills" <<'SH'
#!/bin/sh
set -eu
target="$HOME/.agents/skills/ppt-master"
rm -rf -- "$target"
mkdir -p "$target"
cp "$PAC_TEST_PPT_FIXTURE" "$target/SKILL.md"
SH

cat > "$fixture_bin/git" <<'SH'
#!/bin/sh
set -eu
if [ "${1:-}" = ls-remote ]; then
    printf '%s\t%s\n' \
        '51cb529d00638097e70fd3e9d865a0bf061b5e19' \
        'refs/tags/v4.3.0'
    exit 0
fi
case "${1:-}:${2:-}:${3:-}" in
init:*:*/ppt-master|-C:*/ppt-master:*) materializer=1 ;;
*) materializer=0 ;;
esac
if [ "${1:-}" = init ] && [ "$materializer" = 1 ]; then
    mkdir -p "$3"
    exit 0
fi
if [ "${1:-}" = -C ] && [ "$materializer" = 1 ]; then
    checkout=$2
    case "${3:-}" in
        remote|checkout) exit 0 ;;
        fetch)
            mkdir -p "$checkout/skills/ppt-master"
            cp "$PAC_TEST_PPT_FIXTURE" "$checkout/skills/ppt-master/SKILL.md"
            exit 0
            ;;
        rev-parse)
            printf '%s\n' '51cb529d00638097e70fd3e9d865a0bf061b5e19'
            exit 0
            ;;
    esac
fi
exec "$PAC_TEST_REAL_GIT" "$@"
SH

cat > "$fixture_bin/plugin-reconciler" <<'NODE'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const mode = args.shift();
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) process.exit(2);
  return args[index + 1];
};
const home = value('--home');
const catalog = value('--catalog');
const rows = fs.readFileSync(catalog, 'utf8').split(/\r?\n/u)
  .filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));
const expected = rows.map((fields) => fields[0]).sort().join('\n') + (rows.length ? '\n' : '');
const state = path.join(home, '.claude/plugins/installed_plugins.json');
fs.mkdirSync(path.dirname(state), { recursive: true });
if (process.env.PAC_TEST_PLUGIN_LOG) fs.appendFileSync(process.env.PAC_TEST_PLUGIN_LOG, `${mode}\n`);

if (mode === 'apply') {
  fs.writeFileSync(state, expected);
  for (const fields of rows) {
    const [plugin, marketplace] = fields;
    for (const skill of fields[9].split(',').filter(Boolean)) {
      const directory = path.join(
        home, '.local/share/agent-plugins/sources', marketplace,
        'plugins', plugin, 'skills', skill,
      );
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: Isolated Plugin Skill fixture.\n---\n`);
    }
  }
  if (process.env.PAC_TEST_PLUGIN_FAIL === '1') process.exit(43);
} else if (mode === 'check') {
  if (!fs.existsSync(state) || fs.readFileSync(state, 'utf8') !== expected) process.exit(1);
} else process.exit(2);
NODE

cat > "$fixture_bin/doctor" <<'SH'
#!/bin/sh
exit 0
SH
cat > "$fixture_bin/mise" <<'SH'
#!/bin/sh
set -eu
[ "${1:-}" = --cd ] || exit 2
cd "$2"
shift 2
case "${1:-}" in
    trust|install) exit 0 ;;
    exec)
        shift
        [ "${1:-}" = -- ] || exit 2
        shift
        if [ "${1:-}" = node ]; then
            shift
            exec "$PAC_TEST_NODE" "$@"
        fi
        if [ -n "${PAC_ROOT:-}" ] && [ "${1:-}" = "$PAC_ROOT/scripts/doctor.sh" ]; then
            exec "$PAC_DOCTOR" "$@"
        fi
        exec "$@"
        ;;
    *) exit 2 ;;
esac
SH
chmod 755 "$fixture_bin"/*

export PATH="$fixture_bin:$PATH"
export PAC_ROOT="$source"
export PAC_APM="$fixture_bin/apm"
export PAC_SKILLS="$fixture_bin/skills"
export PAC_PLUGIN_RECONCILER="$fixture_bin/plugin-reconciler"
export PAC_DOCTOR="$fixture_bin/doctor"
export PAC_TEST_PPT_FIXTURE="$fixture_ppt"
export PAC_TEST_APM_LOG="$tmp/apm.log"
export PAC_TEST_PLUGIN_LOG="$tmp/plugin.log"
export PAC_TEST_NODE
PAC_TEST_NODE=$(command -v node)
export PAC_TEST_CHEZMOI
PAC_TEST_CHEZMOI=${CHEZMOI_BIN:-$(command -v chezmoi)}

run_pac() {
    run_home=$1
    shift
    HOME="$run_home" PAC_HOST_ADAPTER_MODE=skip \
        "$source/bin/pac" --home "$run_home" "$@"
}

run_pac_adapter() {
    run_home=$1
    shift
    HOME="$run_home" PAC_HOST_ADAPTER_MODE=reconcile \
        PAC_NO_PLUGINS=1 PAC_NO_RESOLVER=1 \
        "$source/bin/pac" --home "$run_home" "$@"
}

prepare_home() {
    target=$1
    mkdir -p "$target/.local/bin"
    ln -s "$source/bin/pac" "$target/.local/bin/pac"
    ln -s "$fixture_bin/mise" "$target/.local/bin/mise"
    ln -s "$PAC_TEST_CHEZMOI" "$target/.local/bin/chezmoi"
}

assert_status() {
    target=$1 hosts=$2
    run_pac "$target" --json --hosts "$hosts" status > "$tmp/status.json"
    node - "$tmp/status.json" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value.ok || !value.data?.ok) process.exit(1);
if (!value.data.runtimeLock.matchesCanonical) process.exit(1);
if (value.data.projections.some((entry) => !entry.valid)) process.exit(1);
if (value.data.materializerExceptions.some((entry) => !entry.valid)) process.exit(1);
if (!value.data.plugins.valid) process.exit(1);
NODE
}

managed_digest() {
    "$PAC_TEST_NODE" "$source/tests/portable-fs.mjs" managed-digest "$1"
}

file_digest() {
    "$PAC_TEST_NODE" "$source/tests/portable-fs.mjs" sha256 "$1"
}

link_count() {
    "$PAC_TEST_NODE" "$source/tests/portable-fs.mjs" link-count "$1"
}

# The PAC executable can add and retire complete host adapters after bootstrap;
# the versioned source registry remains unchanged.
adapter_home="$tmp/host-adapter-lifecycle"
prepare_home "$adapter_home"
mkdir -p "$adapter_home/.config/personal-agent-control"
cat > "$adapter_home/.config/personal-agent-control/chezmoi.toml" <<EOF
cacheDir = "$adapter_home/.config/personal-agent-control/cache"
persistentState = "$adapter_home/.config/personal-agent-control/state.boltdb"
umask = 63

[data.pac]
agents = "codex"
codex = true
claude = false
EOF
source_config_before=$(file_digest "$source/pac.json")
run_pac_adapter "$adapter_home" --hosts codex install codex >/dev/null
cmp -s "$source/generated/codex/AGENTS.md" "$adapter_home/.codex/AGENTS.md"
cmp -s "$source/generated/codex/agents/independent-reviewer.toml" \
    "$adapter_home/.codex/agents/independent-reviewer.toml"
[ ! -e "$adapter_home/.claude/CLAUDE.md" ]
run_pac_adapter "$adapter_home" --hosts claude host enable claude >/dev/null
cmp -s "$source/generated/claude/CLAUDE.md" "$adapter_home/.claude/CLAUDE.md"
run_pac_adapter "$adapter_home" --hosts codex host disable codex >/dev/null
[ ! -e "$adapter_home/.codex/AGENTS.md" ]
[ ! -e "$adapter_home/.codex/agents/independent-reviewer.toml" ]
cmp -s "$source/generated/claude/CLAUDE.md" "$adapter_home/.claude/CLAUDE.md"
[ "$(file_digest "$source/pac.json")" = "$source_config_before" ]
if ! run_pac_adapter "$adapter_home" --json --hosts all status \
    > "$tmp/host-adapter-status.json"; then
    cat "$tmp/host-adapter-status.json" >&2
    exit 1
fi
node - "$tmp/host-adapter-status.json" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value.ok || !value.data?.ok) process.exit(1);
if (value.data.adapters.some((entry) => !entry.valid)) process.exit(1);
NODE

# Fresh both-host install and idempotence.
home="$tmp/home"
prepare_home "$home"
HOME="$home" PATH="$home/.local/bin" "$home/.local/bin/pac" --help > "$tmp/clean-path-help.txt"
grep -q '^Usage: pac ' "$tmp/clean-path-help.txt"
if ! run_pac "$home" --json --hosts all apply > "$tmp/fresh.json"; then
    cat "$tmp/fresh.json" >&2
    exit 1
fi
assert_status "$home" all
owned_count=$(wc -l < "$home/.local/state/personal-agent-control/owned-skills.txt" | tr -d ' ')
[ "$owned_count" = 2 ]
[ "$(link_count "$home/.agents/skills")" = "$owned_count" ]
[ "$(link_count "$home/.claude/skills")" = "$owned_count" ]
[ "$(basename -- "$(readlink "$home/.agents/skills/capability-resolver")")" = capability-resolver ]
before=$(managed_digest "$home")
run_pac "$home" --hosts all apply >/dev/null
after=$(managed_digest "$home")
[ "$before" = "$after" ]

# Either host may be installed first; disabled-host user content is untouched.
for first in codex claude; do
    order_home="$tmp/$first-first"
    prepare_home "$order_home"
    if [ "$first" = codex ]; then other=claude; else other=codex; fi
    mkdir -p "$order_home/.$other/skills/user-private"
    printf 'preserve-%s\n' "$other" > "$order_home/.$other/skills/user-private/sentinel"
    run_pac "$order_home" --hosts "$first" apply >/dev/null
    [ -f "$order_home/.$other/skills/user-private/sentinel" ]
    assert_status "$order_home" "$first"
    run_pac "$order_home" --hosts all apply >/dev/null
    [ -f "$order_home/.$other/skills/user-private/sentinel" ]
    assert_status "$order_home" all
done

# An unmanaged collision blocks apply and rollback preserves it byte-for-byte.
collision_home="$tmp/collision"
prepare_home "$collision_home"
mkdir -p "$collision_home/.agents/skills/capability-resolver"
printf 'unmanaged\n' > "$collision_home/.agents/skills/capability-resolver/sentinel"
if run_pac "$collision_home" --hosts all apply > "$tmp/collision.out" 2>&1; then
    echo "PAC accepted an unmanaged Skill collision" >&2
    exit 1
fi
grep -q '^unmanaged$' "$collision_home/.agents/skills/capability-resolver/sentinel"
[ ! -L "$collision_home/.agents/skills/capability-resolver" ]

# Replacing a managed projection with user content is also preserved on failure.
modified_home="$tmp/modified"
prepare_home "$modified_home"
run_pac "$modified_home" --hosts all apply >/dev/null
rm -f -- "$modified_home/.agents/skills/capability-resolver"
mkdir -p "$modified_home/.agents/skills/capability-resolver"
printf 'modified-user-content\n' > "$modified_home/.agents/skills/capability-resolver/sentinel"
if run_pac "$modified_home" --hosts all apply > "$tmp/modified.out" 2>&1; then
    echo "PAC overwrote a modified managed projection" >&2
    exit 1
fi
grep -q '^modified-user-content$' "$modified_home/.agents/skills/capability-resolver/sentinel"

# Skill and Plugin lifecycle operations mutate the editable private Profile,
# while the disposable public Core remains byte-for-byte unchanged.
lifecycle_home="$tmp/lifecycle"
prepare_home "$lifecycle_home"
run_pac "$lifecycle_home" --hosts all apply >/dev/null
core_manifest_before=$(file_digest "$source/packages/skills/apm.yml")
core_config_before=$(file_digest "$source/pac.json")
profile_root="$lifecycle_home/.local/share/personal-agent-profile-workspaces/default"
run_pac "$lifecycle_home" --hosts all profile init "$profile_root" >/dev/null
[ -d "$profile_root/.git" ]
[ -f "$profile_root/pac-profile.json" ]
[ -f "$profile_root/packages/skills/apm.yml" ]
cat > "$profile_root/catalog/plugins.tsv" <<'EOF'
# plugin	marketplace	acquisition	source	ref	resolved-commit	tree-id	version	targets	bundled-skills	license	visibility
context-mode	context-mode	github-tag	example/context-mode	v1.0.0	cccccccccccccccccccccccccccccccccccccccc	dddddddddddddddddddddddddddddddddddddddd	1.0.0	codex,claude	context-mode	MIT	private
EOF
cat > "$profile_root/catalog/capabilities.jsonl" <<'EOF'
{"id":"provider:plugin:context-mode@context-mode","memberships":["kind.provider.plugin"],"summary":"Isolated context-mode provider fixture."}
{"id":"skill:context-mode","memberships":["kind.skill"],"summary":"Isolated context-mode bundled Skill fixture."}
EOF
node - "$profile_root/pac-profile.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.plugins.enabled = ['context-mode'];
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
run_pac "$lifecycle_home" --hosts all profile init "$profile_root" >/dev/null
printf 'module-before-change\n' > "$lifecycle_home/.local/share/agent-skills/apm_modules/fixture"
run_pac "$lifecycle_home" --json --hosts all skill add \
    acme/demo-skill/skills/demo-skill#1111111111111111111111111111111111111111 \
    > "$tmp/add.json"
grep -q 'acme/demo-skill/skills/demo-skill#1111111111111111111111111111111111111111' \
    "$profile_root/packages/skills/apm.yml"
grep -q '"id":"skill:demo-skill"' "$profile_root/catalog/capabilities.jsonl"
grep -q '^demo-skill$' "$lifecycle_home/.local/state/personal-agent-control/owned-skills.txt"
[ -L "$lifecycle_home/.agents/skills/demo-skill" ]
add_backup=$(node -e "const x=require('$tmp/add.json'); process.stdout.write(x.data.backup)" 2>/dev/null || true)
run_pac "$lifecycle_home" --hosts all skill update demo-skill >/dev/null
grep -q '^update ' "$PAC_TEST_APM_LOG"
run_pac "$lifecycle_home" --json --hosts all plugin remove context-mode > "$tmp/plugin-remove.json"
plugin_backup=$(node -e "const x=require('$tmp/plugin-remove.json'); process.stdout.write(x.data.backup)")
grep -q '"context-mode"' "$profile_root/pac-profile.json"
if grep -q '^context-mode$' "$lifecycle_home/.claude/plugins/installed_plugins.json"; then
    echo "Plugin removal did not converge" >&2
    exit 1
fi
run_pac "$lifecycle_home" rollback "$plugin_backup" >/dev/null
grep -q '^context-mode$' "$lifecycle_home/.claude/plugins/installed_plugins.json"
run_pac "$lifecycle_home" --hosts all plugin remove context-mode >/dev/null
run_pac "$lifecycle_home" --hosts all plugin add context-mode >/dev/null
grep -q '^context-mode$' "$lifecycle_home/.claude/plugins/installed_plugins.json"
run_pac "$lifecycle_home" --hosts all plugin update context-mode >/dev/null
run_pac "$lifecycle_home" --hosts all skill remove demo-skill >/dev/null
[ ! -e "$lifecycle_home/.agents/skills/demo-skill" ]

# A successful change can roll the active Profile and derived runtime back while
# retaining the editable workspace history for a later explicit sync/retry.
[ -n "$add_backup" ] || {
    run_pac "$lifecycle_home" --json --hosts all skill add \
        acme/rollback-skill/skills/rollback-skill#2222222222222222222222222222222222222222 \
        > "$tmp/rollback-add.json"
    add_backup=$(node -e "const x=require('$tmp/rollback-add.json'); process.stdout.write(x.data.backup)")
}
run_pac "$lifecycle_home" rollback "$add_backup" >/dev/null
[ "$(file_digest "$source/packages/skills/apm.yml")" = "$core_manifest_before" ]
[ "$(file_digest "$source/pac.json")" = "$core_config_before" ]
grep -q '^module-before-change$' "$lifecycle_home/.local/share/agent-skills/apm_modules/fixture"
assert_status "$lifecycle_home" all

# A late Profile APM failure leaves the active runtime healthy and never mutates
# Core. The editable Profile commit remains available for an explicit repair.
if (export PAC_TEST_APM_FAIL=1; run_pac "$lifecycle_home" --hosts all skill add \
    acme/failing-skill/skills/failing-skill#3333333333333333333333333333333333333333 \
    > "$tmp/failure.out" 2>&1); then
    echo "PAC accepted an injected APM failure" >&2
    exit 1
fi
[ "$(file_digest "$source/packages/skills/apm.yml")" = "$core_manifest_before" ]
[ "$(file_digest "$source/pac.json")" = "$core_config_before" ]
assert_status "$lifecycle_home" all

# Restore rejects a forged traversal path before touching user data.
malicious="$lifecycle_home/.agent-work/backups/personal-agent-control/malicious"
mkdir -p "$malicious/home" "$lifecycle_home/.ssh"
printf '.agents/skills/test/../../../.ssh\n' > "$malicious/managed-paths.txt"
printf 'preserve\n' > "$lifecycle_home/.ssh/sentinel"
if HOME="$lifecycle_home" "$source/scripts/restore-backup.sh" "$malicious" \
    > "$tmp/malicious.out" 2>&1; then
    echo "restore accepted path traversal" >&2
    exit 1
fi
grep -q '^preserve$' "$lifecycle_home/.ssh/sentinel"

# The Chezmoi hook seeds the exact selected host set in canonical order once,
# then preserves an existing machine-local profile byte-for-byte.
chezmoi_bin=$PAC_TEST_CHEZMOI
seed_home="$tmp/machine-seed"
prepare_home "$seed_home"
mkdir -p "$seed_home/.codex/agents" "$seed_home/.claude/agents"
cp "$source/generated/codex/AGENTS.md" "$seed_home/.codex/AGENTS.md"
cp "$source/generated/codex/agents/independent-reviewer.toml" \
    "$seed_home/.codex/agents/independent-reviewer.toml"
cp "$source/generated/claude/CLAUDE.md" "$seed_home/.claude/CLAUDE.md"
cp "$source/generated/claude/agents/independent-reviewer.md" \
    "$seed_home/.claude/agents/independent-reviewer.md"
seed_hook="$tmp/install-after-both.sh"
seed_before_hook="$tmp/install-before-both.sh"
"$chezmoi_bin" --source "$source" --destination "$seed_home" \
    --override-data '{"pac":{"agents":"claude,codex","codex":true,"claude":true}}' \
    --output "$seed_before_hook" execute-template --file \
    "$source/.chezmoiscripts/run_before_10-backup.sh.tmpl"
"$chezmoi_bin" --source "$source" --destination "$seed_home" \
    --override-data '{"pac":{"agents":"claude,codex","codex":true,"claude":true}}' \
    --output "$seed_hook" execute-template --file \
    "$source/.chezmoiscripts/run_after_20-install-tools-and-skills.sh.tmpl"
chmod 755 "$seed_before_hook" "$seed_hook"
HOME="$seed_home" PAC_ROOT="$source" "$seed_before_hook" >/dev/null
HOME="$seed_home" PAC_ROOT="$source" PAC_HOST_ADAPTER_MODE=skip "$seed_hook" >/dev/null
node - "$seed_home/.config/personal-agent-control/machine.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value.schemaVersion !== 1) process.exit(1);
if (JSON.stringify(value.enabledHosts) !== JSON.stringify(['codex', 'claude'])) process.exit(1);
if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(1);
NODE
seed_before=$(file_digest "$seed_home/.config/personal-agent-control/machine.json")
seed_hook_codex="$tmp/install-after-codex.sh"
seed_before_hook_codex="$tmp/install-before-codex.sh"
"$chezmoi_bin" --source "$source" --destination "$seed_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$seed_before_hook_codex" execute-template --file \
    "$source/.chezmoiscripts/run_before_10-backup.sh.tmpl"
"$chezmoi_bin" --source "$source" --destination "$seed_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$seed_hook_codex" execute-template --file \
    "$source/.chezmoiscripts/run_after_20-install-tools-and-skills.sh.tmpl"
chmod 755 "$seed_before_hook_codex" "$seed_hook_codex"
HOME="$seed_home" PAC_ROOT="$source" "$seed_before_hook_codex" >/dev/null
HOME="$seed_home" PAC_ROOT="$source" PAC_HOST_ADAPTER_MODE=skip "$seed_hook_codex" >/dev/null
[ "$(file_digest "$seed_home/.config/personal-agent-control/machine.json")" = "$seed_before" ]

# Transaction rollback restores an existing machine profile exactly.
seed_backup=$(sed -n '1p' "$seed_home/.local/state/personal-agent-control/last-backup")
printf '%s\n' '{"schemaVersion":1,"enabledHosts":["claude"]}' \
    > "$seed_home/.config/personal-agent-control/machine.json"
HOME="$seed_home" "$source/scripts/restore-backup.sh" "$seed_backup" >/dev/null
[ "$(file_digest "$seed_home/.config/personal-agent-control/machine.json")" = "$seed_before" ]

# An inactive host removes only PAC-owned Plugins. Unmanaged Plugins and their
# marketplace remain intact, and a non-empty active catalog stays strict.
native_bin="$tmp/native-plugin-bin"
mkdir -p "$native_bin"
cat > "$native_bin/codex" <<'NODE'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = path.join(process.env.HOME, '.test-native');
const pluginsFile = path.join(state, 'plugins.json');
const marketplacesFile = path.join(state, 'marketplaces.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
if (args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({ marketplaces: read(marketplacesFile) }));
} else if (args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: read(pluginsFile) }));
} else if (args[0] === 'plugin' && args[1] === 'remove') {
  fs.appendFileSync(path.join(state, 'mutations.log'), `${args.join(' ')}\n`);
  write(pluginsFile, read(pluginsFile).filter((entry) => entry.pluginId !== args[2]));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  fs.appendFileSync(path.join(state, 'mutations.log'), `${args.join(' ')}\n`);
  write(marketplacesFile, read(marketplacesFile).filter((entry) => entry.name !== args[3]));
} else {
  console.error(`unexpected codex fixture invocation: ${args.join(' ')}`);
  process.exit(2);
}
NODE
cat > "$native_bin/claude" <<'NODE'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = path.join(process.env.HOME, '.test-native-claude');
const pluginsFile = path.join(state, 'plugins.json');
const marketplacesFile = path.join(state, 'marketplaces.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
if (args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify(read(marketplacesFile)));
} else if (args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify(read(pluginsFile)));
} else if (args[0] === 'plugin' && args[1] === 'uninstall') {
  fs.appendFileSync(path.join(state, 'mutations.log'), `${args.join(' ')}\n`);
  write(pluginsFile, read(pluginsFile).filter((entry) => entry.id !== args[2]));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  fs.appendFileSync(path.join(state, 'mutations.log'), `${args.join(' ')}\n`);
  write(marketplacesFile, read(marketplacesFile).filter((entry) => entry.name !== args[3]));
} else {
  console.error(`unexpected claude fixture invocation: ${args.join(' ')}`);
  process.exit(2);
}
NODE
cat > "$native_bin/git" <<'SH'
#!/bin/sh
set -eu
[ "${1:-}" = -C ] || { echo "unexpected git fixture invocation: $*" >&2; exit 2; }
case "${3:-}" in
    remote) printf '%s\n' "$PAC_TEST_NATIVE_PLUGIN_SOURCE" ;;
    status) ;;
    rev-parse)
        case "${4:-}" in
            HEAD) printf '%s\n' "$PAC_TEST_NATIVE_PLUGIN_COMMIT" ;;
            'HEAD^{tree}') printf '%s\n' "$PAC_TEST_NATIVE_PLUGIN_TREE" ;;
            *) echo "unexpected git rev-parse fixture: ${4:-}" >&2; exit 2 ;;
        esac
        ;;
    *) echo "unexpected git fixture invocation: $*" >&2; exit 2 ;;
esac
SH
chmod 755 "$native_bin"/*

empty_catalog="$tmp/empty-plugins.tsv"
sed -n '1p' "$source/catalog/plugins.tsv" > "$empty_catalog"

# Ownership state is untrusted input: a forged marketplace path must be
# rejected before it can escape the source directory and delete HOME data.
forged_home="$tmp/forged-plugin-ownership"
mkdir -p "$forged_home/.test-native" "$forged_home/.test-native-claude" \
    "$forged_home/.local/state/personal-agent-control" \
    "$forged_home/.local/share/agent-plugins/sources" \
    "$forged_home/.local/share/agent-plugins/sentinel"
printf 'preserve\n' > "$forged_home/.local/share/agent-plugins/sentinel/value"
printf '[]\n' > "$forged_home/.test-native/plugins.json"
printf '[]\n' > "$forged_home/.test-native/marketplaces.json"
printf '[]\n' > "$forged_home/.test-native-claude/plugins.json"
printf '[]\n' > "$forged_home/.test-native-claude/marketplaces.json"
cat > "$forged_home/.local/state/personal-agent-control/owned-plugins.tsv" <<'EOF'
# plugin	marketplace	targets
forged-plugin	../sentinel	codex
EOF
if PATH="$native_bin:$PATH" HOME="$forged_home" \
    "$source/scripts/reconcile-plugins.sh" apply --home "$forged_home" \
    --agents codex --catalog "$empty_catalog" > "$tmp/forged-ownership.out" 2>&1; then
    echo "forged Plugin ownership was accepted" >&2
    exit 1
fi
grep -q '^invalid Plugin ownership marketplace ../sentinel$' "$tmp/forged-ownership.out"
grep -q '^preserve$' "$forged_home/.local/share/agent-plugins/sentinel/value"

inactive_home="$tmp/inactive-plugin-home"
mkdir -p "$inactive_home/.test-native" "$inactive_home/.test-native-claude" \
    "$inactive_home/.local/state/personal-agent-control/migrations" \
    "$inactive_home/.local/share/agent-plugins/sources/context-mode" \
    "$inactive_home/.local/share/agent-plugins/sources/pac-only" \
    "$inactive_home/.local/share/agent-plugins/sources/manual-marketplace"
cat > "$inactive_home/.test-native/plugins.json" <<'JSON'
[
  {"pluginId":"drawio@drawio","marketplaceName":"drawio"},
  {"pluginId":"context-mode@context-mode","marketplaceName":"context-mode"},
  {"pluginId":"pac-only@pac-only","marketplaceName":"pac-only"},
  {"pluginId":"personal-helper@context-mode","marketplaceName":"context-mode"},
  {"pluginId":"other-helper@other-marketplace","marketplaceName":"other-marketplace"}
]
JSON
cat > "$inactive_home/.test-native/marketplaces.json" <<'JSON'
[
  {"name":"drawio"},
  {"name":"context-mode"},
  {"name":"pac-only"},
  {"name":"manual-marketplace"},
  {"name":"other-marketplace"}
]
JSON
printf '[]\n' > "$inactive_home/.test-native-claude/plugins.json"
printf '[]\n' > "$inactive_home/.test-native-claude/marketplaces.json"
cat > "$inactive_home/.local/state/personal-agent-control/owned-plugins.tsv" <<'EOF'
# plugin	marketplace	targets
context-mode	context-mode	codex
pac-only	pac-only	codex
EOF
printf 'replacement=skill:drawio\n' \
    > "$inactive_home/.local/state/personal-agent-control/migrations/drawio-plugin-to-skill-v1-codex"
PATH="$native_bin:$PATH" HOME="$inactive_home" \
    "$source/scripts/reconcile-plugins.sh" apply --home "$inactive_home" \
    --agents codex --catalog "$empty_catalog" >/dev/null
node - "$inactive_home" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const home = process.argv[2];
const plugins = JSON.parse(fs.readFileSync(path.join(home, '.test-native/plugins.json'), 'utf8'));
const ids = plugins.map((entry) => entry.pluginId).sort();
if (JSON.stringify(ids) !== JSON.stringify([
  'drawio@drawio', 'other-helper@other-marketplace', 'personal-helper@context-mode',
])) process.exit(1);
const marketplaces = JSON.parse(fs.readFileSync(path.join(home, '.test-native/marketplaces.json'), 'utf8'));
if (!marketplaces.some((entry) => entry.name === 'drawio')) process.exit(1);
if (!marketplaces.some((entry) => entry.name === 'context-mode')) process.exit(1);
if (marketplaces.some((entry) => entry.name === 'pac-only')) process.exit(1);
if (!marketplaces.some((entry) => entry.name === 'manual-marketplace')) process.exit(1);
NODE
if awk -F '\t' '$0 !~ /^#/ && NF { exit 1 }' \
    "$inactive_home/.local/state/personal-agent-control/owned-plugins.tsv"; then :; else
    echo "inactive Plugin ownership did not retire" >&2
    exit 1
fi
[ -d "$inactive_home/.local/share/agent-plugins/sources/context-mode" ]
[ ! -e "$inactive_home/.local/share/agent-plugins/sources/pac-only" ]
[ -d "$inactive_home/.local/share/agent-plugins/sources/manual-marketplace" ]
PATH="$native_bin:$PATH" HOME="$inactive_home" \
    "$source/scripts/reconcile-plugins.sh" apply --home "$inactive_home" \
    --agents codex --catalog "$empty_catalog" >/dev/null

# Shared Plugin sources survive separate per-host reconciliation when an
# unmanaged Plugin remains on the host processed first.
shared_home="$tmp/shared-plugin-home"
shared_source="$shared_home/.local/share/agent-plugins/sources/shared-marketplace"
registered_source="$shared_home/.local/share/agent-plugins/sources/registered-marketplace"
mkdir -p "$shared_home/.test-native" "$shared_home/.test-native-claude" \
    "$shared_home/.local/state/personal-agent-control" "$shared_source" \
    "$registered_source"
cat > "$shared_home/.test-native/plugins.json" <<'JSON'
[
  {"pluginId":"shared-plugin@shared-marketplace","marketplaceName":"shared-marketplace"},
  {"pluginId":"personal-helper@shared-marketplace","marketplaceName":"shared-marketplace"}
]
JSON
cat > "$shared_home/.test-native/marketplaces.json" <<'JSON'
[
  {"name":"shared-marketplace"},
  {"name":"registered-marketplace"}
]
JSON
cat > "$shared_home/.test-native-claude/plugins.json" <<'JSON'
[
  {"id":"shared-plugin@shared-marketplace"},
  {"id":"registered-plugin@registered-marketplace"}
]
JSON
cat > "$shared_home/.test-native-claude/marketplaces.json" <<'JSON'
[
  {"name":"shared-marketplace"},
  {"name":"registered-marketplace"}
]
JSON
cat > "$shared_home/.local/state/personal-agent-control/owned-plugins.tsv" <<'EOF'
# plugin	marketplace	targets
registered-plugin	registered-marketplace	claude
shared-plugin	shared-marketplace	codex,claude
EOF
PATH="$native_bin:$PATH" HOME="$shared_home" \
    "$source/scripts/reconcile-plugins.sh" apply --home "$shared_home" \
    --agents codex --catalog "$empty_catalog" >/dev/null
PATH="$native_bin:$PATH" HOME="$shared_home" \
    "$source/scripts/reconcile-plugins.sh" apply --home "$shared_home" \
    --agents claude --catalog "$empty_catalog" >/dev/null
[ -d "$shared_source" ]
[ -d "$registered_source" ]
node - "$shared_home" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const home = process.argv[2];
const codex = JSON.parse(fs.readFileSync(path.join(home, '.test-native/plugins.json'), 'utf8'));
const claude = JSON.parse(fs.readFileSync(path.join(home, '.test-native-claude/plugins.json'), 'utf8'));
const codexMarketplaces = JSON.parse(fs.readFileSync(
  path.join(home, '.test-native/marketplaces.json'), 'utf8'));
const claudeMarketplaces = JSON.parse(fs.readFileSync(
  path.join(home, '.test-native-claude/marketplaces.json'), 'utf8'));
if (JSON.stringify(codex.map((entry) => entry.pluginId)) !==
    JSON.stringify(['personal-helper@shared-marketplace'])) process.exit(1);
if (claude.length !== 0) process.exit(1);
if (!codexMarketplaces.some((entry) => entry.name === 'registered-marketplace')) process.exit(1);
if (claudeMarketplaces.length !== 0) process.exit(1);
NODE
if awk -F '\t' '$0 !~ /^#/ && NF { exit 1 }' \
    "$shared_home/.local/state/personal-agent-control/owned-plugins.tsv"; then :; else
    echo "shared Plugin ownership did not retire" >&2
    exit 1
fi

active_home="$tmp/active-plugin-home"
active_source="$active_home/.local/share/agent-plugins/sources/managed-marketplace"
mkdir -p "$active_home/.test-native" "$active_source/.git" \
    "$active_source/plugins/managed-plugin/skills/fixture-skill" \
    "$active_home/.local/state/personal-agent-control/migrations"
cat > "$active_source/plugins/managed-plugin/skills/fixture-skill/SKILL.md" <<'EOF'
---
name: fixture-skill
description: Native Plugin reconciliation fixture.
---
EOF
active_catalog="$tmp/active-plugins.tsv"
sed -n '1p' "$source/catalog/plugins.tsv" > "$active_catalog"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    managed-plugin managed-marketplace github-commit https://example.invalid/plugin.git - \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    1.0.0 codex fixture-skill MIT common >> "$active_catalog"
node - "$active_home" "$active_source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home, source] = process.argv.slice(2);
const marketplaceSource = { sourceType: 'local', source };
fs.writeFileSync(path.join(home, '.test-native/marketplaces.json'), JSON.stringify([
  { name: 'managed-marketplace', marketplaceSource },
  { name: 'drawio' },
]));
fs.writeFileSync(path.join(home, '.test-native/plugins.json'), JSON.stringify([
  {
    pluginId: 'managed-plugin@managed-marketplace', marketplaceName: 'managed-marketplace',
    version: '1.0.0', enabled: true, installed: true, marketplaceSource,
  },
  { pluginId: 'drawio@drawio', marketplaceName: 'drawio' },
]));
NODE
printf 'replacement=skill:drawio\n' \
    > "$active_home/.local/state/personal-agent-control/migrations/drawio-plugin-to-skill-v1-codex"
if PATH="$native_bin:$PATH" HOME="$active_home" \
    PAC_TEST_NATIVE_PLUGIN_SOURCE=https://example.invalid/plugin.git \
    PAC_TEST_NATIVE_PLUGIN_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    PAC_TEST_NATIVE_PLUGIN_TREE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    "$source/scripts/reconcile-plugins.sh" apply --home "$active_home" \
    --agents codex --catalog "$active_catalog" > "$tmp/active-plugin.out" 2>&1; then
    echo "active Plugin migration removed a marker-protected unmanaged Plugin" >&2
    exit 1
fi
grep -q '^UNMANAGED: installed codex Plugin(s) are absent from catalog/plugins.tsv:' \
    "$tmp/active-plugin.out"
node - "$active_home/.test-native/plugins.json" <<'NODE'
const fs = require('node:fs');
const plugins = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!plugins.some((entry) => entry.pluginId === 'drawio@drawio')) process.exit(1);
NODE

# Native inventory parsing is fail-closed. Malformed Plugin or marketplace
# JSON must stop before uninstall/remove and must not rewrite ownership.
inventory_home="$tmp/malformed-plugin-home"
inventory_source="$inventory_home/.local/share/agent-plugins/sources/managed-marketplace"
mkdir -p "$inventory_home/.test-native" "$inventory_source/.git" \
    "$inventory_source/plugins/managed-plugin/skills/fixture-skill" \
    "$inventory_home/.local/state/personal-agent-control/migrations"
cp "$active_source/plugins/managed-plugin/skills/fixture-skill/SKILL.md" \
    "$inventory_source/plugins/managed-plugin/skills/fixture-skill/SKILL.md"
printf 'replacement=skill:drawio\n' \
    > "$inventory_home/.local/state/personal-agent-control/migrations/drawio-plugin-to-skill-v1-codex"
cat > "$inventory_home/.local/state/personal-agent-control/owned-plugins.tsv" <<'EOF'
# plugin	marketplace	targets
managed-plugin	managed-marketplace	codex
EOF
cp "$inventory_home/.local/state/personal-agent-control/owned-plugins.tsv" \
    "$tmp/malformed-owned-before.tsv"
node - "$inventory_home" "$inventory_source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home, source] = process.argv.slice(2);
fs.writeFileSync(path.join(home, '.test-native/marketplaces.json'), JSON.stringify([
  { name: 'managed-marketplace', marketplaceSource: { sourceType: 'local', source } },
]));
fs.writeFileSync(path.join(home, '.test-native/plugins.json'), '{malformed\n');
NODE
for inventory_mode in apply check; do
    if PATH="$native_bin:$PATH" HOME="$inventory_home" \
        PAC_TEST_NATIVE_PLUGIN_SOURCE=https://example.invalid/plugin.git \
        PAC_TEST_NATIVE_PLUGIN_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
        PAC_TEST_NATIVE_PLUGIN_TREE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
        "$source/scripts/reconcile-plugins.sh" "$inventory_mode" --home "$inventory_home" \
        --agents codex --catalog "$active_catalog" >/dev/null 2>&1; then
        echo "malformed native Plugin inventory was accepted in $inventory_mode mode" >&2
        exit 1
    fi
done
[ ! -e "$inventory_home/.test-native/mutations.log" ]
cmp -s "$tmp/malformed-owned-before.tsv" \
    "$inventory_home/.local/state/personal-agent-control/owned-plugins.tsv"

node - "$inventory_home" "$inventory_source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home, source] = process.argv.slice(2);
const marketplaceSource = { sourceType: 'local', source };
fs.writeFileSync(path.join(home, '.test-native/plugins.json'), JSON.stringify([{
  pluginId: 'managed-plugin@managed-marketplace', marketplaceName: 'managed-marketplace',
  version: '1.0.0', enabled: true, installed: true, marketplaceSource,
}]));
fs.writeFileSync(path.join(home, '.test-native/marketplaces.json'), '{malformed\n');
NODE
for inventory_mode in apply check; do
    if PATH="$native_bin:$PATH" HOME="$inventory_home" \
        PAC_TEST_NATIVE_PLUGIN_SOURCE=https://example.invalid/plugin.git \
        PAC_TEST_NATIVE_PLUGIN_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
        PAC_TEST_NATIVE_PLUGIN_TREE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
        "$source/scripts/reconcile-plugins.sh" "$inventory_mode" --home "$inventory_home" \
        --agents codex --catalog "$active_catalog" >/dev/null 2>&1; then
        echo "malformed native marketplace inventory was accepted in $inventory_mode mode" >&2
        exit 1
    fi
done
[ ! -e "$inventory_home/.test-native/mutations.log" ]
cmp -s "$tmp/malformed-owned-before.tsv" \
    "$inventory_home/.local/state/personal-agent-control/owned-plugins.tsv"

# A predictable legacy migration temp symlink cannot redirect marker writes.
marker_home="$tmp/plugin-marker-home"
marker_source="$marker_home/.local/share/agent-plugins/sources/managed-marketplace"
marker="$marker_home/.local/state/personal-agent-control/migrations/drawio-plugin-to-skill-v1-codex"
marker_sentinel="$tmp/plugin-marker-sentinel"
mkdir -p "$marker_home/.test-native" "$marker_source/.git" \
    "$marker_source/plugins/managed-plugin/skills/fixture-skill" "$(dirname "$marker")"
cp "$active_source/plugins/managed-plugin/skills/fixture-skill/SKILL.md" \
    "$marker_source/plugins/managed-plugin/skills/fixture-skill/SKILL.md"
printf 'preserve marker sentinel\n' > "$marker_sentinel"
cat > "$marker_home/.local/state/personal-agent-control/owned-plugins.tsv" <<'EOF'
# plugin	marketplace	targets
drawio	drawio	codex
EOF
node - "$marker_home" "$marker_source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home, source] = process.argv.slice(2);
const marketplaceSource = { sourceType: 'local', source };
fs.writeFileSync(path.join(home, '.test-native/marketplaces.json'), JSON.stringify([
  { name: 'managed-marketplace', marketplaceSource },
  { name: 'drawio' },
]));
fs.writeFileSync(path.join(home, '.test-native/plugins.json'), JSON.stringify([
  {
    pluginId: 'managed-plugin@managed-marketplace', marketplaceName: 'managed-marketplace',
    version: '1.0.0', enabled: true, installed: true, marketplaceSource,
  },
  { pluginId: 'drawio@drawio', marketplaceName: 'drawio' },
]));
NODE
PATH="$native_bin:$PATH" HOME="$marker_home" \
PAC_TEST_NATIVE_PLUGIN_SOURCE=https://example.invalid/plugin.git \
PAC_TEST_NATIVE_PLUGIN_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
PAC_TEST_NATIVE_PLUGIN_TREE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
sh -c '
    marker=$1
    sentinel=$2
    script=$3
    home=$4
    catalog=$5
    ln -s "$sentinel" "$marker.$$"
    exec "$script" apply --home "$home" --agents codex --catalog "$catalog"
' sh "$marker" "$marker_sentinel" "$source/scripts/reconcile-plugins.sh" \
    "$marker_home" "$active_catalog" >/dev/null
grep -q '^preserve marker sentinel$' "$marker_sentinel"
[ -f "$marker" ] && [ ! -L "$marker" ]
node - "$marker_home/.test-native/plugins.json" <<'NODE'
const fs = require('node:fs');
const plugins = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (plugins.some((entry) => entry.pluginId === 'drawio@drawio')) process.exit(1);
NODE

# A fresh, unowned native Plugin is not legacy PAC state. The migration marker
# is recorded, but strict unmanaged inventory fails without deleting it.
unowned_home="$tmp/unowned-plugin-migration-home"
unowned_source="$unowned_home/.local/share/agent-plugins/sources/managed-marketplace"
unowned_marker="$unowned_home/.local/state/personal-agent-control/migrations/drawio-plugin-to-skill-v1-codex"
mkdir -p "$unowned_home/.test-native" "$unowned_source/.git" \
    "$unowned_source/plugins/managed-plugin/skills/fixture-skill" "$(dirname "$unowned_marker")"
cp "$active_source/plugins/managed-plugin/skills/fixture-skill/SKILL.md" \
    "$unowned_source/plugins/managed-plugin/skills/fixture-skill/SKILL.md"
node - "$unowned_home" "$unowned_source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home, source] = process.argv.slice(2);
const marketplaceSource = { sourceType: 'local', source };
fs.writeFileSync(path.join(home, '.test-native/marketplaces.json'), JSON.stringify([
  { name: 'managed-marketplace', marketplaceSource },
  { name: 'drawio' },
]));
fs.writeFileSync(path.join(home, '.test-native/plugins.json'), JSON.stringify([
  {
    pluginId: 'managed-plugin@managed-marketplace', marketplaceName: 'managed-marketplace',
    version: '1.0.0', enabled: true, installed: true, marketplaceSource,
  },
  { pluginId: 'drawio@drawio', marketplaceName: 'drawio' },
]));
NODE
if PATH="$native_bin:$PATH" HOME="$unowned_home" \
    PAC_TEST_NATIVE_PLUGIN_SOURCE=https://example.invalid/plugin.git \
    PAC_TEST_NATIVE_PLUGIN_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    PAC_TEST_NATIVE_PLUGIN_TREE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    "$source/scripts/reconcile-plugins.sh" apply --home "$unowned_home" \
    --agents codex --catalog "$active_catalog" > "$tmp/unowned-migration.out" 2>&1; then
    echo "fresh unowned Plugin migration was accepted" >&2
    exit 1
fi
grep -q '^UNMANAGED: installed codex Plugin(s) are absent from catalog/plugins.tsv:' \
    "$tmp/unowned-migration.out"
[ ! -e "$unowned_home/.test-native/mutations.log" ]
[ -f "$unowned_marker" ] && [ ! -L "$unowned_marker" ]
node - "$unowned_home/.test-native/plugins.json" <<'NODE'
const fs = require('node:fs');
const plugins = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!plugins.some((entry) => entry.pluginId === 'drawio@drawio')) process.exit(1);
NODE

# Unconditional Chezmoi before/after hooks share one outer snapshot and one
# mutation lock. A failed nested apply restores pre-Chezmoi bytes while a
# concurrent PAC mutation remains blocked for the whole restore.
outer_home="$tmp/outer-transaction-home"
outer_state="$outer_home/.local/state/personal-agent-control"
outer_before="$tmp/outer-before.sh"
outer_after="$tmp/outer-after.sh"
outer_driver="$tmp/outer-driver.sh"
restore_pause="$tmp/restore-pause.sh"
restore_entered="$tmp/restore-entered"
restore_release="$tmp/restore-release"
mkdir -p "$outer_home/.codex/agents" "$outer_home/.config/personal-agent-control" \
    "$outer_state"
printf '%s\n' 'adapter before outer transaction' > "$outer_home/.codex/AGENTS.md"
cp "$source/tests/fixtures/legacy-pac-reviewer.toml" \
    "$outer_home/.codex/agents/pac-reviewer.toml"
printf '%s\n' 'chezmoi state before outer transaction' \
    > "$outer_home/.config/personal-agent-control/state.boltdb"
printf '%s\n' 'prior last-backup bytes' > "$outer_state/last-backup"
outer_adapter_before=$(file_digest "$outer_home/.codex/AGENTS.md")
outer_legacy_before=$(file_digest "$outer_home/.codex/agents/pac-reviewer.toml")
outer_state_before=$(file_digest "$outer_home/.config/personal-agent-control/state.boltdb")
outer_last_before=$(file_digest "$outer_state/last-backup")
"$chezmoi_bin" --source "$source" --destination "$outer_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$outer_before" execute-template --file \
    "$source/.chezmoiscripts/run_before_10-backup.sh.tmpl"
"$chezmoi_bin" --source "$source" --destination "$outer_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$outer_after" execute-template --file \
    "$source/.chezmoiscripts/run_after_20-install-tools-and-skills.sh.tmpl"
cat > "$restore_pause" <<'SH'
#!/bin/sh
set -eu
: > "$PAC_TEST_RESTORE_ENTERED"
while [ ! -f "$PAC_TEST_RESTORE_RELEASE" ]; do sleep 0.05; done
exec env HOME="$PAC_TEST_OUTER_HOME" sh "$PAC_TEST_REAL_RESTORE" "$1"
SH
cat > "$outer_driver" <<'SH'
#!/bin/sh
set -eu
home=$1 before=$2 after=$3 source=$4 fixture_bin=$5 mode=${6:-apm-fail}
HOME="$home" "$before" >/dev/null
mkdir -p "$home/.local/bin" "$home/.codex/agents" "$home/.config/personal-agent-control"
[ -e "$home/.local/bin/mise" ] || [ -L "$home/.local/bin/mise" ] || \
    ln -s "$fixture_bin/mise" "$home/.local/bin/mise"
cp "$source/generated/codex/AGENTS.md" "$home/.codex/AGENTS.md"
cp "$source/generated/codex/agents/independent-reviewer.toml" \
    "$home/.codex/agents/independent-reviewer.toml"
printf '%s\n' 'chezmoi state after target repair' \
    > "$home/.config/personal-agent-control/state.boltdb"
case "$mode" in
    success)
        HOME="$home" PAC_ROOT="$source" PAC_HOST_ADAPTER_MODE=adopt \
            PAC_NO_PLUGINS=1 PAC_NO_RESOLVER=1 PAC_SKIP_POST_DOCTOR=1 \
            "$after"
        ;;
    doctor-fail)
        HOME="$home" PAC_ROOT="$source" PAC_HOST_ADAPTER_MODE=adopt \
            PAC_NO_PLUGINS=1 PAC_NO_RESOLVER=1 PAC_SKIP_POST_DOCTOR=0 \
            PAC_DOCTOR="$PAC_TEST_LATE_DOCTOR" "$after"
        ;;
    apm-fail)
        HOME="$home" PAC_ROOT="$source" PAC_HOST_ADAPTER_MODE=adopt \
            PAC_NO_PLUGINS=1 PAC_NO_RESOLVER=1 PAC_SKIP_POST_DOCTOR=1 \
            PAC_TEST_APM_FAIL=1 "$after"
        ;;
    *) exit 2 ;;
esac
SH
chmod 755 "$outer_before" "$outer_after" "$restore_pause" "$outer_driver"
PAC_RESTORE="$restore_pause" \
PAC_TEST_RESTORE_ENTERED="$restore_entered" \
PAC_TEST_RESTORE_RELEASE="$restore_release" \
PAC_TEST_OUTER_HOME="$outer_home" \
PAC_TEST_REAL_RESTORE="$source/scripts/restore-backup.sh" \
    "$outer_driver" "$outer_home" "$outer_before" "$outer_after" \
    "$source" "$fixture_bin" > "$tmp/outer-driver.out" 2>&1 &
outer_pid=$!
attempt=0
while [ ! -f "$restore_entered" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 200 ]; then
        echo "outer rollback did not reach the restore gate" >&2
        exit 1
    fi
    sleep 0.05
done
if run_pac "$outer_home" apply > "$tmp/outer-contender.out" 2>&1; then
    echo "concurrent PAC mutation entered an outer Chezmoi transaction" >&2
    exit 1
fi
grep -q 'PAC_LOCKED' "$tmp/outer-contender.out"
outer_transaction=$(find "$outer_state" -maxdepth 1 -type f \
    -name 'chezmoi-transaction-*' ! -name '*.claim' -print -quit)
[ -n "$outer_transaction" ]
outer_snapshot=$(sed -n '1p' "$outer_transaction")
grep -Fqx '.config/personal-agent-control/profile-bootstrap.md' \
    "$outer_snapshot/managed-paths.txt"
grep -Fqx '.local/state/personal-agent-control/profile-bootstrap.json' \
    "$outer_snapshot/managed-paths.txt"
: > "$restore_release"
if wait "$outer_pid"; then
    echo "forced outer transaction failure unexpectedly succeeded" >&2
    exit 1
fi
[ "$(file_digest "$outer_home/.codex/AGENTS.md")" = "$outer_adapter_before" ]
[ "$(file_digest "$outer_home/.codex/agents/pac-reviewer.toml")" = "$outer_legacy_before" ]
[ "$(file_digest "$outer_home/.config/personal-agent-control/state.boltdb")" = "$outer_state_before" ]
[ "$(file_digest "$outer_state/last-backup")" = "$outer_last_before" ]
[ ! -e "$outer_home/.config/personal-agent-control/machine.json" ]
[ ! -e "$outer_home/.local/bin/mise" ]
[ ! -e "$outer_home/.local/bin/pac" ]
[ ! -e "$outer_state/migrations/independent-reviewer-codex-v1" ]
[ ! -e "$outer_state/pac.lock" ]
for leftover in "$outer_state"/chezmoi-transaction-*; do
    [ ! -e "$leftover" ] && [ ! -L "$leftover" ] || {
        echo "completed outer transaction left coordination state: $leftover" >&2
        exit 1
    }
done

# A successful retry recognizes and retires the exact historical PAC reviewer.
"$outer_driver" "$outer_home" "$outer_before" "$outer_after" \
    "$source" "$fixture_bin" success >/dev/null
[ ! -e "$outer_home/.codex/agents/pac-reviewer.toml" ]
[ -f "$outer_state/migrations/independent-reviewer-codex-v1" ]
[ -f "$outer_home/.config/personal-agent-control/machine.json" ]

# The paired before hook is unconditional. With unchanged source, a second
# apply repairs drift, then a late verification failure restores the exact
# pre-second-apply target, state, machine profile, last-backup, and mise link.
printf '%s\n' 'adapter drift before repeat apply' > "$outer_home/.codex/AGENTS.md"
printf '%s\n' 'chezmoi state before repeat apply' \
    > "$outer_home/.config/personal-agent-control/state.boltdb"
repeat_adapter_before=$(file_digest "$outer_home/.codex/AGENTS.md")
repeat_state_before=$(file_digest "$outer_home/.config/personal-agent-control/state.boltdb")
repeat_machine_before=$(file_digest "$outer_home/.config/personal-agent-control/machine.json")
repeat_last_before=$(file_digest "$outer_state/last-backup")
repeat_mise_before=$(readlink "$outer_home/.local/bin/mise")
late_doctor="$tmp/late-doctor.sh"
printf '%s\n' '#!/bin/sh' 'exit 48' > "$late_doctor"
chmod 755 "$late_doctor"
restore_entered_repeat="$tmp/restore-entered-repeat"
restore_release_repeat="$tmp/restore-release-repeat"
PAC_RESTORE="$restore_pause" \
PAC_TEST_RESTORE_ENTERED="$restore_entered_repeat" \
PAC_TEST_RESTORE_RELEASE="$restore_release_repeat" \
PAC_TEST_OUTER_HOME="$outer_home" \
PAC_TEST_REAL_RESTORE="$source/scripts/restore-backup.sh" \
PAC_TEST_LATE_DOCTOR="$late_doctor" \
    "$outer_driver" "$outer_home" "$outer_before" "$outer_after" \
    "$source" "$fixture_bin" doctor-fail > "$tmp/repeat-driver.out" 2>&1 &
repeat_pid=$!
attempt=0
while [ ! -f "$restore_entered_repeat" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -le 200 ] || { echo "repeat rollback did not reach restore gate" >&2; exit 1; }
    sleep 0.05
done
: > "$restore_release_repeat"
if wait "$repeat_pid"; then
    echo "forced repeat Chezmoi failure unexpectedly succeeded" >&2
    exit 1
fi
[ "$(file_digest "$outer_home/.codex/AGENTS.md")" = "$repeat_adapter_before" ]
[ "$(file_digest "$outer_home/.config/personal-agent-control/state.boltdb")" = "$repeat_state_before" ]
[ "$(file_digest "$outer_home/.config/personal-agent-control/machine.json")" = "$repeat_machine_before" ]
[ "$(file_digest "$outer_state/last-backup")" = "$repeat_last_before" ]
[ "$(readlink "$outer_home/.local/bin/mise")" = "$repeat_mise_before" ]
[ -f "$outer_state/migrations/independent-reviewer-codex-v1" ]
[ ! -e "$outer_state/pac.lock" ]

# If both the nested restore and the shell fallback cannot validate the HOME,
# the marker, claim, lock, and intact snapshot remain for explicit recovery.
restore_fail="$tmp/restore-fail.sh"
restore_failed_cache="$tmp/restore-failed-cache-target"
cat > "$restore_fail" <<'SH'
#!/bin/sh
set -eu
cache="$PAC_TEST_OUTER_HOME/.cache/personal-agent-control"
rm -rf -- "$cache"
mkdir -p "$PAC_TEST_OUTER_HOME/.cache" "$PAC_TEST_RESTORE_FAILED_CACHE_TARGET"
ln -s "$PAC_TEST_RESTORE_FAILED_CACHE_TARGET" "$cache"
exit 49
SH
chmod 755 "$restore_fail"
if PAC_RESTORE="$restore_fail" \
    PAC_TEST_OUTER_HOME="$outer_home" \
    PAC_TEST_RESTORE_FAILED_CACHE_TARGET="$restore_failed_cache" \
    "$outer_driver" "$outer_home" "$outer_before" "$outer_after" \
    "$source" "$fixture_bin" apm-fail > "$tmp/restore-failure.out" 2>&1; then
    echo "outer transaction with an un-restorable HOME unexpectedly succeeded" >&2
    exit 1
fi
grep -q 'outer transaction state was retained for explicit recovery' \
    "$tmp/restore-failure.out"
[ -d "$outer_state/pac.lock" ] && [ ! -L "$outer_state/pac.lock" ]
retained_marker=
for candidate in "$outer_state"/chezmoi-transaction-*; do
    case "$candidate" in *.claim) continue ;; esac
    if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then retained_marker=$candidate; fi
done
[ -n "$retained_marker" ]
[ -f "$retained_marker.claim" ] && [ ! -L "$retained_marker.claim" ]
retained_backup=$(sed -n '1p' "$retained_marker")
rm -f -- "$outer_home/.cache/personal-agent-control"
HOME="$outer_home" "$source/scripts/restore-backup.sh" --validate \
    "$retained_backup" >/dev/null

# A user-owned or modified file at the deprecated reviewer path is never
# treated as PAC-owned merely because the outer snapshot can restore it.
unknown_home="$tmp/unknown-legacy-reviewer-home"
unknown_state="$unknown_home/.local/state/personal-agent-control"
unknown_before="$tmp/unknown-before.sh"
unknown_after="$tmp/unknown-after.sh"
mkdir -p "$unknown_home/.codex/agents" "$unknown_home/.local/bin" "$unknown_state"
printf '%s\n' 'user-owned reviewer sentinel' > "$unknown_home/.codex/agents/pac-reviewer.toml"
unknown_before_digest=$(file_digest "$unknown_home/.codex/agents/pac-reviewer.toml")
ln -s "$fixture_bin/mise" "$unknown_home/.local/bin/mise"
"$chezmoi_bin" --source "$source" --destination "$unknown_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$unknown_before" execute-template --file \
    "$source/.chezmoiscripts/run_before_10-backup.sh.tmpl"
"$chezmoi_bin" --source "$source" --destination "$unknown_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$unknown_after" execute-template --file \
    "$source/.chezmoiscripts/run_after_20-install-tools-and-skills.sh.tmpl"
chmod 755 "$unknown_before" "$unknown_after"
HOME="$unknown_home" "$unknown_before" >/dev/null
if HOME="$unknown_home" PAC_ROOT="$source" PAC_HOST_ADAPTER_MODE=skip \
    "$unknown_after" > "$tmp/unknown-reviewer.out" 2>&1; then
    echo "user-owned deprecated reviewer path was accepted for migration" >&2
    exit 1
fi
grep -q 'not a known PAC-owned version; preserving it' "$tmp/unknown-reviewer.out"
[ "$(file_digest "$unknown_home/.codex/agents/pac-reviewer.toml")" = "$unknown_before_digest" ]
[ ! -e "$unknown_state/migrations/independent-reviewer-codex-v1" ]
[ ! -e "$unknown_state/pac.lock" ]

# A stale marker without its outer lock blocks a new unconditional before hook.
stale_home="$tmp/stale-outer-home"
stale_state="$stale_home/.local/state/personal-agent-control"
stale_before="$tmp/stale-before.sh"
mkdir -p "$stale_state"
printf '%s\n%s\n' '/stale/backup' 'StaleToken' \
    > "$stale_state/chezmoi-transaction-999999"
"$chezmoi_bin" --source "$source" --destination "$stale_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$stale_before" execute-template --file \
    "$source/.chezmoiscripts/run_before_10-backup.sh.tmpl"
chmod 755 "$stale_before"
if HOME="$stale_home" "$stale_before" > "$tmp/stale-before.out" 2>&1; then
    echo "new Chezmoi transaction bypassed a stale outer marker" >&2
    exit 1
fi
grep -q 'requires explicit recovery' "$tmp/stale-before.out"
[ ! -e "$stale_state/pac.lock" ]
[ ! -e "$stale_state/last-backup" ]

# Formatting that resembles ownership is not authority: incomplete adapter
# JSON fails before any snapshot or host-native cleanup surface is admitted.
forged_home="$tmp/forged-adapter-ownership-home"
forged_state="$forged_home/.local/state/personal-agent-control"
forged_before="$tmp/forged-before.sh"
mkdir -p "$forged_state"
printf '%s\n' '{"schemaVersion":1,"hosts":{"claude":[]}}' \
    > "$forged_state/owned-host-adapters.json"
"$chezmoi_bin" --source "$source" --destination "$forged_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$forged_before" execute-template --file \
    "$source/.chezmoiscripts/run_before_10-backup.sh.tmpl"
chmod 755 "$forged_before"
if HOME="$forged_home" "$forged_before" > "$tmp/forged-before.out" 2>&1; then
    echo "incomplete adapter ownership authorized an outer cleanup snapshot" >&2
    exit 1
fi
grep -q 'incomplete claude adapter ownership' "$tmp/forged-before.out"
[ ! -e "$forged_state/pac.lock" ]
[ ! -e "$forged_state/last-backup" ]
[ ! -e "$forged_home/.agent-work/backups/personal-agent-control" ]

# A stale first-install override cannot reactivate Codex after the machine
# profile becomes Claude-only. Runtime host selection drives the outer
# inventory and the adapter installed by the paired hooks.
transition_source="$tmp/transition-source"
transition_home="$tmp/transition-home"
transition_before="$tmp/transition-before.sh"
transition_after="$tmp/transition-after.sh"
mkdir -p "$transition_source" "$transition_home/.local/bin" \
    "$transition_home/.config/personal-agent-control" \
    "$transition_home/.claude/agents" "$transition_home/.codex"
cp -Rp "$source/." "$transition_source/"
printf '%s\n' '' '<!-- dynamic Claude transition fixture -->' \
    >> "$transition_source/generated/claude/CLAUDE.md"
printf '%s\n' '{"schemaVersion":1,"enabledHosts":["claude"]}' \
    > "$transition_home/.config/personal-agent-control/machine.json"
printf '%s\n' 'old Claude adapter' > "$transition_home/.claude/CLAUDE.md"
printf '%s\n' 'Codex must remain untouched' > "$transition_home/.codex/AGENTS.md"
transition_codex_before=$(file_digest "$transition_home/.codex/AGENTS.md")
transition_machine_before=$(file_digest \
    "$transition_home/.config/personal-agent-control/machine.json")
ln -s "$fixture_bin/mise" "$transition_home/.local/bin/mise"
"$chezmoi_bin" --source "$transition_source" --destination "$transition_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$transition_before" execute-template --file \
    "$transition_source/.chezmoiscripts/run_before_10-backup.sh.tmpl"
"$chezmoi_bin" --source "$transition_source" --destination "$transition_home" \
    --override-data '{"pac":{"agents":"codex","codex":true,"claude":false}}' \
    --output "$transition_after" execute-template --file \
    "$transition_source/.chezmoiscripts/run_after_20-install-tools-and-skills.sh.tmpl"
chmod 755 "$transition_before" "$transition_after"
HOME="$transition_home" "$transition_before" >/dev/null
transition_backup=$(sed -n '1p' \
    "$transition_home/.local/state/personal-agent-control/last-backup")
cp "$transition_source/generated/claude/CLAUDE.md" \
    "$transition_home/.claude/CLAUDE.md"
cp "$transition_source/generated/claude/agents/independent-reviewer.md" \
    "$transition_home/.claude/agents/independent-reviewer.md"
HOME="$transition_home" PAC_ROOT="$transition_source" \
    PAC_HOST_ADAPTER_MODE=adopt PAC_NO_PLUGINS=1 PAC_NO_RESOLVER=1 \
    PAC_SKIP_POST_DOCTOR=1 "$transition_after" >/dev/null
cmp -s "$transition_source/generated/claude/CLAUDE.md" \
    "$transition_home/.claude/CLAUDE.md"
[ "$(file_digest "$transition_home/.codex/AGENTS.md")" = "$transition_codex_before" ]
[ "$(file_digest "$transition_home/.config/personal-agent-control/machine.json")" = \
    "$transition_machine_before" ]
grep -q '^\.claude/CLAUDE\.md$' "$transition_backup/managed-paths.txt"
if grep -q '^\.codex/AGENTS\.md$' "$transition_backup/managed-paths.txt"; then
    echo "stale Codex seed leaked into Claude-only outer inventory" >&2
    exit 1
fi

# A backup taken while machine.json was absent removes a later file on restore.
fresh_backup=$(node -e "const x=require('$tmp/fresh.json'); process.stdout.write(x.data.backup)")
mkdir -p "$home/.config/personal-agent-control"
printf '%s\n' '{"schemaVersion":1,"enabledHosts":["codex"]}' \
    > "$home/.config/personal-agent-control/machine.json"
HOME="$home" "$source/scripts/restore-backup.sh" "$fresh_backup" >/dev/null
[ ! -e "$home/.config/personal-agent-control/machine.json" ]

grep -q '^apply$' "$PAC_TEST_PLUGIN_LOG"
grep -q '^check$' "$PAC_TEST_PLUGIN_LOG"
echo "isolated PAC install, machine profiles, host-order independence, idempotence, Skill and Plugin lifecycle, collision preservation, rollback, and mocked-provider tests passed"
