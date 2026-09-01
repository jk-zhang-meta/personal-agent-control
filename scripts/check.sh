#!/bin/sh
set -eu

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pac-check.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM

for command_name in shellcheck gitleaks rulesync agentskills node apm git; do
    command -v "$command_name" >/dev/null 2>&1 || {
        echo "$command_name is unavailable; run this check through mise" >&2
        exit 1
    }
done

apm --version | grep -Eq '(^|[^0-9])0\.28\.0([^0-9]|$)' || {
    echo "PAC requires APM 0.28.0" >&2
    exit 1
}

for obsolete in agent-control lib payload/modules environments dot_local; do
    [ ! -e "$repo/$obsolete" ] || {
        echo "obsolete bespoke or vendored path remains: $obsolete" >&2
        exit 1
    }
done

node - "$repo" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const rows = (name, width) => read(name).split(/\r?\n/u)
  .filter((line) => line && !line.startsWith('#'))
  .map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== width) throw new Error(`${name}:${index + 2} has ${fields.length} fields, expected ${width}`);
    return fields;
  });

const config = JSON.parse(read('pac.json'));
const coreHosts = Object.keys(config.hosts || {});
if (config.schemaVersion !== 1 || coreHosts.length === 0) {
  throw new Error('pac.json schema or host declarations are invalid');
}

const kernel = read('.rulesync/rules/00-kernel.md');
const kernelLines = kernel.split(/\r?\n/u).length - (kernel.endsWith('\n') ? 1 : 0);
const kernelWords = kernel.trim().split(/\s+/u).length;
if (kernelLines > 120 || kernelWords > 900) {
  throw new Error(`global kernel exceeds 120 lines/900 words: ${kernelLines} lines, ${kernelWords} words`);
}
const kernelSections = [...kernel.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
const expectedKernelSections = [
  'Operating contract',
  'Session intake gate',
  'Orchestration and capability resolution',
  'Authority, secrets, and external effects',
  'Verification and communication',
];
if (JSON.stringify(kernelSections) !== JSON.stringify(expectedKernelSections)) {
  throw new Error(`global kernel section ABI changed: ${kernelSections.join(', ')}`);
}

const capabilities = read('catalog/capabilities.jsonl').split(/\r?\n/u)
  .filter((line) => line.trim() && !line.startsWith('#')).map(JSON.parse);
const ids = new Set();
for (const item of capabilities) {
  if (!/^((skill|subagent|provider):)/u.test(item.id) || ids.has(item.id)) {
    throw new Error(`invalid or duplicate capability id: ${item.id}`);
  }
  if (!Array.isArray(item.memberships) || !item.memberships.length) {
    throw new Error(`capability lacks memberships: ${item.id}`);
  }
  ids.add(item.id);
}

for (const entry of fs.readdirSync(path.join(root, 'payload/skills'), { withFileTypes: true })) {
  if (entry.isDirectory() && !ids.has(`skill:${entry.name}`)) {
    throw new Error(`local Skill lacks capability metadata: ${entry.name}`);
  }
}

const plugins = rows('catalog/plugins.tsv', 12);
const pluginIds = new Set();
for (const [plugin, marketplace, acquisition, , ref, commit, tree, version, targets, bundled] of plugins) {
  const id = `${plugin}@${marketplace}`;
  if (pluginIds.has(id) || !/^github-(tag|commit)$/u.test(acquisition) ||
      !/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree) ||
      !/^(codex|claude|codex,claude)$/u.test(targets) || !version || !bundled ||
      (acquisition === 'github-tag' && /^(main|master|HEAD)$/u.test(ref))) {
    throw new Error(`invalid Plugin declaration: ${id}`);
  }
  pluginIds.add(id);
}
const providers = JSON.parse(read('catalog/providers.json'));
if (providers.schemaVersion !== 1 || !Array.isArray(providers.providers) || !providers.providers.length) {
  throw new Error('provider catalog schema is invalid');
}
const providerIds = new Set();
for (const provider of providers.providers) {
  const providerHosts = Object.keys(provider.hosts || {});
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(provider.name)
      || provider.kind !== 'mcp-server' || !['latest', 'pinned'].includes(provider.versionPolicy)
      || (provider.versionPolicy === 'pinned' && !provider.version)
      || providerIds.has(provider.name)
      || coreHosts.some((host) => !providerHosts.includes(host))
      || providerHosts.some((host) => !coreHosts.includes(host))) {
    throw new Error(`invalid provider declaration: ${provider.name}`);
  }
  providerIds.add(provider.name);
}
const codegraph = providers.providers.find((provider) => provider.name === 'codegraph');
if (!codegraph || codegraph.command !== 'mise' ||
    JSON.stringify(codegraph.args) !== JSON.stringify(['--cd', '{{PAC_ROOT}}', 'exec', '--', 'codegraph', 'serve', '--mcp'])) {
  throw new Error('CodeGraph provider must launch the pinned binary through the PAC Core mise project.');
}
rows('catalog/plugin-migrations.tsv', 5);
rows('catalog/owners.tsv', 3);
const tools = rows('catalog/tools.tsv', 5);
const toolVersions = Object.fromEntries(tools.map(([name, version]) => [name, version]));
if (toolVersions.apm !== '0.28.0' || toolVersions.skills !== '1.5.22') {
  throw new Error('tool catalog must pin APM 0.28.0 and Skills 1.5.22');
}

