#!/bin/sh
set -eu

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd -P)
mode=${1:---check}

case "$mode" in
    --check|--write) ;;
    *)
        echo "usage: $0 [--check|--write]" >&2
        exit 2
        ;;
esac

command -v rulesync >/dev/null 2>&1 || {
    echo "rulesync is unavailable; run the pinned mise environment" >&2
    exit 1
}

tmp=${TMPDIR:-/tmp}/pac-render.$$
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/home"

(
    cd "$repo"
    HOME="$tmp/home" \
    XDG_CONFIG_HOME="$tmp/home/.config" \
    XDG_CACHE_HOME="$tmp/home/.cache" \
        rulesync generate
)

codex_rules="$tmp/home/.codex/AGENTS.md"
codex_agent="$tmp/home/.codex/agents/independent-reviewer.toml"
claude_rules="$tmp/home/.claude/CLAUDE.md"
claude_agent="$tmp/home/.claude/agents/independent-reviewer.md"

for file in "$codex_rules" "$codex_agent" "$claude_rules" "$claude_agent"; do
    if [ ! -s "$file" ]; then
        echo "rulesync did not generate expected file: $file" >&2
        exit 1
    fi
done

codex_size=$(wc -c < "$codex_rules" | tr -d ' ')
if [ "$codex_size" -gt 32768 ]; then
    echo "generated Codex instructions exceed the default 32 KiB discovery limit" >&2
    exit 1
fi

find "$tmp/home" -type f | sed "s|^$tmp/home/||" | LC_ALL=C sort > "$tmp/actual-files"
cat > "$tmp/expected-files" <<'EOF'
.claude/CLAUDE.md
.claude/agents/independent-reviewer.md
.codex/AGENTS.md
.codex/agents/independent-reviewer.toml
EOF

if ! cmp -s "$tmp/expected-files" "$tmp/actual-files"; then
    echo "rulesync generated an unexpected ownership surface:" >&2
    diff -u "$tmp/expected-files" "$tmp/actual-files" >&2 || true
    exit 1
fi

if [ "$mode" = "--write" ]; then
    mkdir -p "$repo/generated/codex/agents" "$repo/generated/claude/agents"
    cp "$codex_rules" "$repo/generated/codex/AGENTS.md"
    cp "$codex_agent" "$repo/generated/codex/agents/independent-reviewer.toml"
    cp "$claude_rules" "$repo/generated/claude/CLAUDE.md"
    cp "$claude_agent" "$repo/generated/claude/agents/independent-reviewer.md"
    echo "updated generated Codex and Claude adapters"
    exit 0
fi

status=0
for pair in \
    "$codex_rules:$repo/generated/codex/AGENTS.md" \
    "$codex_agent:$repo/generated/codex/agents/independent-reviewer.toml" \
    "$claude_rules:$repo/generated/claude/CLAUDE.md" \
    "$claude_agent:$repo/generated/claude/agents/independent-reviewer.md"
do
    actual=${pair%%:*}
    committed=${pair#*:}
    if [ ! -f "$committed" ] || ! cmp -s "$actual" "$committed"; then
        echo "generated adapter is stale: ${committed#"$repo/"}" >&2
        if [ -f "$committed" ]; then
            diff -u "$committed" "$actual" >&2 || true
        fi
        status=1
    fi
done

[ "$status" -eq 0 ] || exit "$status"
echo "generated adapters match canonical Rulesync inputs"
