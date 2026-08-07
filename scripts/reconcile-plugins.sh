#!/bin/sh
set -eu

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd -P)
# shellcheck source=/dev/null
. "$repo/scripts/path-safety.sh"

mode=${1:-}
case "$mode" in apply|check) shift ;; *)
    echo "usage: $0 apply|check [--home PATH] [--agents codex|claude|codex,claude] [--catalog PATH]" >&2
    exit 2
esac

home=${HOME:?HOME is required}
agents=codex,claude
catalog="$repo/catalog/plugins.tsv"
migrations_catalog="$repo/catalog/plugin-migrations.tsv"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --home)
            [ "$#" -ge 2 ] || { echo "--home needs a value" >&2; exit 2; }
            home=$2
            shift 2
            ;;
        --agents)
            [ "$#" -ge 2 ] || { echo "--agents needs a value" >&2; exit 2; }
            agents=$2
            shift 2
            ;;
        --catalog)
            [ "$#" -ge 2 ] || { echo "--catalog needs a value" >&2; exit 2; }
            catalog=$2
            shift 2
            ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

case "$home" in /*) ;; *) echo "home must be absolute: $home" >&2; exit 2 ;; esac
case "$agents" in codex|claude|codex,claude|claude,codex) ;;
    *) echo "invalid agent selection: $agents" >&2; exit 2 ;;
esac
[ -f "$catalog" ] && [ ! -L "$catalog" ] || {
    echo "invalid Plugin catalog: $catalog" >&2
    exit 2
}
[ -f "$migrations_catalog" ] && [ ! -L "$migrations_catalog" ] || {
    echo "invalid Plugin migration catalog: $migrations_catalog" >&2
    exit 2
}

for command_name in git node; do
    command -v "$command_name" >/dev/null 2>&1 || {
        echo "$command_name is required for Plugin reconciliation" >&2
        exit 1
    }
done

has_agent() {
    case ",$agents," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

target_includes() {
    case ",$2," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

awk -F '\t' 'BEGIN { ok = 1 }
    NR == 1 {
        expected = "# plugin\tmarketplace\tacquisition\tsource\tref\tresolved-commit\ttree-id\tversion\ttargets\tbundled-skills\tlicense\tvisibility"
        if ($0 != expected) { print "invalid Plugin catalog header" > "/dev/stderr"; ok = 0 }
        next
    }
    /^#/ || NF == 0 { next }
    NF != 12 { print "invalid Plugin row " NR > "/dev/stderr"; ok = 0; next }
    $1 !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ { print "invalid Plugin name " $1 > "/dev/stderr"; ok = 0 }
    $2 !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ { print "invalid marketplace name " $2 > "/dev/stderr"; ok = 0 }
    $3 !~ /^github-(tag|commit)$/ { print "invalid Plugin acquisition " $3 > "/dev/stderr"; ok = 0 }
    $4 == "" || $4 ~ /[[:space:]]/ { print "invalid Plugin source " $4 > "/dev/stderr"; ok = 0 }
    $3 == "github-tag" && ($5 ~ /^(main|master|HEAD)$/ || $5 !~ /^[A-Za-z0-9._-]+$/) { print "Plugin ref must be a pinned tag: " $5 > "/dev/stderr"; ok = 0 }
    $3 == "github-commit" && $5 != "-" { print "commit Plugin acquisition must use - as ref" > "/dev/stderr"; ok = 0 }
    length($6) != 40 || $6 !~ /^[0-9a-f]+$/ { print "invalid Plugin commit " $6 > "/dev/stderr"; ok = 0 }
    length($7) != 40 || $7 !~ /^[0-9a-f]+$/ { print "invalid Plugin tree " $7 > "/dev/stderr"; ok = 0 }
    $8 !~ /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/ { print "invalid Plugin version " $8 > "/dev/stderr"; ok = 0 }
    $9 !~ /^(codex|claude|codex,claude)$/ { print "invalid Plugin targets " $9 > "/dev/stderr"; ok = 0 }
    $10 == "" { print "missing bundled Skill inventory for " $1 > "/dev/stderr"; ok = 0 }
    $11 == "" || $12 !~ /^(common|private)$/ { print "invalid Plugin provenance row " NR > "/dev/stderr"; ok = 0 }
    {
        pair = $1 SUBSEP $2
        if (seen_pair[pair]) { print "duplicate Plugin identity " $1 "@" $2 > "/dev/stderr"; ok = 0 }
        seen_pair[pair] = 1
        source_spec = $3 SUBSEP $4 SUBSEP $5 SUBSEP $6 SUBSEP $7
        if (($2 in marketplace_spec) && marketplace_spec[$2] != source_spec) {
            print "marketplace source mismatch for " $2 > "/dev/stderr"; ok = 0
        }
        marketplace_spec[$2] = source_spec
        count = split($10, skills, ",")
        for (i = 1; i <= count; i++) {
            if (skills[i] !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/) {
                print "invalid bundled Skill " skills[i] > "/dev/stderr"; ok = 0
            } else if (seen_skill[skills[i]]) {
                print "bundled Skill appears in multiple Plugins: " skills[i] > "/dev/stderr"; ok = 0
            }
            seen_skill[skills[i]] = 1
        }
    }
    END { exit !ok }
' "$catalog"

awk -F '\t' 'BEGIN { ok = 1 }
    NR == 1 {
        expected = "# plugin\tmarketplace\ttargets\treplacement\tmarker-base"
        if ($0 != expected) { print "invalid Plugin migration catalog header" > "/dev/stderr"; ok = 0 }
        next
    }
    /^#/ || NF == 0 { next }
    NF != 5 { print "invalid Plugin migration row " NR > "/dev/stderr"; ok = 0; next }
    $1 !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ || $2 !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ {
        print "invalid retired Plugin identity " NR > "/dev/stderr"; ok = 0
    }
    $3 !~ /^(codex|claude|codex,claude)$/ { print "invalid retired Plugin targets " $3 > "/dev/stderr"; ok = 0 }
    $4 !~ /^(skill|plugin):[a-z0-9][a-z0-9-]*[a-z0-9]$/ { print "invalid Plugin replacement " $4 > "/dev/stderr"; ok = 0 }
    $5 !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ { print "invalid Plugin migration marker " $5 > "/dev/stderr"; ok = 0 }
    {
        pair = $1 SUBSEP $2
        if (seen[pair]) { print "duplicate Plugin migration " $1 "@" $2 > "/dev/stderr"; ok = 0 }
        seen[pair] = 1
    }
    END { exit !ok }
' "$migrations_catalog"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/pac-plugins.XXXXXX")
marker_tmp=
cleanup() {
    [ -z "$marker_tmp" ] || rm -f -- "$marker_tmp"
    rm -rf -- "$tmp"
}
trap cleanup EXIT HUP INT TERM
: > "$tmp/protected-marketplaces"
source_parent="$home/.local/share/agent-plugins/sources"
state_dir="$home/.local/state/personal-agent-control"
owned="$state_dir/owned-plugins.tsv"
pac_assert_safe_ancestors "$home" \
    ".local/share/agent-plugins/sources/.guard" "Plugin source store"
pac_assert_safe_ancestors "$home" \
    ".local/state/personal-agent-control/owned-plugins.tsv" "Plugin ownership state"
if [ -e "$owned" ] || [ -L "$owned" ]; then
    [ -f "$owned" ] && [ ! -L "$owned" ] || {
        echo "unsafe Plugin ownership state: $owned" >&2
        exit 1
    }
fi
if [ -f "$owned" ]; then
    awk -F '\t' 'BEGIN { ok = 1 }
        NR == 1 {
            expected = "# plugin\tmarketplace\ttargets"
            if ($0 != expected) {
                print "invalid Plugin ownership header" > "/dev/stderr"
                ok = 0
            }
            next
        }
        {
            if (NF != 3) {
                print "invalid Plugin ownership row " NR > "/dev/stderr"
                ok = 0
                next
            }
            if ($1 !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/) {
                print "invalid Plugin ownership name " $1 > "/dev/stderr"
                ok = 0
            }
            if ($2 !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/) {
                print "invalid Plugin ownership marketplace " $2 > "/dev/stderr"
                ok = 0
            }
            if ($3 !~ /^(codex|claude|codex,claude)$/) {
                print "invalid Plugin ownership targets " $3 > "/dev/stderr"
                ok = 0
            }
            identity = $1 SUBSEP $2
            if (seen[identity]++) {
                print "duplicate Plugin ownership identity " $1 "@" $2 > "/dev/stderr"
                ok = 0
            }
        }
        END {
            if (NR == 0) {
                print "missing Plugin ownership header" > "/dev/stderr"
                ok = 0
            }
            exit !ok
        }
    ' "$owned" || exit 1
    awk -F '\t' '$0 !~ /^#/ && NF { print $2 }' "$owned" | LC_ALL=C sort -u \
        > "$tmp/prior-owned-marketplaces"
else
    : > "$tmp/prior-owned-marketplaces"
fi

marketplace_was_owned() {
    [ -f "$owned" ] && awk -F '\t' -v marketplace="$1" \
        '$0 !~ /^#/ && $2 == marketplace { found = 1 } END { exit !found }' "$owned"
}

source_current() {
    marketplace=$1
    acquisition=$2
    source=$3
    ref=$4
    commit=$5
    tree=$6
    directory="$source_parent/$marketplace"
    [ -d "$directory" ] && [ ! -L "$directory" ] && [ -d "$directory/.git" ] || return 1
    [ "$(git -C "$directory" remote get-url origin 2>/dev/null)" = "$source" ] || return 1
    [ "$(git -C "$directory" rev-parse HEAD 2>/dev/null)" = "$commit" ] || return 1
    [ "$(git -C "$directory" rev-parse 'HEAD^{tree}' 2>/dev/null)" = "$tree" ] || return 1
    [ -z "$(git -C "$directory" status --porcelain --untracked-files=all 2>/dev/null)" ] || return 1
    if [ "$acquisition" = github-tag ]; then
        [ "$(git -C "$directory" rev-parse "$ref^{commit}" 2>/dev/null)" = "$commit" ] || return 1
    fi
}

install_source() {
    marketplace=$1
    acquisition=$2
    source=$3
    ref=$4
    commit=$5
    tree=$6
    directory="$source_parent/$marketplace"
    if source_current "$marketplace" "$acquisition" "$source" "$ref" "$commit" "$tree"; then
        return
    fi
    if [ -e "$directory" ] || [ -L "$directory" ]; then
        if [ ! -d "$directory" ] || [ -L "$directory" ] || \
            ! marketplace_was_owned "$marketplace"; then
            echo "unowned or unsafe Plugin source conflicts with $directory" >&2
            exit 1
        fi
    fi

    mkdir -p "$source_parent"
    pac_assert_real_directory "$source_parent" "Plugin source store"
    new="$source_parent/.$marketplace.new.$$"
    old="$source_parent/.$marketplace.old.$$"
    [ ! -e "$new" ] && [ ! -L "$new" ] && [ ! -e "$old" ] && [ ! -L "$old" ] || {
        echo "stale Plugin source transaction for $marketplace" >&2
        exit 1
    }
    git clone --quiet --no-checkout -- "$source" "$new"
    if [ "$acquisition" = github-tag ]; then
        actual=$(git -C "$new" rev-parse "$ref^{commit}" 2>/dev/null || true)
        [ "$actual" = "$commit" ] || {
            rm -rf -- "$new"
            echo "Plugin tag moved or is unavailable: $source@$ref" >&2
            exit 1
        }
    fi
    git -C "$new" checkout --quiet --detach "$commit"
    [ "$(git -C "$new" rev-parse 'HEAD^{tree}')" = "$tree" ] || {
        rm -rf -- "$new"
        echo "Plugin tree mismatch: $marketplace" >&2
        exit 1
    }
    if [ -e "$directory" ]; then mv -- "$directory" "$old"; fi
    if mv -- "$new" "$directory"; then
        [ ! -e "$old" ] || rm -rf -- "$old"
    else
        [ ! -e "$old" ] || mv -- "$old" "$directory"
        exit 1
    fi
}

awk -F '\t' '$0 !~ /^#/ && NF && !seen[$2]++ {
    print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7
}' "$catalog" > "$tmp/marketplaces"

while IFS="$(printf '\t')" read -r marketplace acquisition source ref commit tree; do
    [ -n "$marketplace" ] || continue
    if [ "$mode" = apply ]; then
        install_source "$marketplace" "$acquisition" "$source" "$ref" "$commit" "$tree"
    elif ! source_current "$marketplace" "$acquisition" "$source" "$ref" "$commit" "$tree"; then
        echo "DRIFT: Plugin source $source_parent/$marketplace" >&2
        exit 1
    fi
done < "$tmp/marketplaces"

while IFS="$(printf '\t')" read -r plugin marketplace _acquisition _source _ref _commit _tree _version _targets bundled _rest; do
    case "$plugin" in ''|'#'*) continue ;; esac
    directory="$source_parent/$marketplace"
    remaining=$bundled
    while [ -n "$remaining" ]; do
        case "$remaining" in
            *,*) skill=${remaining%%,*}; remaining=${remaining#*,} ;;
            *) skill=$remaining; remaining= ;;
        esac
        if ! find "$directory" -type f -path "*/skills/$skill/SKILL.md" -print -quit | grep -q .; then
            echo "MISSING: Plugin $plugin does not contain bundled Skill $skill" >&2
            exit 1
        fi
    done
