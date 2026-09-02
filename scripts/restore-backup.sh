#!/bin/sh
set -eu

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd -P)
# shellcheck source=/dev/null
. "$repo/scripts/path-safety.sh"

home=${HOME:?HOME is required}
mode=restore
if [ "${1:-}" = --validate ]; then
    mode=validate
    shift
fi
[ "$#" -le 1 ] || { echo "usage: $0 [--validate] [BACKUP]" >&2; exit 2; }
backup=${1:-}

case "$home" in /*) ;; *) echo "unsafe restore home: $home" >&2; exit 1 ;; esac
[ "$home" != / ] || { echo "unsafe restore home: /" >&2; exit 1; }
pac_assert_real_directory "$home" "restore home"
home=$(unset CDPATH; cd -- "$home" && pwd -P)
state="$home/.local/state/personal-agent-control"
backup_root="$home/.agent-work/backups/personal-agent-control"

if [ -z "$backup" ]; then
    [ -f "$state/last-backup" ] && [ ! -L "$state/last-backup" ] || {
        echo "no recorded Personal Agent Control backup" >&2
        exit 1
    }
    backup=$(sed -n '1p' "$state/last-backup")
fi

[ -d "$backup_root" ] && [ ! -L "$backup_root" ] || {
    echo "invalid backup root: $backup_root" >&2
    exit 1
}
[ -d "$backup" ] && [ ! -L "$backup" ] || {
    echo "invalid backup: $backup" >&2
    exit 1
}
pac_assert_safe_ancestors "$home" \
    ".agent-work/backups/personal-agent-control/.guard" "backup root"
backup_root=$(unset CDPATH; cd -- "$backup_root" && pwd -P)
backup=$(unset CDPATH; cd -- "$backup" && pwd -P)
case "$backup" in "$backup_root/"*) ;; *) echo "refusing backup outside $backup_root" >&2; exit 1 ;; esac
backup_leaf=${backup#"$backup_root/"}
case "$backup_leaf" in ''|*/*|.|..) echo "refusing non-snapshot backup path: $backup" >&2; exit 1 ;; esac
[ -f "$backup/managed-paths.txt" ] && [ ! -L "$backup/managed-paths.txt" ] || {
    echo "invalid backup manifest: $backup/managed-paths.txt" >&2
    exit 1
}
pac_assert_real_directory "$backup/home" "backup home"
[ -f "$backup/metadata.txt" ] && [ ! -L "$backup/metadata.txt" ] || {
    echo "invalid backup metadata" >&2
    exit 1
}
backup_source=$(sed -n 's/^source=//p' "$backup/metadata.txt")
[ -n "$backup_source" ] && [ "$backup_source" = "$repo" ] || {
    echo "backup belongs to a different PAC source: ${backup_source:-unknown}" >&2
    exit 1
}

