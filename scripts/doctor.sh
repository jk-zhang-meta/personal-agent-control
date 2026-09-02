#!/bin/sh
set -eu

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd -P)
home=${HOME:?HOME is required}
agents=codex,claude
profile=
allow_pending_codex_hook_trust=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --allow-pending-codex-hook-trust) allow_pending_codex_hook_trust=1; shift ;;
        --home) [ "$#" -ge 2 ] || { echo "--home needs a value" >&2; exit 2; }; home=$2; shift 2 ;;
        --agents) [ "$#" -ge 2 ] || { echo "--agents needs a value" >&2; exit 2; }; agents=$2; shift 2 ;;
        --profile) [ "$#" -ge 2 ] || { echo "--profile needs a value" >&2; exit 2; }; profile=$2; shift 2 ;;
        *) echo "usage: $0 [--allow-pending-codex-hook-trust] [--home PATH] [--agents codex|claude|codex,claude] [--profile PATH]" >&2; exit 2 ;;
    esac
done

case "$agents" in
    codex|claude) pac_hosts=$agents ;;
    codex,claude|claude,codex) pac_hosts=all ;;
    *) echo "invalid agent selection: $agents" >&2; exit 2 ;;
esac
case "$home" in /*) ;; *) echo "home must be absolute: $home" >&2; exit 2 ;; esac
[ "$home" != / ] || { echo "refusing HOME=/" >&2; exit 2; }
case "$profile" in ''|/*) ;; *) echo "profile must be absolute: $profile" >&2; exit 2 ;; esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/pac-doctor.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
failures=0

has_agent() { case ",$agents," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
drift() { echo "DRIFT: $1" >&2; failures=$((failures + 1)); }
check_file() {
    expected=$1 installed=$2
    if [ ! -f "$installed" ] || [ -L "$installed" ] || \
        ! cmp -s "$expected" "$installed"; then
        drift "$installed"
    fi
}

pac_source="$repo/bin/pac"
pac="$home/.local/bin/pac"
[ -x "$pac_source" ] || drift "PAC executable is missing: $pac_source"
if [ -L "$home/.local/bin/pac" ]; then
    [ "$(readlink "$home/.local/bin/pac")" = "$pac_source" ] || drift "installed PAC launcher points elsewhere"
elif [ -e "$home/.local/bin/pac" ]; then
    drift "installed PAC launcher is not a managed symlink"
else
    drift "installed PAC launcher is missing"
fi
if ! HOME="$home" PATH="$home/.local/bin" "$pac" --help \
    > "$tmp/launcher.out" 2> "$tmp/launcher.err"; then
    [ ! -s "$tmp/launcher.err" ] || sed -n '1,12p' "$tmp/launcher.err" >&2
    drift "installed PAC launcher cannot start from the pinned mise binary without a system Node PATH"
fi

status_json="$tmp/status.json"
status_paths_valid=0
status_rc=0
HOME="$home" PAC_ROOT="$repo" "$pac" --json --home "$home" \
    --hosts "$pac_hosts" status > "$status_json" 2> "$tmp/status.err" || status_rc=$?
if [ "$status_rc" -le 1 ]; then
    if node - "$status_json" "$allow_pending_codex_hook_trust" \
        "$tmp/activation-state" "$status_rc" <<'NODE'
const fs = require('node:fs');
const envelope = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const data = envelope.data;
const allowPending = process.argv[3] === '1';
const statusRc = Number(process.argv[5]);
if (!envelope.ok) throw new Error('PAC status command failed');
if (!data?.ok) {
  const pending = data?.activation?.pending;
  const invalid = Array.isArray(data?.scanGuard)
    ? data.scanGuard.filter((entry) => !entry.valid) : [];
  const action = Array.isArray(pending) ? pending[0] : null;
  const guard = invalid[0];
  if (!allowPending || data?.activation?.ready !== true || pending?.length !== 1 ||
      invalid.length !== 1 || action?.host !== 'codex' || action?.action !== 'trust-hook' ||
      !['untrusted', 'modified'].includes(action?.trustStatus) ||
      typeof action?.key !== 'string' || action.key.length === 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(action?.currentHash || '') ||
      guard?.host !== 'codex' || guard?.structuralValid !== true || guard?.pendingTrust !== true ||
      guard?.operational !== false || guard?.hookTrust !== action.trustStatus ||
      guard?.hookTrustProbe?.key !== action.key || guard?.hookTrustProbe?.currentHash !== action.currentHash) {
    throw new Error('PAC status is not healthy');
  }
}
if ((data.ok && statusRc !== 0) || (!data.ok && statusRc !== 1)) {
  throw new Error('PAC status exit code disagrees with its health payload');
}
if (data.apm?.actual !== '0.28.0' || !data.apm?.matches) throw new Error('APM version drift');
if (!/^[0-9a-f]{64}$/u.test(data.canonicalLock?.sha256 || '') ||
    !data.runtimeLock?.matchesCanonical) throw new Error('APM lock hash drift');
if (!Array.isArray(data.skills) || !data.skills.length) throw new Error('managed Skill inventory is empty');
if (data.projections?.some((item) => !item.valid)) throw new Error('Skill projection identity drift');
if (data.materializerExceptions?.some((item) => !item.valid)) throw new Error('materializer exception drift');
if (!data.plugins?.valid) throw new Error('native Plugin drift');
fs.writeFileSync(process.argv[4], data.ok ? 'healthy\n' : 'pending-codex-hook-trust\n');
NODE
    then
        status_paths_valid=1
    else
        drift "PAC status contract"
    fi
else
    node - "$status_json" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.error(`PAC status failed: ${value.error?.code || 'DRIFT'}: ${value.error?.message || 'unhealthy state'}`);
NODE
    [ ! -s "$tmp/status.err" ] || sed -n '1,12p' "$tmp/status.err" >&2
    drift "PAC status"
fi

# PAC status validates every selected adapter ancestor before reading it. Keep
# these human-readable byte checks after that boundary so doctor never follows
# an unsafe host-directory symlink merely to report additional drift.
if [ "$status_paths_valid" -eq 1 ] && has_agent codex; then
    [ ! -s "$home/.codex/AGENTS.override.md" ] || drift "$home/.codex/AGENTS.override.md shadows managed instructions"
    check_file "$repo/generated/codex/AGENTS.md" "$home/.codex/AGENTS.md"
    check_file "$repo/generated/codex/agents/independent-reviewer.toml" \
        "$home/.codex/agents/independent-reviewer.toml"
    [ ! -e "$home/.codex/agents/pac-reviewer.toml" ] && \
        [ ! -L "$home/.codex/agents/pac-reviewer.toml" ] || drift "legacy Codex reviewer remains"
fi
if [ "$status_paths_valid" -eq 1 ] && has_agent claude; then
    check_file "$repo/generated/claude/CLAUDE.md" "$home/.claude/CLAUDE.md"
    check_file "$repo/generated/claude/agents/independent-reviewer.md" \
        "$home/.claude/agents/independent-reviewer.md"
    [ ! -e "$home/.claude/agents/pac-reviewer.md" ] && \
        [ ! -L "$home/.claude/agents/pac-reviewer.md" ] || drift "legacy Claude reviewer remains"
fi

apm_bin=${PAC_APM:-apm}
if command -v "$apm_bin" >/dev/null 2>&1 && \
    "$apm_bin" --version | grep -Eq '(^|[^0-9])0\.28\.0([^0-9]|$)'; then
    if ! (cd "$repo/packages/skills" && "$apm_bin" lock export --format cyclonedx >/dev/null); then
        drift "canonical APM lock cannot be safely parsed"
    fi
    neutral="$home/.local/share/agent-skills"
    if ! (cd "$repo/packages/skills" && HOME="$home" "$apm_bin" install \
        --frozen --dry-run --no-policy --root "$neutral" \
        --target agent-skills >/dev/null 2>&1); then
        drift "APM frozen replay or deployed-content hashes"
    fi
else
    drift "APM 0.28.0 executable"
fi

mise="$home/.local/bin/mise"
if [ ! -x "$mise" ]; then
    drift "pinned mise executable"
elif missing=$(HOME="$home" "$mise" --cd "$repo" ls --current --missing --no-header 2>/dev/null); then
    [ -z "$missing" ] || drift "pinned tool graph has missing installs: $missing"
else
    drift "pinned tool graph"
fi

resolver="$repo/payload/skills/capability-resolver/scripts/capability-resolver.mjs"
resolver_db="$home/.cache/personal-agent-control/capabilities-v1.sqlite"
set -- check --repo "$repo" --home "$home" --db "$resolver_db"
[ -z "$profile" ] || set -- "$@" --profile "$profile"
if ! HOME="$home" node "$resolver" "$@" >/dev/null 2>&1; then
    drift "capability resolver index"
fi

if [ "$failures" -ne 0 ]; then
    echo "doctor found $failures problem(s)" >&2
    exit 1
fi

if [ "$(cat "$tmp/activation-state")" = pending-codex-hook-trust ]; then
    echo "STAGED: doctor passed structural checks for $agents; installation awaits explicit Codex hook trust"
else
    echo "doctor passed for $agents: rules, reviewer, APM 0.28.0 lock and hashes, Skill projections, materializer exception, native Plugins, capability index, and pinned tools are healthy"
fi