done < "$catalog"

run_host() {
    env HOME="$home" \
        XDG_CONFIG_HOME="$home/.config" \
        XDG_DATA_HOME="$home/.local/share" \
        XDG_CACHE_HOME="$home/.cache" \
        XDG_STATE_HOME="$home/.local/state" "$@"
}

refresh_host() {
    host_name=$1
    case "$host_name" in
        codex)
            run_host codex plugin marketplace list --json \
                > "$tmp/$host_name-marketplaces.json" || return 1
            run_host codex plugin list --json \
                > "$tmp/$host_name-plugins.json" || return 1
            ;;
        claude)
            run_host claude plugin marketplace list --json \
                > "$tmp/$host_name-marketplaces.json" || return 1
            run_host claude plugin list --json \
                > "$tmp/$host_name-plugins.json" || return 1
            ;;
    esac
    json_test plugins-for-marketplace "$host_name" \
        "$tmp/$host_name-plugins.json" __pac_inventory_validation__ \
        >/dev/null || return $?
    if json_test marketplace-present "$host_name" \
        "$tmp/$host_name-marketplaces.json" __pac_inventory_validation__; then
        :
    else
        inventory_status=$?
        [ "$inventory_status" -eq 1 ] || return "$inventory_status"
    fi
}

json_test() {
    node "$repo/scripts/plugin-json.mjs" "$@"
}

