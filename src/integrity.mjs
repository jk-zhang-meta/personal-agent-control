import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { PacError } from './errors.mjs';
import { assertRealDirectory } from './path-safety.mjs';

const REQUIRED_CATALOG_FILES = ['catalog/capabilities.jsonl', 'catalog/taxonomy.json'];
const OPTIONAL_CATALOG_FILES = ['catalog/providers.json'];

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function assertCanonicalDirectory(directory, label) {
  try { await assertRealDirectory(directory, label); }
  catch (error) {
    throw new PacError('SOURCE_INTEGRITY_INVALID', error.message, {
      directory,
      cause: error.code || error.message,
    });
  }
}

function safeRelative(relative) {
  return relative && !path.isAbsolute(relative)
    && !relative.split('/').some((part) => part === '' || part === '.' || part === '..');
}

async function payloadInventory(root) {
  const base = path.join(root, 'payload/skills');
  const files = [];
  async function collect(directory, relative) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await collect(absolute, child);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(child);
      else throw new PacError('SOURCE_INTEGRITY_INVALID', `Canonical payload contains an unsupported or symlinked entry: ${child}`);
    }
  }
  await collect(base, 'payload/skills');
  return files;
}

export async function verifyCanonicalPayload(context) {
  await assertCanonicalDirectory(path.join(context.root, 'payload'), 'canonical payload directory');
  await assertCanonicalDirectory(path.join(context.root, 'payload/skills'), 'canonical Skill payload directory');
  await assertCanonicalDirectory(path.join(context.root, 'catalog'), 'canonical catalog directory');
  const catalogFiles = [
    ...REQUIRED_CATALOG_FILES,
    ...OPTIONAL_CATALOG_FILES.filter((relative) => {
      try { return fsSync.existsSync(path.join(context.root, relative)); }
      catch { return false; }
    }),
  ];
  const manifestPath = path.join(context.root, 'catalog/files.sha256');
  let text;
  try { text = await fs.readFile(manifestPath, 'utf8'); }
  catch (error) { throw new PacError('SOURCE_INTEGRITY_INVALID', `Cannot read ${manifestPath}: ${error.message}`); }
  const expected = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  ([^\r\n]+)$/u);
    if (!match || !safeRelative(match[2]) || expected.has(match[2])) {
      throw new PacError('SOURCE_INTEGRITY_INVALID', `Invalid integrity manifest entry at line ${index + 1}.`);
    }
    if (!match[2].startsWith('payload/skills/') && !catalogFiles.includes(match[2])) {
      throw new PacError('SOURCE_INTEGRITY_INVALID', `Integrity manifest contains an unmanaged path: ${match[2]}`);
    }
    expected.set(match[2], match[1]);
  }
  const actualPaths = [...await payloadInventory(context.root), ...catalogFiles].sort();
  const missing = [...expected.keys()].filter((relative) => !actualPaths.includes(relative)).sort();
  const added = actualPaths.filter((relative) => !expected.has(relative)).sort();
  if (missing.length || added.length) {
    throw new PacError('SOURCE_INTEGRITY_INVALID', 'Canonical payload inventory differs from catalog/files.sha256.', { missing, added });
  }
  for (const [relative, expectedDigest] of expected) {
    const absolute = path.join(context.root, ...relative.split('/'));
    const stat = await fs.lstat(absolute).catch((error) => {
      throw new PacError('SOURCE_INTEGRITY_INVALID', `Cannot inspect canonical payload file ${relative}: ${error.message}`);
    });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PacError('SOURCE_INTEGRITY_INVALID', `Canonical payload path must be a regular file: ${relative}`);
    }
    const actualDigest = digest(await fs.readFile(absolute));
    if (actualDigest !== expectedDigest) {
      throw new PacError('SOURCE_INTEGRITY_INVALID', `Canonical payload file differs from its reviewed digest: ${relative}`, {
        relative,
        expected: expectedDigest,
        actual: actualDigest,
      });
    }
  }
  return { valid: true, files: expected.size, manifest: manifestPath };
}