valid_name() {
    case "$1" in ''|-*|*-|*/*|*[!a-z0-9-]*) return 1 ;; *) return 0 ;; esac
}

validate_path() {
    rel=$1
    kind='file'
    case "$rel" in
        .local/bin/pac|.local/bin/mise)
            kind='any'
            ;;
        .local/share/agent-skills|.local/state/personal-agent-control)
            kind='directory'
            ;;
        .codex/config.toml|.codex/AGENTS.md|\
        .codex/hooks.json|\
        .codex/agents/independent-reviewer.toml|.codex/agents/pac-reviewer.toml|\
        .claude.json|.claude/.claude.json|.claude/settings.json|\
        .claude/plugins/installed_plugins.json|.claude/plugins/known_marketplaces.json|\
        .claude/CLAUDE.md|.claude/agents/independent-reviewer.md|\
        .claude/agents/pac-reviewer.md)
            ;;
        .config/personal-agent-control/machine.json|\
        .config/personal-agent-control/profile.json|\
        .config/personal-agent-control/profile-bootstrap.md|\
        .config/personal-agent-control/state.boltdb|\
        .local/share/agent-skills/apm.lock.yaml|\
        .local/state/personal-agent-control/last-backup|\
        .local/state/personal-agent-control/scan-guard.json|\
        .local/state/personal-agent-control/owned-host-adapters.json|\
        .local/state/personal-agent-control/owned-providers.json|\
        .local/state/personal-agent-control/profile-bootstrap.json|\
        .local/state/personal-agent-control/owned-skills.txt|\
        .local/state/personal-agent-control/owned-skill-map.json|\
        .local/state/personal-agent-control/owned-plugins.tsv|\
        .local/state/personal-agent-control/external-skills.json)
            ;;
        .agent-work/runtime/pac/scan-guard-hook.mjs)
            ;;
        .local/share/agent-skills/apm_modules)
            kind='directory'
            ;;
        .local/share/agent-skills/.agents/skills/*)
            name=${rel#.local/share/agent-skills/.agents/skills/}
            valid_name "$name" || return 1
            kind='directory'
            ;;
        .local/state/personal-agent-control/migrations/*)
            name=${rel#.local/state/personal-agent-control/migrations/}
            valid_name "$name" || return 1
            ;;
        .agents/skills/*)
            name=${rel#.agents/skills/}; valid_name "$name" || return 1
            kind='any'
            ;;
        .codex/skills/*)
            name=${rel#.codex/skills/}; valid_name "$name" || return 1
            kind='any'
            ;;
        .claude/skills/*)
            name=${rel#.claude/skills/}; valid_name "$name" || return 1
            kind='any'
            ;;
        .local/share/agent-plugins/sources/*)
            name=${rel#.local/share/agent-plugins/sources/}; valid_name "$name" || return 1
            kind='directory'
            ;;
        .codex/plugins/cache/*)
            name=${rel#.codex/plugins/cache/}; valid_name "$name" || return 1
            kind='directory'
            ;;
        .codex/.tmp/marketplaces/*)
            name=${rel#.codex/.tmp/marketplaces/}; valid_name "$name" || return 1
            kind='directory'
            ;;
        .claude/plugins/cache/*)
            name=${rel#.claude/plugins/cache/}; valid_name "$name" || return 1
            kind='directory'
            ;;
        .claude/plugins/marketplaces/*)
            name=${rel#.claude/plugins/marketplaces/}; valid_name "$name" || return 1
            kind='directory'
            ;;
        *) return 1 ;;
    esac
    pac_assert_safe_ancestors "$home" "$rel" "restore destination"
    pac_assert_safe_ancestors "$backup/home" "$rel" "restore source"
    saved="$backup/home/$rel"
    if [ -e "$saved" ] || [ -L "$saved" ]; then
        case "$kind" in
            file) [ -f "$saved" ] && [ ! -L "$saved" ] || return 1 ;;
            directory) [ -d "$saved" ] && [ ! -L "$saved" ] || return 1 ;;
            any) ;;
        esac
    fi
}

umask 077
validated=$(mktemp "${TMPDIR:-/tmp}/pac-restore-paths.XXXXXX")
validated_repo=$(mktemp "${TMPDIR:-/tmp}/pac-restore-repo-paths.XXXXXX")
trap 'rm -f -- "$validated" "$validated_repo"' EXIT HUP INT TERM
: > "$validated"
: > "$validated_repo"
while IFS= read -r rel; do
    [ -n "$rel" ] || { echo "empty backup path" >&2; exit 1; }
    validate_path "$rel" || { echo "unsafe backup path: $rel" >&2; exit 1; }
    if grep -Fqx "$rel" "$validated"; then
        echo "duplicate backup path: $rel" >&2
        exit 1
    fi
    printf '%s\n' "$rel" >> "$validated"
done < "$backup/managed-paths.txt"

if [ -e "$backup/managed-repo-paths.txt" ] || [ -L "$backup/managed-repo-paths.txt" ]; then
    [ -f "$backup/managed-repo-paths.txt" ] && \
        [ ! -L "$backup/managed-repo-paths.txt" ] || {
        echo "invalid repository backup manifest" >&2
        exit 1
    }
    pac_assert_real_directory "$backup/repo" "backup repository root"
    while IFS= read -r rel; do
        case "$rel" in
            pac.json|packages/skills/apm.yml|packages/skills/apm.lock.yaml|\
            catalog/capabilities.jsonl|catalog/providers.json|catalog/files.sha256) ;;
            *) echo "unsafe repository backup path: $rel" >&2; exit 1 ;;
        esac
        pac_assert_safe_ancestors "$repo" "$rel" "repository restore destination"
        pac_assert_safe_ancestors "$backup/repo" "$rel" "repository restore source"
        saved="$backup/repo/$rel"
        if [ -e "$saved" ] || [ -L "$saved" ]; then
            [ -f "$saved" ] && [ ! -L "$saved" ] || {
                echo "unsafe repository backup object: $rel" >&2
                exit 1
            }
        fi
        grep -Fqx "$rel" "$validated_repo" && {
            echo "duplicate repository backup path: $rel" >&2
            exit 1
        }
        printf '%s\n' "$rel" >> "$validated_repo"
    done < "$backup/managed-repo-paths.txt"
fi

# Validate the derived cache before touching any recoverable state.  It is not
# backed up; a normal apply rebuilds it from canonical metadata.
cache_rel=.cache/personal-agent-control
pac_assert_safe_ancestors "$home" "$cache_rel/capabilities-v1.sqlite" \
    "capability index"
cache="$home/$cache_rel"
if [ -e "$cache" ] || [ -L "$cache" ]; then
    [ -d "$cache" ] && [ ! -L "$cache" ] || {
        echo "unsafe capability cache: $cache" >&2
        exit 1
    }
fi

if [ "$mode" = validate ]; then
    echo "validated recoverable PAC backup: $backup"
    exit 0
fi

while IFS= read -r rel; do
    target="$home/$rel"
    rm -rf -- "$target"
    if [ -e "$backup/home/$rel" ] || [ -L "$backup/home/$rel" ]; then
        mkdir -p "$(dirname -- "$target")"
        cp -Rp "$backup/home/$rel" "$target"
    fi
done < "$validated"

while IFS= read -r rel; do
    target="$repo/$rel"
    rm -rf -- "$target"
    if [ -e "$backup/repo/$rel" ] || [ -L "$backup/repo/$rel" ]; then
        mkdir -p "$(dirname -- "$target")"
        cp -Rp "$backup/repo/$rel" "$target"
    fi
done < "$validated_repo"

rm -rf -- "$cache"
echo "restored $backup and invalidated the derived capability index"
echo "run pac apply before starting fresh Codex or Claude sessions"