plugin_present() {
    json_test plugin-present "$1" "$tmp/$1-plugins.json" "$2"
}

marketplace_present() {
    json_test marketplace-present "$1" "$tmp/$1-marketplaces.json" "$2"
}

uninstall_plugin() {
    host_name=$1
    id=$2
    case "$host_name" in
        codex) run_host codex plugin remove "$id" --json >/dev/null ;;
        claude) run_host claude plugin uninstall "$id" --scope user --keep-data -y >/dev/null ;;
    esac
}

remove_marketplace() {
    host_name=$1
    marketplace=$2
    case "$host_name" in
        codex) run_host codex plugin marketplace remove "$marketplace" --json >/dev/null ;;
        claude) run_host claude plugin marketplace remove "$marketplace" --scope user >/dev/null ;;
    esac
}

add_marketplace() {
    host_name=$1
    directory=$2
    case "$host_name" in
        codex) run_host codex plugin marketplace add "$directory" --json >/dev/null ;;
        claude) run_host claude plugin marketplace add "$directory" --scope user >/dev/null ;;
    esac
}

install_plugin() {
    host_name=$1
    id=$2
    case "$host_name" in
        codex) run_host codex plugin add "$id" --json >/dev/null ;;
        claude) run_host claude plugin install "$id" --scope user >/dev/null ;;
    esac
}

