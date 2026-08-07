#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function regularFiles(root, relative) {
  const files = [];
  async function collect(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const child = `${prefix}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await collect(absolute, child);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(child);
      else throw new Error(`unsupported integrity fixture entry: ${child}`);
    }
  }
  await collect(path.join(root, ...relative.split('/')), relative);
  return files;
}

export async function buildIntegrityManifest(root) {
  const paths = [
    ...await regularFiles(root, 'payload/skills'),
    'catalog/capabilities.jsonl',
    'catalog/taxonomy.json',
  ].sort();
  const lines = await Promise.all(paths.map(async (relative) => {
    const content = await fs.readFile(path.join(root, ...relative.split('/')));
    return `${sha256(content)}  ${relative}`;
  }));
  return `${lines.join('\n')}\n`;
}

export function updateIntegrityLine(manifest, relative, content) {
  const replacement = `${sha256(content)}  ${relative}`;
  let found = false;
  const lines = manifest.split(/\r?\n/u).filter(Boolean).map((line) => {
    if (!line.endsWith(`  ${relative}`)) return line;
    if (found) throw new Error(`duplicate integrity entry: ${relative}`);
    found = true;
    return replacement;
  });
  if (!found) throw new Error(`missing integrity entry: ${relative}`);
  return `${lines.join('\n')}\n`;
}

async function linkRecords(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    records.push(`${entry.name} -> ${await fs.readlink(path.join(directory, entry.name))}`);
  }
  return records.sort();
}

async function managedDigest(home) {
  const hash = crypto.createHash('sha256');
  const add = (label, content) => {
    hash.update(label); hash.update('\0'); hash.update(String(content.length)); hash.update('\0'); hash.update(content); hash.update('\0');
  };
  for (const relative of [
    '.local/share/agent-skills/apm.lock.yaml',
    '.local/state/personal-agent-control/owned-skills.txt',
    '.claude/plugins/installed_plugins.json',
  ]) {
    add(relative, await fs.readFile(path.join(home, relative)));
  }
  for (const relative of ['.agents/skills', '.claude/skills']) {
    add(relative, Buffer.from((await linkRecords(path.join(home, relative))).join('\n')));
  }
  return hash.digest('hex');
}

async function main([command, target]) {
  if (!command || !target) throw new Error('usage: portable-fs.mjs sha256|link-count|managed-digest TARGET');
  if (command === 'sha256') process.stdout.write(`${sha256(await fs.readFile(target))}\n`);
  else if (command === 'link-count') process.stdout.write(`${(await linkRecords(target)).length}\n`);
  else if (command === 'managed-digest') process.stdout.write(`${await managedDigest(target)}\n`);
  else throw new Error(`unknown portable-fs command: ${command}`);
}

const invokedPath = process.argv[1]
  ? await fs.realpath(path.resolve(process.argv[1])).catch(() => null)
  : null;
const modulePath = await fs.realpath(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
