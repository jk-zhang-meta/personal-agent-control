#!/usr/bin/env node

import { readSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultSkillRoot, validateRepositoryMetadata } from './lib/catalog.mjs';
import {
  browseCategory,
  checkIndex,
  defaultDatabasePath,
  rebuildIndex,
  resolveCapabilities,
} from './lib/index.mjs';

const USAGE = `Usage:
  capability-resolver validate-metadata [--repo PATH] [--skill-root PATH] [--profile PATH]
  capability-resolver rebuild [--repo PATH] [--home PATH] [--db PATH] [--profile PATH]
  capability-resolver check [--repo PATH] [--home PATH] [--db PATH] [--profile PATH]
  capability-resolver resolve --host HOST [--db PATH] [--stdin | TASK...] [--kind KIND]... [--category ID]... [--limit N]
  capability-resolver browse --host HOST --category ID [--db PATH] [--kind KIND]... [--limit N]`;

const MAX_STDIN_BYTES = 64 * 1024;

class UsageError extends Error {}

function parseArguments(argv) {
  const command = argv.shift();
  if (!command || command === '--help' || command === '-h') return { command: 'help', options: {}, positional: [] };
  const options = {};
  const positional = [];
  const repeatable = new Set(['kind', 'category']);
  const booleans = new Set(['stdin']);

  while (argv.length > 0) {
    const token = argv.shift();
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!name) throw new UsageError('Empty option name.');
    if (booleans.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv.shift();
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`Option --${name} requires a value.`);
    }
    if (repeatable.has(name)) {
      options[name] ??= [];
      options[name].push(value);
    } else if (options[name] !== undefined) {
      throw new UsageError(`Option --${name} may be specified only once.`);
    } else {
      options[name] = value;
    }
  }
  return { command, options, positional };
}

function rejectUnknown(options, allowed) {
  for (const option of Object.keys(options)) {
    if (!allowed.has(option)) throw new UsageError(`Unknown option --${option}.`);
  }
}

function requireOption(options, name) {
  const value = options[name];
  if (value === undefined || value === '') throw new UsageError(`Missing required option --${name}.`);
  return value;
}

function parseLimit(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value) || Number(value) < 1) throw new UsageError('--limit must be a positive integer.');
  return Number(value);
}

function parseStdinIntent() {
  const chunks = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(8192, MAX_STDIN_BYTES + 1 - total));
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_STDIN_BYTES) {
      throw new UsageError(`Standard input may contain at most ${MAX_STDIN_BYTES} bytes.`);
    }
    chunks.push(buffer.subarray(0, count));
  }
  const input = Buffer.concat(chunks, total).toString('utf8').trim();
  if (!input) throw new UsageError('--stdin requires a JSON object on standard input.');
  let value;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new UsageError(`Invalid JSON on standard input: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError('Standard input must be a JSON object.');
  }
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const { command, options, positional } = parseArguments([...argv]);
  const home = resolve(options.home ?? homedir());
  const repo = resolve(options.repo ?? process.cwd());
  const dbPath = resolve(options.db ?? defaultDatabasePath(home));
  const profile = options.profile === undefined ? null : resolve(options.profile);

  switch (command) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return;

    case 'validate-metadata': {
      rejectUnknown(options, new Set(['repo', 'skill-root', 'profile']));
      if (positional.length > 0) throw new UsageError('validate-metadata does not accept positional arguments.');
      const skillRoot = resolve(options['skill-root'] ?? defaultSkillRoot(home));
      const result = await validateRepositoryMetadata({ repo, skillRoot, profile });
      print(result ?? { ok: true, repo });
      return;
    }

    case 'rebuild': {
      rejectUnknown(options, new Set(['repo', 'home', 'db', 'profile']));
      if (positional.length > 0) throw new UsageError('rebuild does not accept positional arguments.');
      print(await rebuildIndex({ repo, home, dbPath, profile }));
      return;
    }

    case 'check': {
      rejectUnknown(options, new Set(['repo', 'home', 'db', 'profile']));
      if (positional.length > 0) throw new UsageError('check does not accept positional arguments.');
      print(await checkIndex({ repo, home, dbPath, profile }));
      return;
    }

    case 'resolve': {
      rejectUnknown(options, new Set(['host', 'db', 'stdin', 'kind', 'category', 'limit']));
      const host = requireOption(options, 'host');
      if (options.stdin && positional.length > 0) {
        throw new UsageError('Use either --stdin or a positional task, not both.');
      }
      let intent;
      if (options.stdin) {
        intent = parseStdinIntent();
      } else {
        const task = positional.join(' ').trim();
        if (!task) throw new UsageError('resolve requires TASK text or --stdin.');
        intent = { task };
      }
      if (options.kind?.length) intent.kinds = options.kind;
      if (options.category?.length) intent.categories = options.category;
      print(await resolveCapabilities({
        dbPath,
        host,
        intent,
        limit: parseLimit(options.limit),
      }));
      return;
    }

    case 'browse': {
      rejectUnknown(options, new Set(['host', 'db', 'category', 'kind', 'limit']));
      if (positional.length > 0) throw new UsageError('browse does not accept positional arguments.');
      const host = requireOption(options, 'host');
      const categories = options.category ?? [];
      if (categories.length !== 1) throw new UsageError('browse requires exactly one --category.');
      print(await browseCategory({
        dbPath,
        host,
        category: categories[0],
        kind: options.kind,
        limit: parseLimit(options.limit),
      }));
      return;
    }

    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    if (error instanceof UsageError) {
      process.stderr.write('Run with --help for usage.\n');
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  }
}

export { main };