desired_ids() {
    host_name=$1
    marketplace=$2
    output=$3
    : > "$output"
    while IFS="$(printf '\t')" read -r plugin row_marketplace _a _s _r _c _t _v targets _rest; do
        case "$plugin" in ''|'#'*) continue ;; esac
        if [ "$row_marketplace" = "$marketplace" ] && target_includes "$host_name" "$targets"; then
            printf '%s@%s\n' "$plugin" "$marketplace" >> "$output"
        fi
    done < "$catalog"
    LC_ALL=C sort -u "$output" -o "$output"
}

host_has_desired_plugins() {
    host_name=$1
    while IFS="$(printf '\t')" read -r plugin _marketplace _a _s _r _c _t _v targets _rest; do
        case "$plugin" in ''|'#'*) continue ;; esac
        if target_includes "$host_name" "$targets"; then return 0; fi
    done < "$catalog"
    return 1
}

host_was_owned() {
    host_name=$1
    [ -f "$owned" ] || return 1
    while IFS="$(printf '\t')" read -r plugin _marketplace targets; do
        case "$plugin" in ''|'#'*) continue ;; esac
        if target_includes "$host_name" "$targets"; then return 0; fi
    done < "$owned"
    return 1
}

plugin_was_owned_for_host() {
    host_name=$1
    plugin_name=$2
    marketplace_name=$3
    [ -f "$owned" ] || return 1
    while IFS="$(printf '\t')" read -r plugin marketplace targets; do
        case "$plugin" in ''|'#'*) continue ;; esac
        if [ "$plugin" = "$plugin_name" ] && [ "$marketplace" = "$marketplace_name" ] && \
            target_includes "$host_name" "$targets"; then
            return 0
        fi
    done < "$owned"
    return 1
}

