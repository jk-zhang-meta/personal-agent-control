import { readFileSync } from 'node:fs';

const LIST_FIELDS = new Set([
  'memberships',
  'aliases',
  'triggers',
  'antiTriggers',
  'anti_triggers',
  'targets',
  'requires',
]);

const STRING_FIELDS = new Set([
  'name',
  'kind',
  'role',
  'summary',
  'delivery',
  'visibility',
  'activationPolicy',
  'path',
]);

export function readCapabilityOverlay(file, categoryIds) {
  const records = new Map();
  const lines = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const record = parseRecord(file, index + 1, line);
    if (records.has(record.id)) throw new Error(`duplicate capability overlay id ${record.id}`);
    validateRecord(record, file, index + 1, categoryIds);
    records.set(record.id, record);
  }
  return records;
}

export function readCapabilityOverlays(files, categoryIds) {
  const records = new Map();
  for (const file of files.filter(Boolean)) {
    for (const [id, record] of readCapabilityOverlay(file, categoryIds)) {
      if (records.has(id)) throw new Error(`duplicate capability overlay id ${id}`);
      records.set(id, record);
    }
  }
  return records;
}

function parseRecord(file, lineNumber, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    throw new Error(`${file}:${lineNumber}: invalid JSON: ${error.message}`);
  }
  if (!isPlainObject(record)) {
    throw new Error(`${file}:${lineNumber}: capability overlay row must be an object`);
  }
  requireString(record.id, `${file}:${lineNumber} capability id`);
  return record;
}

function validateRecord(record, file, lineNumber, categoryIds) {
  for (const field of LIST_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) && typeof value !== 'string') {
      throw new Error(`${record.id} overlay field ${field} must be a string or array`);
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new Error(`${record.id} overlay field ${field} must contain non-empty strings`);
    }
  }
  for (const field of STRING_FIELDS) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      throw new Error(`${record.id} overlay field ${field} must be a string`);
    }
  }
  if (record.activation !== undefined || record.resource !== undefined) {
    throw new Error(`${file}:${lineNumber}: ${record.id} cannot override runtime activation or resource`);
  }
  for (const membership of arrayField(record.memberships)) {
    if (!categoryIds.has(membership)) throw new Error(`${record.id} uses unknown category ${membership}`);
  }
}

function arrayField(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
