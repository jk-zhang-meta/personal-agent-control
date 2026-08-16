import { HOSTS, resolveContext } from './config.mjs';
import { executeCommand } from './commands.mjs';
import { asPacError, usage } from './errors.mjs';

const HELP = `Usage: pac [--json] [--home PATH] [--hosts ${HOSTS.join('|')}|all] COMMAND

--hosts limits this operation to a host; it never enables a disabled host.

Core:
  install [${HOSTS.join('|')}|all]   Enable and apply PAC for an Agent
  plan                         Show the next reconciliation without mutation
  apply                        Reconcile Skills, Plugins, projections and index
  status                       Report drift and pinned-engine state
  doctor                       Run authoritative checks
  rollback [BACKUP]            Restore the latest or named PAC snapshot
  update                       Update PAC and pinned engines, then reconcile
  self-update                  Alias for the Core update path

Capabilities:
  skill add|remove|update|list|search ...
  plugin add|remove|update|list ...
  host enable|disable|list ...
  profile init|set|update|publish|sync|remove|status ...
`;

function parse(argv) {
  const args = [...argv];
  const options = { json: false, home: undefined, hosts: undefined };
  const positional = [];
  while (args.length) {
    const token = args.shift();
    if (token === '--json') options.json = true;
    else if (token === '--home') {
      if (!args.length) throw usage('--home requires a path.');
      options.home = args.shift();
    } else if (token === '--hosts') {
      if (!args.length) throw usage(`--hosts requires ${HOSTS.join(', ')}, or all.`);
      const value = args.shift();
      const requested = value === 'all' ? [] : value.split(',');
      if (value !== 'all' && (requested.length === 0 || new Set(requested).size !== requested.length
          || requested.some((host) => !HOSTS.includes(host)))) {
        throw usage(`--hosts requires unique values from ${HOSTS.join(', ')}, or all.`);
      }
      options.hosts = value === 'all' ? 'all' : HOSTS.filter((host) => requested.includes(host)).join(',');
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else if (token.startsWith('--')) throw usage(`Unknown option: ${token}`);
    else positional.push(token);
  }
  return { options, command: positional.shift(), args: positional };
}

function human(command, data) {
  if (command === 'status') {
    const drift = data.projections.filter((entry) => !entry.valid).length;
    return [
      `PAC status: ${data.ok ? 'healthy' : 'needs attention'}`,
      `Source payload: ${data.sourceIntegrity?.valid ? 'reviewed and current' : 'drifted'}`,
      `Profile: ${data.profile?.configured ? data.profile.state : 'not configured'}`,
      `APM: ${data.apm.actual || 'unavailable'} (required ${data.apm.expected})`,
      `Skills: ${data.skills.length} (${data.materializerExceptions.length} declared materializer exception)`,
      `Lock: ${data.runtimeLock.matchesCanonical ? 'current' : 'drifted'}`,
      `Projection drift: ${drift}`,
      `Providers: ${data.providers?.filter((entry) => !entry.valid).length || 0} drifted`,
      `Plugins: ${data.plugins.valid ? 'current' : 'drifted'}`,
    ].join('\n');
  }
  if (command === 'plan') {
    return `PAC plan: lock=${data.changes.runtimeLock}, providers=${data.changes.providers?.length || 0}, projections=${data.changes.projections.length}, materializers=${data.changes.materializers.length}, plugins=${data.changes.plugins}`;
  }
  if (command === 'skill' && Array.isArray(data.skills)) {
    return data.skills.map((entry) => `${entry.name || entry.id}\t${entry.engine}`).join('\n');
  }
  if (command === 'plugin' && Array.isArray(data.plugins)) {
    return data.plugins.map((entry) => `${entry.name}\t${entry.enabled ? 'enabled' : 'disabled'}\t${entry.version}`).join('\n');
  }
  if (command === 'host' && Array.isArray(data.hosts)) {
    return data.hosts.map((entry) => `${entry.name}\t${entry.enabled ? 'enabled' : 'disabled'}`).join('\n');
  }
  if (command === 'profile' && data.profile?.state) {
    return data.profile.configured
      ? `PAC Profile: ${data.profile.state} (${data.profile.lockedCommit || 'unknown revision'})`
      : 'PAC Profile: not configured';
  }
  if (data?.receipt) return `PAC ${command} complete.\nReceipt: ${data.receipt}\nBackup: ${data.backup}`;
  if (data?.output) return data.output;
  return `PAC ${command} complete.`;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parse(argv); }
  catch (error) {
    const failure = asPacError(error);
    process.stderr.write(`${failure.message}\n${HELP}`);
    return failure.exitCode;
  }
  if (parsed.options.help || !parsed.command) {
    process.stdout.write(HELP);
    return parsed.options.help ? 0 : 2;
  }
  try {
    const context = resolveContext(parsed.options);
    const data = await executeCommand(context, parsed.command, parsed.args, parsed.options);
    if (parsed.options.json) process.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, data }, null, 2)}\n`);
    else process.stdout.write(`${human(parsed.command, data)}\n`);
    return data?.ok === false && parsed.command === 'status' ? 1 : 0;
  } catch (error) {
    const failure = asPacError(error);
    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        command: parsed.command,
        error: { code: failure.code, message: failure.message, details: failure.details },
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`PAC ${failure.code}: ${failure.message}\n`);
    }
    return failure.exitCode;
  }
}