protect_marketplace() {
    printf '%s\n' "$1" >> "$tmp/protected-marketplaces"
}

source_referenced_by_any_host() {
    shared_marketplace=$1
    for shared_host in codex claude; do
        command -v "$shared_host" >/dev/null 2>&1 || return 0
        refresh_host "$shared_host" || return 0
        if ! json_test plugins-for-marketplace "$shared_host" \
            "$tmp/$shared_host-plugins.json" "$shared_marketplace" \
            > "$tmp/$shared_host-shared-source-plugins"; then
            return 0
        fi
        [ ! -s "$tmp/$shared_host-shared-source-plugins" ] || return 0
        marketplace_present "$shared_host" "$shared_marketplace" && return 0
    done
    return 1
}

process_migrations_for_host() {
    host_name=$1
    while IFS="$(printf '\t')" read -r plugin marketplace targets replacement marker_base; do
        case "$plugin" in ''|'#'*) continue ;; esac
        target_includes "$host_name" "$targets" || continue
        marker_rel=".local/state/personal-agent-control/migrations/$marker_base-$host_name"
        marker="$home/$marker_rel"
        pac_assert_safe_ancestors "$home" "$marker_rel" "Plugin migration marker"
        if [ -e "$marker" ] || [ -L "$marker" ]; then
            [ -f "$marker" ] && [ ! -L "$marker" ] || {
                echo "unsafe Plugin migration marker: $marker" >&2
                exit 1
            }
            [ "$(cat "$marker")" = "replacement=$replacement" ] || {
                echo "invalid Plugin migration marker: $marker" >&2
                exit 1
            }
            continue
        fi
        [ "$mode" = apply ] || {
            echo "MISSING: Plugin migration marker $marker" >&2
            exit 1
        }
        migration_owned=false
        if plugin_was_owned_for_host "$host_name" "$plugin" "$marketplace"; then
            migration_owned=true
        fi
        refresh_host "$host_name"
        if [ "$migration_owned" = true ] && plugin_present "$host_name" "$plugin@$marketplace"; then
            uninstall_plugin "$host_name" "$plugin@$marketplace"
        fi
        desired_ids "$host_name" "$marketplace" "$tmp/desired-migration"
        if [ "$migration_owned" = true ] && [ ! -s "$tmp/desired-migration" ]; then
            refresh_host "$host_name"
            json_test plugins-for-marketplace "$host_name" "$tmp/$host_name-plugins.json" \
                "$marketplace" > "$tmp/migration-marketplace-plugins"
            if [ ! -s "$tmp/migration-marketplace-plugins" ] && \
                marketplace_present "$host_name" "$marketplace"; then
                remove_marketplace "$host_name" "$marketplace"
            fi
        fi
        mkdir -p "$state_dir/migrations"
        pac_assert_real_directory "$state_dir/migrations" "PAC migration state"
        marker_tmp=$(mktemp "$state_dir/migrations/.$marker_base-$host_name.XXXXXX")
        chmod 600 "$marker_tmp"
        printf 'replacement=%s\n' "$replacement" > "$marker_tmp"
        mv -f -- "$marker_tmp" "$marker"
        marker_tmp=
    done < "$migrations_catalog"
}

