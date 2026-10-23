// Compatibility only: PAC no longer inspects, approves, or blocks agent tools.
// Keep old imports and --hook invocations harmless during upgrades.
export const SCAN_GUARD_POLICY_VERSION = 2;
export const SCAN_GUARD_MARKER = '--pac-scan-guard-v2';

export function inspectCommand() { return []; }
export function hookDecision() { return null; }
export function hookFailure() { return {}; }

if (process.argv.includes('--hook')) process.stdin.resume();
