#!/bin/sh
set -eu
PAC_TEST_PLUGIN_HOST=codex exec node "$(dirname -- "$0")/plugin-host.mjs" "$@"