assert_no_unmanaged_in_marketplace() {
    host_name=$1
    marketplace=$2
    desired=$3
    json_test plugins-for-marketplace "$host_name" "$tmp/$host_name-plugins.json" \
        "$marketplace" > "$tmp/$host_name-$marketplace-actual-unsorted"
    LC_ALL=C sort -u "$tmp/$host_name-$marketplace-actual-unsorted" \
        > "$tmp/$host_name-$marketplace-actual"
    comm -23 "$tmp/$host_name-$marketplace-actual" "$desired" \
        > "$tmp/$host_name-$marketplace-unmanaged"
    if [ -s "$tmp/$host_name-$marketplace-unmanaged" ]; then
        echo "UNMANAGED: installed $host_name Plugin(s) from managed marketplace $marketplace:" >&2
        sed 's/^/  /' "$tmp/$host_name-$marketplace-unmanaged" >&2
        exit 1
    fi
}

marketplace_exact() {
    host_name=$1
    marketplace=$2
    directory=$3
    desired=$4
    json_test marketplace-exact "$host_name" "$tmp/$host_name-marketplaces.json" \
        "$marketplace" "$directory" || return 1
    while IFS="$(printf '\t')" read -r plugin row_marketplace _a _s _r _c _t version targets _rest; do
        case "$plugin" in ''|'#'*) continue ;; esac
        if [ "$row_marketplace" = "$marketplace" ] && target_includes "$host_name" "$targets"; then
            json_test plugin-exact "$host_name" "$tmp/$host_name-plugins.json" \
                "$plugin@$marketplace" "$version" "$directory" || return 1
        fi
    done < "$catalog"
    assert_no_unmanaged_in_marketplace "$host_name" "$marketplace" "$desired"
}

current_targets_for() {
    plugin=$1
    marketplace=$2
    awk -F '\t' -v plugin="$plugin" -v marketplace="$marketplace" \
        '$0 !~ /^#/ && $1 == plugin && $2 == marketplace { print $9; exit }' "$catalog"
}

retire_old_for_host() {
    host_name=$1
    host_is_active=$2
    [ -f "$owned" ] || return 0
    while IFS="$(printf '\t')" read -r plugin marketplace old_targets; do
        case "$plugin" in ''|'#'*) continue ;; esac
        target_includes "$host_name" "$old_targets" || continue
        current_targets=$(current_targets_for "$plugin" "$marketplace")
        if [ -n "$current_targets" ] && target_includes "$host_name" "$current_targets"; then
            continue
        fi
        refresh_host "$host_name"
        if plugin_present "$host_name" "$plugin@$marketplace"; then
            [ "$mode" = apply ] || {
                echo "DRIFT: retired $host_name Plugin remains: $plugin@$marketplace" >&2
                exit 1
            }
            uninstall_plugin "$host_name" "$plugin@$marketplace"
        fi
    done < "$owned"

    : > "$tmp/old-marketplaces-unsorted"
    while IFS="$(printf '\t')" read -r plugin marketplace old_targets; do
        case "$plugin" in ''|'#'*) continue ;; esac
        if target_includes "$host_name" "$old_targets"; then
            printf '%s\n' "$marketplace" >> "$tmp/old-marketplaces-unsorted"
        fi
    done < "$owned"
    LC_ALL=C sort -u "$tmp/old-marketplaces-unsorted" > "$tmp/old-marketplaces"
    while IFS= read -r marketplace; do
        [ -n "$marketplace" ] || continue
        desired_ids "$host_name" "$marketplace" "$tmp/desired-retirement"
        [ ! -s "$tmp/desired-retirement" ] || continue
        refresh_host "$host_name"
        if [ "$host_is_active" = true ]; then
            assert_no_unmanaged_in_marketplace "$host_name" "$marketplace" "$tmp/desired-retirement"
        else
            json_test plugins-for-marketplace "$host_name" "$tmp/$host_name-plugins.json" \
                "$marketplace" > "$tmp/inactive-marketplace-plugins"
            if [ -s "$tmp/inactive-marketplace-plugins" ]; then
                protect_marketplace "$marketplace"
                continue
            fi
        fi
        if marketplace_present "$host_name" "$marketplace"; then
            [ "$mode" = apply ] || {
                echo "DRIFT: retired $host_name marketplace remains: $marketplace" >&2
                exit 1
            }
            remove_marketplace "$host_name" "$marketplace"
        fi
    done < "$tmp/old-marketplaces"
}