const manifest = read('packages/skills/apm.yml');
if (manifest.includes('ppt-master')) throw new Error('ppt-master must stay outside the APM lock');
const dependencies = [...manifest.matchAll(/^    - (.+)$/gmu)].map((match) => match[1]);
const expectedDependencies = [
  '../../payload/skills/capability-resolver',
  '../../payload/skills/graph-workflow',
];
if (JSON.stringify(dependencies) !== JSON.stringify(expectedDependencies)) {
  throw new Error(`Core APM dependency ownership drift: ${dependencies.join(', ')}`);
}
const materializers = read('src/materializers.mjs');
for (const required of [
  "source: 'hugohe3/ppt-master'",
  "commit: 'f5410f968e0fadbbd1f9815539238a8dda34b4d2'",
  "skillPath: 'skills/ppt-master'",
  "contentSha256: '18facf0343aba4c9cabb356fdc370802c36913eaa8d52f45e62f09f84185294f'",
]) {
  if (!materializers.includes(required)) throw new Error(`ppt-master materializer pin drift: ${required}`);
}
NODE

for skill_file in "$repo"/payload/skills/*/SKILL.md; do
    [ -f "$skill_file" ] || continue
    agentskills validate "${skill_file%/SKILL.md}" >/dev/null
done

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$repo" && sha256sum --quiet -c catalog/files.sha256)
else
    (cd "$repo" && shasum -a 256 --quiet -c catalog/files.sha256)
fi

find "$repo/scripts" "$repo/tests" -type f -name '*.sh' \
    -exec shellcheck -s sh {} +
find "$repo/.chezmoiscripts" -type f -name '*.sh.tmpl' | LC_ALL=C sort \
    | while IFS= read -r template; do
        rendered="$tmp/$(basename -- "$template" .tmpl)"
        sed -E "s/\{\{[^}]*\}\}/'template-value'/g" "$template" > "$rendered"
        shellcheck -s sh "$rendered"
    done

find "$repo/src" "$repo/tests" "$repo/payload" -type f -name '*.mjs' \
    -exec node --check {} +
if [ -f "$repo/bin/pac" ]; then
    sh -n "$repo/bin/pac"
    shellcheck -s sh "$repo/bin/pac"
fi

resolver="$repo/payload/skills/capability-resolver/scripts/capability-resolver.mjs"
for test_file in "$repo"/tests/*.test.mjs; do
    [ -f "$test_file" ] || continue
    node --test "$test_file"
done

"$repo/scripts/render.sh" --check

mkdir -p "$tmp/home" "$tmp/apm-root"
cp "$repo/packages/skills/apm.lock.yaml" "$tmp/apm-root/apm.lock.yaml"
(cd "$repo/packages/skills" && apm lock export --format cyclonedx >/dev/null)
(cd "$repo/packages/skills" && HOME="$tmp/home" apm install \
    --frozen --no-policy --root "$tmp/apm-root" \
    --target agent-skills >/dev/null)

# Metadata validation must use the candidate inventory, never whatever happens
# to be installed in the developer's real HOME.  APM materializes its locked
# Skills; the sole reviewed materializer exception contributes only the exact
# SKILL.md needed by the resolver's metadata oracle.
ppt_commit=f5410f968e0fadbbd1f9815539238a8dda34b4d2
ppt_skill_sha=c96eb86efc0ec0a4c0ddea39bad3072b68e09624e045d8308a417ea6344c7892
ppt_checkout="$tmp/ppt-master"
ppt_target="$tmp/ppt-master"
git init --quiet "$ppt_checkout"
git -C "$ppt_checkout" remote add origin https://github.com/hugohe3/ppt-master.git
git -C "$ppt_checkout" fetch --quiet --depth 1 --no-tags origin "$ppt_commit"
[ "$(git -C "$ppt_checkout" rev-parse FETCH_HEAD)" = "$ppt_commit" ] || {
    echo "ppt-master fetch did not resolve to its reviewed commit" >&2
    exit 1
}
mkdir -p "$ppt_target"
git -C "$ppt_checkout" show "FETCH_HEAD:skills/ppt-master/SKILL.md" > "$ppt_target/SKILL.md"
if command -v sha256sum >/dev/null 2>&1; then
    ppt_actual=$(sha256sum "$ppt_target/SKILL.md" | awk '{ print $1 }')
else
    ppt_actual=$(shasum -a 256 "$ppt_target/SKILL.md" | awk '{ print $1 }')
fi
[ "$ppt_actual" = "$ppt_skill_sha" ] || {
    echo "ppt-master SKILL.md differs from its reviewed exact-commit content" >&2
    exit 1
}
agentskills validate "$ppt_target" >/dev/null
node "$resolver" validate-metadata --repo "$repo" \
    --skill-root "$tmp/apm-root/.agents/skills" >/dev/null

gitleaks dir "$repo" --no-banner --redact --exit-code 1
"$repo/tests/install-isolated.sh"

echo "render, schema, catalog, APM lock, syntax, secret, and isolated lifecycle checks passed"
