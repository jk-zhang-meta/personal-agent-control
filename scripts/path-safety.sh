#!/bin/sh

# Validate every existing ancestor below a trusted root without following a
# symlink. The final path component is deliberately excluded so callers may
# inspect, replace, or preserve a managed symlink themselves.
pac_assert_safe_ancestors() (
    _pac_root=$1
    _pac_rel=$2
    _pac_label=${3:-managed path}

    case "$_pac_root" in
        /*) ;;
        *) echo "unsafe $_pac_label root: $_pac_root" >&2; return 1 ;;
    esac
    case "$_pac_rel" in
        ''|/*|*/|*//*|.|..|./*|../*|*/./*|*/../*|*/.|*/..)
            echo "unsafe $_pac_label: $_pac_rel" >&2
            return 1
            ;;
    esac

    _pac_current=${_pac_root%/}
    _pac_remaining=$_pac_rel
    while [ "${_pac_remaining#*/}" != "$_pac_remaining" ]; do
        _pac_component=${_pac_remaining%%/*}
        _pac_remaining=${_pac_remaining#*/}
        case "$_pac_component" in
            ''|.|..) echo "unsafe $_pac_label: $_pac_rel" >&2; return 1 ;;
        esac
        _pac_current="$_pac_current/$_pac_component"
        if [ -L "$_pac_current" ]; then
            echo "unsafe symlink ancestor for $_pac_label: $_pac_current" >&2
            return 1
        fi
        if [ -e "$_pac_current" ] && [ ! -d "$_pac_current" ]; then
            echo "unsafe non-directory ancestor for $_pac_label: $_pac_current" >&2
            return 1
        fi
    done
)

pac_assert_real_directory() {
    _pac_directory=$1
    _pac_label=${2:-managed directory}
    if [ ! -d "$_pac_directory" ] || [ -L "$_pac_directory" ]; then
        echo "unsafe $_pac_label: $_pac_directory" >&2
        return 1
    fi
}