reconcile_current_for_host() {
    host_name=$1
    while IFS="$(printf '\t')" read -r marketplace _rest; do
        [ -n "$marketplace" ] || continue
        desired_ids "$host_name" "$marketplace" "$tmp/desired-current"
        [ -s "$tmp/desired-current" ] || continue
        directory=$(unset CDPATH; cd -- "$source_parent/$marketplace" && pwd -P)
        refresh_host "$host_name"
        if marketplace_exact "$host_name" "$marketplace" "$directory" "$tmp/desired-current"; then
            continue
        fi
        [ "$mode" = apply ] || {
            echo "DRIFT: $host_name Plugin marketplace $marketplace" >&2
            exit 1
        }
        assert_no_unmanaged_in_marketplace "$host_name" "$marketplace" "$tmp/desired-current"
        while IFS= read -r id; do
            if plugin_present "$host_name" "$id"; then uninstall_plugin "$host_name" "$id"; fi
        done < "$tmp/desired-current"
        refresh_host "$host_name"
        if marketplace_present "$host_name" "$marketplace"; then
            remove_marketplace "$host_name" "$marketplace"
        fi
        add_marketplace "$host_name" "$directory"
        while IFS= read -r id; do install_plugin "$host_name" "$id"; done \
            < "$tmp/desired-current"
        refresh_host "$host_name"
        marketplace_exact "$host_name" "$marketplace" "$directory" "$tmp/desired-current" || {
            echo "Plugin installation did not converge: $host_name/$marketplace" >&2
            exit 1
        }
    done < "$tmp/marketplaces"
}

assert_all_installed_managed() {
    host_name=$1
    : > "$tmp/$host_name-all-desired"
    while IFS="$(printf '\t')" read -r plugin marketplace _a _s _r _c _t _v targets _rest; do
        case "$plugin" in ''|'#'*) continue ;; esac
        if target_includes "$host_name" "$targets"; then
            printf '%s@%s\n' "$plugin" "$marketplace" >> "$tmp/$host_name-all-desired"
        fi
    done < "$catalog"
    LC_ALL=C sort -u "$tmp/$host_name-all-desired" -o "$tmp/$host_name-all-desired"
    node - "$host_name" "$tmp/$host_name-plugins.json" \
        > "$tmp/$host_name-all-actual-unsorted" <<'NODE'
const fs = require('fs');
const [host, file] = process.argv.slice(2);
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = host === 'codex' ? parsed.installed : parsed;
for (const row of rows) console.log(host === 'codex' ? row.pluginId : row.id);
NODE
    LC_ALL=C sort -u "$tmp/$host_name-all-actual-unsorted" \
        > "$tmp/$host_name-all-actual"
    comm -23 "$tmp/$host_name-all-actual" "$tmp/$host_name-all-desired" \
        > "$tmp/$host_name-all-unmanaged"
    if [ -s "$tmp/$host_name-all-unmanaged" ]; then
        echo "UNMANAGED: installed $host_name Plugin(s) are absent from catalog/plugins.tsv:" >&2
        sed 's/^/  /' "$tmp/$host_name-all-unmanaged" >&2
        exit 1
    fi
}

