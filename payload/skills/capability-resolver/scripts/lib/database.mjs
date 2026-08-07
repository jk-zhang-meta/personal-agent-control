import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadSourceModel } from './catalog.mjs';

export const SCHEMA_VERSION = 1;
const SCHEMA_SIGNATURE = 'capability-resolver-v1-metadata-digest-taxonomy';
const SECURE_MODE_PLATFORMS = new Set(['darwin', 'linux']);

export function defaultDatabasePath(home = homedir()) {
  return join(resolve(home), '.cache', 'personal-agent-control', 'capabilities-v1.sqlite');
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function uniqueStrings(value) {
  return [...new Set(asArray(value).map((item) => String(item).trim()).filter(Boolean))];
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function pathIsWithin(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
}

// The explicitly supplied home is the trust boundary. Ancestors above it may be
// platform aliases (for example macOS /var -> /private/var); controlled suffixes
// below it may not be symlinks for write/check operations.
function assertControlledDatabasePath(dbPath, home, { mustExist = false } = {}) {
  if (!dbPath || typeof dbPath !== 'string') throw new Error('Database path must be a non-empty string.');
  const trustedHome = resolve(home);
  const absolute = resolve(dbPath);
  if (!pathIsWithin(trustedHome, absolute)) {
    throw new Error(`Capability index must stay under the configured home: ${absolute}`);
  }
  const suffix = relative(trustedHome, absolute);
  let cursor = trustedHome;
  for (const segment of suffix.split(/[\\/]+/u).filter(Boolean)) {
    cursor = join(cursor, segment);
    const entry = lstatSync(cursor, { throwIfNoEntry: false });
    if (!entry) break;
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symlink in controlled database path: ${cursor}`);
    }
  }
  if (mustExist) assertFinalDatabaseFile(absolute);
  return absolute;
}

// Query callers are read-only. They validate the final file itself without
// rejecting legitimate system or administrator-managed ancestor aliases.
function assertFinalDatabaseFile(dbPath) {
  const absolute = resolve(dbPath);
  if (!existsSync(absolute)) throw new Error(`Capability index is missing: ${absolute}`);
  const entry = lstatSync(absolute);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Capability index is not a regular file: ${absolute}`);
  }
  return absolute;
}

function expectedMode(path, expected, label) {
  if (!SECURE_MODE_PLATFORMS.has(process.platform)) return;
  const actual = statSync(path).mode & 0o777;
  if (actual !== expected) {
    throw new Error(`${label} permissions must be ${expected.toString(8)}, found ${actual.toString(8)}: ${path}`);
  }
}

function assertSecureModes(dbPath) {
  if (!SECURE_MODE_PLATFORMS.has(process.platform)) return;
  expectedMode(dirname(dbPath), 0o700, 'Capability index directory');
  expectedMode(dbPath, 0o600, 'Capability index');
}

function repairSecureModes(dbPath, { file = existsSync(dbPath) } = {}) {
  if (!SECURE_MODE_PLATFORMS.has(process.platform)) return false;
  let changed = false;
  const directory = dirname(dbPath);
  if ((statSync(directory).mode & 0o777) !== 0o700) {
    chmodSync(directory, 0o700);
    changed = true;
  }
  if (file && (statSync(dbPath).mode & 0o777) !== 0o600) {
    chmodSync(dbPath, 0o600);
    changed = true;
  }
  return changed;
}

function categoriesFromTaxonomy(taxonomy) {
  const raw = Array.isArray(taxonomy)
    ? taxonomy
    : Array.isArray(taxonomy?.categories)
      ? taxonomy.categories
      : [];
  return raw.map((category) => ({
    id: String(category.id),
    parentId: category.parentId ?? category.parent ?? null,
    name: String(category.name ?? category.label ?? category.id),
    description: String(category.description ?? ''),
    aliases: uniqueStrings(category.aliases),
  }));
}

function categoryPaths(categories) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const paths = new Map();
  const visiting = new Set();
  function visit(id) {
    if (paths.has(id)) return paths.get(id);
    if (visiting.has(id)) throw new Error(`Taxonomy cycle at category: ${id}`);
    const category = byId.get(id);
    if (!category) throw new Error(`Unknown taxonomy category: ${id}`);
    visiting.add(id);
    let path = id;
    if (category.parentId) {
      if (!byId.has(String(category.parentId))) {
        throw new Error(`Unknown parent ${category.parentId} for category ${id}`);
      }
      path = `${visit(String(category.parentId))}/${id}`;
    }
    visiting.delete(id);
    paths.set(id, path);
    return path;
  }
  for (const category of categories) visit(category.id);
  return paths;
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = ${SCHEMA_VERSION};

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

    CREATE TABLE capability (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      summary TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      triggers_json TEXT NOT NULL,
      anti_triggers_json TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      provider_id TEXT,
      delivery TEXT,
      requires_json TEXT NOT NULL,
      visibility TEXT NOT NULL,
      activation_json TEXT NOT NULL,
      resource TEXT,
      search_text TEXT NOT NULL
    ) STRICT;

    CREATE TABLE capability_alias (
      capability_id TEXT NOT NULL REFERENCES capability(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      PRIMARY KEY (capability_id, normalized_alias)
    ) STRICT;
    CREATE INDEX capability_alias_normalized_idx ON capability_alias(normalized_alias);

    CREATE TABLE capability_target (
      capability_id TEXT NOT NULL REFERENCES capability(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      PRIMARY KEY (capability_id, target)
    ) STRICT;
    CREATE INDEX capability_target_target_idx ON capability_target(target, capability_id);

    CREATE TABLE category (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES category(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      path TEXT NOT NULL
    ) STRICT;
    CREATE INDEX category_parent_idx ON category(parent_id);

    CREATE TABLE capability_category (
      capability_id TEXT NOT NULL REFERENCES capability(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      PRIMARY KEY (capability_id, category_id)
    ) STRICT;
    CREATE INDEX capability_category_category_idx ON capability_category(category_id, capability_id);

    CREATE TABLE relation (
      from_id TEXT NOT NULL REFERENCES capability(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      to_id TEXT NOT NULL,
      PRIMARY KEY (from_id, type, to_id)
    ) STRICT;

    CREATE VIRTUAL TABLE capability_fts_word USING fts5(
      capability_id UNINDEXED,
      name,
      aliases,
      summary,
      triggers,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE capability_fts_trigram USING fts5(
      capability_id UNINDEXED,
      text,
      tokenize = 'trigram'
    );
  `);
}

const DIGEST_QUERIES = [
  ['capability', `SELECT id, role, kind, name, normalized_name, summary, aliases_json,
    triggers_json, anti_triggers_json, targets_json, provider_id, delivery,
    requires_json, visibility, activation_json, resource, search_text
    FROM capability ORDER BY id`],
  ['capability_alias', `SELECT capability_id, alias, normalized_alias
    FROM capability_alias ORDER BY capability_id, normalized_alias`],
  ['capability_target', `SELECT capability_id, target
    FROM capability_target ORDER BY capability_id, target`],
  ['category', `SELECT id, parent_id, name, description, aliases_json, path FROM category ORDER BY id`],
  ['capability_category', `SELECT capability_id, category_id
    FROM capability_category ORDER BY capability_id, category_id`],
  ['relation', `SELECT from_id, type, to_id FROM relation ORDER BY from_id, type, to_id`],
  ['capability_fts_word', `SELECT rowid, capability_id, name, aliases, summary, triggers
    FROM capability_fts_word ORDER BY capability_id, rowid`],
  ['capability_fts_trigram', `SELECT rowid, capability_id, text
    FROM capability_fts_trigram ORDER BY capability_id, rowid`],
];

function computeLogicalDigest(db) {
  const hash = createHash('sha256');
  for (const [table, query] of DIGEST_QUERIES) {
    hash.update(`${table}\n`);
    for (const row of db.prepare(query).iterate()) hash.update(`${JSON.stringify(Object.values(row))}\n`);
  }
  return hash.digest('hex');
}

function populateDatabase(db, model) {
  const categories = categoriesFromTaxonomy(model.taxonomy);
  const paths = categoryPaths(categories);
  const insertMeta = db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
  const insertCategory = db.prepare(`
    INSERT INTO category(id, parent_id, name, description, aliases_json, path) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertCapability = db.prepare(`
    INSERT INTO capability(
      id, role, kind, name, normalized_name, summary, aliases_json, triggers_json,
      anti_triggers_json, targets_json, provider_id, delivery, requires_json,
      visibility, activation_json, resource, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlias = db.prepare(`
    INSERT OR IGNORE INTO capability_alias(capability_id, alias, normalized_alias) VALUES (?, ?, ?)
  `);
  const insertTarget = db.prepare('INSERT INTO capability_target(capability_id, target) VALUES (?, ?)');
  const insertMembership = db.prepare('INSERT INTO capability_category(capability_id, category_id) VALUES (?, ?)');
  const insertRelation = db.prepare('INSERT INTO relation(from_id, type, to_id) VALUES (?, ?, ?)');
  const insertWordFts = db.prepare(`
    INSERT INTO capability_fts_word(capability_id, name, aliases, summary, triggers) VALUES (?, ?, ?, ?, ?)
  `);
  const insertTrigramFts = db.prepare('INSERT INTO capability_fts_trigram(capability_id, text) VALUES (?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    insertMeta.run('schema_version', String(SCHEMA_VERSION));
    insertMeta.run('schema_signature', SCHEMA_SIGNATURE);
    insertMeta.run('revision', String(model.revision));
    insertMeta.run('built_at', new Date().toISOString());

    const remaining = new Map(categories.map((category) => [category.id, category]));
    while (remaining.size > 0) {
      let progressed = false;
      for (const [id, category] of remaining) {
        const parentId = category.parentId ? String(category.parentId) : null;
        if (parentId && remaining.has(parentId)) continue;
        insertCategory.run(id, parentId, category.name, category.description, json(category.aliases), paths.get(id));
        remaining.delete(id);
        progressed = true;
      }
      if (!progressed) throw new Error('Taxonomy contains an unresolved parent cycle.');
    }

    for (const capability of [...model.capabilities].sort((a, b) => a.id.localeCompare(b.id))) {
      const aliases = uniqueStrings(capability.aliases);
      const triggers = uniqueStrings(capability.triggers);
      const antiTriggers = uniqueStrings(capability.antiTriggers);
      const targets = uniqueStrings(capability.targets);
      const requires = uniqueStrings(capability.requires);
      // Context bodies stay outside SQLite: persist the load path in resource,
      // and index only the same routing metadata used by every capability.
      const searchableMetadata = [capability.name, ...aliases, capability.summary, ...triggers]
        .filter(Boolean).join('\n');
      insertCapability.run(
        capability.id, String(capability.role ?? 'capability'), String(capability.kind), String(capability.name),
        String(capability.name).normalize('NFKC').toLocaleLowerCase('und').trim(),
        String(capability.summary ?? ''), json(aliases), json(triggers), json(antiTriggers), json(targets),
        capability.providerId ? String(capability.providerId) : null,
        capability.delivery ? String(capability.delivery) : null, json(requires),
        String(capability.visibility ?? 'auto'), json(capability.activation ?? {}),
        capability.resource ? String(capability.resource) : null,
        searchableMetadata.normalize('NFKC').toLocaleLowerCase('und').trim(),
      );
      insertAlias.run(capability.id, String(capability.name),
        String(capability.name).normalize('NFKC').toLocaleLowerCase('und').trim());
      for (const alias of aliases) {
        insertAlias.run(capability.id, alias, alias.normalize('NFKC').toLocaleLowerCase('und').trim());
      }
      for (const target of targets) insertTarget.run(capability.id, target.toLocaleLowerCase('und'));
      for (const membership of uniqueStrings(capability.memberships)) insertMembership.run(capability.id, membership);
      insertWordFts.run(capability.id, capability.name, aliases.join(' '), capability.summary ?? '', triggers.join(' '));
      insertTrigramFts.run(capability.id, searchableMetadata);
    }

    const capabilityIds = new Set(model.capabilities.map(({ id }) => id));
    for (const relation of [...(model.relations ?? [])].sort((a, b) =>
      `${a.from}\0${a.type}\0${a.to}`.localeCompare(`${b.from}\0${b.type}\0${b.to}`))) {
      if (relation.type === 'provides' && !capabilityIds.has(String(relation.to))) {
        throw new Error(`Provider relation targets unknown capability: ${relation.to}`);
      }
      insertRelation.run(String(relation.from), String(relation.type), String(relation.to));
    }
    insertMeta.run('logical_digest', computeLogicalDigest(db));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA optimize');
}

function pragmaValue(row) {
  return row ? Object.values(row)[0] : undefined;
}

function validateOpenDatabase(db, expectedRevision = null, { integrity = true, digest = true } = {}) {
  const version = Number(pragmaValue(db.prepare('PRAGMA user_version').get()));
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Capability index schema ${version} does not match ${SCHEMA_VERSION}.`);
  }
  const signature = db.prepare("SELECT value FROM metadata WHERE key = 'schema_signature'").get()?.value;
  if (signature !== SCHEMA_SIGNATURE) throw new Error('Capability index schema signature is stale.');
  if (integrity) {
    const check = pragmaValue(db.prepare('PRAGMA quick_check').get());
    if (check !== 'ok') throw new Error(`Capability index integrity check failed: ${check}`);
    const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyFailures.length > 0) {
      throw new Error(`Capability index has ${foreignKeyFailures.length} foreign-key violation(s).`);
    }
  }
  const revision = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get()?.value;
  if (!revision) throw new Error('Capability index has no source revision.');
  if (expectedRevision && revision !== expectedRevision) {
    throw new Error(`Capability index is stale: expected ${expectedRevision}, found ${revision}.`);
  }
  const storedDigest = db.prepare("SELECT value FROM metadata WHERE key = 'logical_digest'").get()?.value;
  if (!storedDigest) throw new Error('Capability index has no logical digest.');
  if (digest && computeLogicalDigest(db) !== storedDigest) {
    throw new Error('Capability index logical digest mismatch.');
  }
  return revision;
}

function openReadOnly(dbPath) {
  const absolute = assertFinalDatabaseFile(dbPath);
  assertSecureModes(absolute);
  const db = new DatabaseSync(absolute, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
  return db;
}

export function withReadOnlyCapabilityIndex(dbPath, callback) {
  const db = openReadOnly(dbPath);
  try {
    const revision = validateOpenDatabase(db, null, { integrity: false, digest: false });
    return callback(db, revision);
  } finally {
    db.close();
  }
}

function cleanupTemporary(path) {
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      rmSync(candidate, { force: true });
    } catch {
      // Best-effort cleanup must not mask the original build error.
    }
  }
}

export async function rebuildIndex({ repo, home = homedir(), dbPath = defaultDatabasePath(home), profile = null }) {
  const resolvedRepo = resolve(repo);
  const resolvedHome = resolve(home);
  const destination = assertControlledDatabasePath(dbPath, resolvedHome);
  const model = await loadSourceModel({
    repo: resolvedRepo,
    home: resolvedHome,
    strictRouting: true,
    profile: profile === null ? null : resolve(profile),
  });
  const directory = dirname(destination);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertControlledDatabasePath(destination, resolvedHome);
  let modeChanged = repairSecureModes(destination, { file: false });
  if (existsSync(destination)) {
    const entry = lstatSync(destination);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Capability index is not a regular file: ${destination}`);
    }
    modeChanged = repairSecureModes(destination) || modeChanged;
    let current = null;
    try {
      const db = openReadOnly(destination);
      try {
        current = validateOpenDatabase(db);
      } finally {
        db.close();
      }
    } catch {
      current = null;
    }
    if (current === model.revision) {
      return { ok: true, changed: modeChanged, revision: model.revision, dbPath: destination };
    }
  }

  const temporary = join(directory,
    `.${parse(destination).base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanupTemporary(temporary);
  let db;
  try {
    db = new DatabaseSync(temporary);
    createSchema(db);
    populateDatabase(db, model);
    chmodSync(temporary, 0o600);
    assertSecureModes(temporary);
    validateOpenDatabase(db, model.revision);
    db.close();
    db = undefined;
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    modeChanged = repairSecureModes(destination) || modeChanged;
    assertSecureModes(destination);
    return {
      ok: true,
      changed: true,
      revision: model.revision,
      dbPath: destination,
      capabilities: model.capabilities.length,
      categories: categoriesFromTaxonomy(model.taxonomy).length,
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the build error.
    }
    cleanupTemporary(temporary);
    throw error;
  } finally {
    cleanupTemporary(temporary);
  }
}

export async function checkIndex({ repo, home = homedir(), dbPath = defaultDatabasePath(home), profile = null }) {
  const resolvedHome = resolve(home);
  const destination = assertControlledDatabasePath(dbPath, resolvedHome, { mustExist: true });
  assertSecureModes(destination);
  const model = await loadSourceModel({
    repo: resolve(repo),
    home: resolvedHome,
    strictRouting: true,
    profile: profile === null ? null : resolve(profile),
  });
  const db = openReadOnly(destination);
  try {
    const revision = validateOpenDatabase(db, model.revision);
    const capabilities = Number(db.prepare('SELECT count(*) AS count FROM capability').get().count);
    const categories = Number(db.prepare('SELECT count(*) AS count FROM category').get().count);
    return { ok: true, revision, dbPath: destination, capabilities, categories };
  } finally {
    db.close();
  }
}
