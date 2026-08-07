import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PacError } from './errors.mjs';
import { atomicWriteFile } from './atomic-file.mjs';

const OVERLAY_RELATIVE = 'catalog/capabilities.jsonl';
const INTEGRITY_RELATIVE = 'catalog/files.sha256';

function parseOverlay(text, file) {
  const records = [];
  const ids = new Set();
  for (const [index, raw] of text.replaceAll('\r\n', '\n').split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let record;
    try { record = JSON.parse(line); }
    catch (error) { throw new PacError('CAPABILITY_OVERLAY_INVALID', `${file}:${index + 1}: ${error.message}`); }
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id)) {
      throw new PacError('CAPABILITY_OVERLAY_INVALID', `${file}:${index + 1}: invalid or duplicate capability id.`);
    }
    ids.add(record.id);
    records.push({ id: record.id, line, record });
  }
  return records;
}

function minimalSkillRecord(name) {
  return {
    id: `skill:${name}`,
    memberships: ['kind.skill'],
    targets: ['codex', 'claude'],
    delivery: 'apm',
    visibility: 'private',
  };
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function updateIntegrity(text, relative, digest) {
  const lines = text.replaceAll('\r\n', '\n').split('\n').filter((line, index, all) => line || index < all.length - 1);
  const replacement = `${digest}  ${relative}`;
  let found = false;
  const updated = lines.map((line) => {
    const match = line.match(/^[0-9a-f]{64}\s{2}(.+)$/u);
    if (match?.[1] !== relative) return line;
    if (found) throw new PacError('INTEGRITY_MANIFEST_INVALID', `Duplicate ${relative} entry in ${INTEGRITY_RELATIVE}.`);
    found = true;
    return replacement;
  });
  if (!found) updated.push(replacement);
  return `${updated.filter(Boolean).join('\n')}\n`;
}

export async function syncSkillCapabilities(context, previousNames, nextNames) {
  const overlayPath = path.join(context.root, OVERLAY_RELATIVE);
  const integrityPath = path.join(context.root, INTEGRITY_RELATIVE);
  const [overlayBefore, integrityBefore] = await Promise.all([
    fs.readFile(overlayPath, 'utf8'),
    fs.readFile(integrityPath, 'utf8'),
  ]);
  const records = parseOverlay(overlayBefore, overlayPath);
  const previous = new Set(previousNames);
  const next = new Set(nextNames);
  const added = [...next].filter((name) => !previous.has(name)).sort();
  const removed = [...previous].filter((name) => !next.has(name)).sort();
  const removedIds = new Set(removed.map((name) => `skill:${name}`));
  const retained = records.filter(({ id }) => !removedIds.has(id));
  const ids = new Set(retained.map(({ id }) => id));
  for (const name of added) {
    const record = minimalSkillRecord(name);
    if (!ids.has(record.id)) {
      retained.push({ id: record.id, line: JSON.stringify(record), record });
      ids.add(record.id);
    }
  }
  retained.sort((left, right) => left.id.localeCompare(right.id));
  const overlayAfter = `${retained.map(({ line }) => line).join('\n')}\n`;
  const integrityAfter = updateIntegrity(integrityBefore, OVERLAY_RELATIVE, sha256(overlayAfter));
  if (overlayAfter === overlayBefore && integrityAfter === integrityBefore) {
    return { added, removed, changed: false, overlayBefore, integrityBefore };
  }
  try {
    await atomicWriteFile(overlayPath, overlayAfter);
    await atomicWriteFile(integrityPath, integrityAfter);
  } catch (error) {
    await atomicWriteFile(overlayPath, overlayBefore);
    await atomicWriteFile(integrityPath, integrityBefore);
    throw error;
  }
  return { added, removed, changed: true, overlayBefore, integrityBefore };
}

export async function syncProfileSkillCapabilities(profileRoot, previousNames, nextNames) {
  const overlayPath = path.join(profileRoot, OVERLAY_RELATIVE);
  let overlayBefore = '';
  try { overlayBefore = await fs.readFile(overlayPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = parseOverlay(overlayBefore, overlayPath);
  const previous = new Set(previousNames);
  const next = new Set(nextNames);
  const added = [...next].filter((name) => !previous.has(name)).sort();
  const removed = [...previous].filter((name) => !next.has(name)).sort();
  const removedIds = new Set(removed.map((name) => `skill:${name}`));
  const retained = records.filter(({ id }) => !removedIds.has(id));
  const ids = new Set(retained.map(({ id }) => id));
  for (const name of added) {
    const record = minimalSkillRecord(name);
    if (!ids.has(record.id)) {
      retained.push({ id: record.id, line: JSON.stringify(record), record });
      ids.add(record.id);
    }
  }
  retained.sort((left, right) => left.id.localeCompare(right.id));
  const overlayAfter = retained.length ? `${retained.map(({ line }) => line).join('\n')}\n` : '';
  if (overlayAfter !== overlayBefore) await atomicWriteFile(overlayPath, overlayAfter, 0o600);
  return { added, removed, changed: overlayAfter !== overlayBefore, overlayBefore };
}

export async function restoreCapabilityMetadata(context, snapshot) {
  await atomicWriteFile(path.join(context.root, OVERLAY_RELATIVE), snapshot.overlayBefore);
  await atomicWriteFile(path.join(context.root, INTEGRITY_RELATIVE), snapshot.integrityBefore);
}

export { OVERLAY_RELATIVE, INTEGRITY_RELATIVE };