for host_name in codex claude; do
    has_agent "$host_name" || continue
    if host_has_desired_plugins "$host_name"; then
        command -v "$host_name" >/dev/null 2>&1 || {
            echo "$host_name is required for selected Plugin reconciliation" >&2
            exit 1
        }
        process_migrations_for_host "$host_name"
        retire_old_for_host "$host_name" true
        reconcile_current_for_host "$host_name"
        refresh_host "$host_name"
        assert_all_installed_managed "$host_name"
        continue
    fi

    host_was_owned "$host_name" || continue
    command -v "$host_name" >/dev/null 2>&1 || {
        echo "$host_name is required to retire PAC-owned Plugins" >&2
        exit 1
    }
    retire_old_for_host "$host_name" false
done

emit_state_hosts() {
    if [ -f "$owned" ]; then
        while IFS="$(printf '\t')" read -r plugin marketplace targets; do
            case "$plugin" in ''|'#'*) continue ;; esac
            for host_name in codex claude; do
                if target_includes "$host_name" "$targets" && ! has_agent "$host_name"; then
                    printf '%s\t%s\t%s\n' "$plugin" "$marketplace" "$host_name"
                fi
            done
        done < "$owned"
    fi
    while IFS="$(printf '\t')" read -r plugin marketplace _a _s _r _c _t _v targets _rest; do
        case "$plugin" in ''|'#'*) continue ;; esac
        for host_name in codex claude; do
            if target_includes "$host_name" "$targets" && has_agent "$host_name"; then
                printf '%s\t%s\t%s\n' "$plugin" "$marketplace" "$host_name"
            fi
        done
    done < "$catalog"
}

emit_state_hosts | LC_ALL=C sort -u > "$tmp/state-hosts"
{
    printf '# plugin\tmarketplace\ttargets\n'
    awk -F '\t' '
        function emit() {
            if (plugin == "") return
            targets = codex && claude ? "codex,claude" : (codex ? "codex" : "claude")
            print plugin "\t" marketplace "\t" targets
        }
        {
            key = $1 SUBSEP $2
            if (last != "" && key != last) { emit(); codex = 0; claude = 0 }
            plugin = $1; marketplace = $2; last = key
            if ($3 == "codex") codex = 1
            if ($3 == "claude") claude = 1
        }
        END { emit() }
    ' "$tmp/state-hosts"
} > "$tmp/expected-owned"

if [ "$mode" = apply ]; then
    mkdir -p "$state_dir"
    pac_assert_real_directory "$state_dir" "PAC state"
    cp "$tmp/expected-owned" "$tmp/owned-plugins.tsv"
    chmod 600 "$tmp/owned-plugins.tsv"
    mv -f -- "$tmp/owned-plugins.tsv" "$owned"
else
    if [ ! -f "$owned" ] || [ -L "$owned" ] || \
        ! cmp -s "$tmp/expected-owned" "$owned"; then
        echo "DRIFT: Plugin ownership state $owned" >&2
        exit 1
    fi
fi

if [ "$mode" = apply ] && [ -f "$owned" ]; then
    while IFS= read -r marketplace; do
        [ -n "$marketplace" ] || continue
        directory="$source_parent/$marketplace"
        [ -e "$directory" ] || [ -L "$directory" ] || continue
        if ! awk -F '\t' -v marketplace="$marketplace" \
            '$0 !~ /^#/ && $2 == marketplace { found = 1 } END { exit !found }' "$owned"; then
            grep -Fqx "$marketplace" "$tmp/protected-marketplaces" && continue
            source_referenced_by_any_host "$marketplace" && continue
            [ -d "$directory" ] && [ ! -L "$directory" ] || {
                echo "unsafe retired Plugin source: $directory" >&2
                exit 1
            }
            rm -rf -- "$directory"
        fi
    done < "$tmp/prior-owned-marketplaces"
fi

echo "Plugin $mode passed for $agents"
