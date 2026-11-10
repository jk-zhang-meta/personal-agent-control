import fs from 'node:fs/promises';
import path from 'node:path';

// A host's global instruction file is the shared kernel followed, when a
// Profile declares one, by the private bootstrap. Delivering both in the one
// file every host already loads makes the bootstrap independent of a
// model-initiated read and of any host-specific include syntax.
//
// The Chezmoi partial `pac-profile-bootstrap.tmpl` and `scripts/doctor.sh`
// produce the same bytes; change all three together.
export function composeInstructions(kernel, bootstrap) {
  if (bootstrap === null || bootstrap === undefined) return Buffer.from(kernel);
  return Buffer.concat([Buffer.from(kernel), Buffer.from('\n'), Buffer.from(bootstrap)]);
}

export function installedBootstrapPath(context) {
  return context.profileBootstrapPath
    || path.join(context.home, '.config/personal-agent-control/profile-bootstrap.md');
}

export async function readInstalledBootstrap(context) {
  try { return await fs.readFile(installedBootstrapPath(context)); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
