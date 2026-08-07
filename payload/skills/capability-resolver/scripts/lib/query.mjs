import { withReadOnlyCapabilityIndex } from './database.mjs';

const MAX_RESULTS = 20;
const DEFAULT_LIMIT = 8;
const RRF_K = 60;
const RETRIEVAL_LIMIT = 256;
const SUPPORTED_HOSTS = new Set(['codex', 'claude']);
const MAX_TASK_CHARS = 16_000;
const MAX_NEEDS_HINTS = 32;
const MAX_KINDS_CATEGORIES = 16;
const MAX_NEED_HINT_CHARS = 1_000;
const MAX_KIND_CATEGORY_CHARS = 256;
const EVIDENCE_CHARS = 200;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function uniqueStrings(value) {
  return [...new Set(asArray(value).map((item) => String(item).trim()).filter(Boolean))];
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('und').trim();
}

function codePointLength(value) {
  return [...String(value)].length;
}

function clip(value, maximum = EVIDENCE_CHARS) {
  const points = [...String(value ?? '')];
  return points.length <= maximum ? points.join('') : `${points.slice(0, maximum - 1).join('')}…`;
}

function tokenize(value) {
  const normalized = normalize(value);
  const tokens = [];
  try {
    const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike) tokens.push(segment.segment);
    }
  } catch {
    tokens.push(...(normalized.match(/[\p{L}\p{N}_]+/gu) ?? []));
  }
  return [...new Set(tokens.map(normalize).filter(Boolean))].slice(0, 64);
}

function quoteFtsTerm(term) {
  return `"${String(term).replaceAll('"', '""')}"`;
}

function wordFtsQuery(text, operator = 'AND') {
  const terms = tokenize(text);
  return terms.length > 0 ? terms.map(quoteFtsTerm).join(` ${operator} `) : null;
}

function trigramFtsQuery(text) {
  const candidate = normalize(text).replace(/\s+/gu, ' ').trim();
  return [...candidate].length >= 3 ? quoteFtsTerm(candidate) : null;
}

function candidateRows(db, host, kinds, explicitKinds, onlyIds = null) {
  const parameters = [];
  let selection;
  if (explicitKinds) {
    const normalizedKinds = [...new Set(kinds.map(normalize))];
    const includesProvider = normalizedKinds.includes('provider');
    const actualKinds = normalizedKinds.filter((kind) => kind !== 'provider');
    const clauses = [];
    if (includesProvider) clauses.push("role = 'provider'");
    if (actualKinds.length > 0) {
      clauses.push(`kind IN (${actualKinds.map(() => '?').join(', ')})`);
      parameters.push(...actualKinds);
    }
    selection = `visibility <> 'hidden' AND (${clauses.join(' OR ') || '0'})`;
  } else {
    selection = "role <> 'provider' AND kind IN ('skill', 'agent', 'subagent', 'context') AND visibility NOT IN ('hidden', 'explicit')";
  }
  const idFilter = onlyIds?.length
    ? `AND capability.id IN (${onlyIds.map(() => '?').join(', ')})`
    : '';
  if (onlyIds?.length) parameters.push(...onlyIds);
  parameters.push(normalize(host), '*', 'all', 'portable');
  return db.prepare(`
    SELECT id, role, kind, name, normalized_name, summary, aliases_json, triggers_json,
           anti_triggers_json, search_text
    FROM capability
    WHERE ${selection}
      ${idFilter}
      AND (
        NOT EXISTS (SELECT 1 FROM capability_target WHERE capability_id = capability.id)
        OR EXISTS (
          SELECT 1 FROM capability_target
          WHERE capability_id = capability.id AND target IN (?, ?, ?, ?)
        )
      )
    ORDER BY id
  `).all(...parameters).map((row) => ({
    id: row.id,
    role: row.role,
    kind: row.kind,
    name: row.name,
    normalizedName: row.normalized_name,
    summary: row.summary,
    aliases: parseJson(row.aliases_json, []),
    triggers: parseJson(row.triggers_json, []),
    antiTriggers: parseJson(row.anti_triggers_json, []),
    searchText: row.search_text,
  }));
}

function candidateMap(db, host, kinds, explicitKinds, onlyIds = null) {
  return new Map(candidateRows(db, host, kinds, explicitKinds, onlyIds)
    .map((capability) => [capability.id, capability]));
}

function exactAliasCandidateIds(db, intent) {
  const values = [...new Set(intentInputs(intent).map(({ normalized }) => normalized).filter(Boolean))];
  if (values.length === 0) return [];
  const placeholders = values.map(() => '?').join(', ');
  return db.prepare(`
    SELECT DISTINCT capability_id FROM capability_alias
    WHERE normalized_alias IN (${placeholders}) ORDER BY capability_id
  `).all(...values).map(({ capability_id: id }) => id);
}

function categoryDescendants(db, categories) {
  const result = new Set();
  const query = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM category WHERE id = ?
      UNION ALL
      SELECT category.id FROM category JOIN descendants ON category.parent_id = descendants.id
    ) SELECT id FROM descendants ORDER BY id
  `);
  for (const category of categories) {
    const rows = query.all(category);
    if (rows.length === 0) throw new Error(`Unknown capability category: ${category}`);
    for (const row of rows) result.add(row.id);
  }
  return result;
}

function metadataFields(capability) {
  return [
    { field: 'name', value: capability.name },
    ...capability.aliases.map((value) => ({ field: 'alias', value })),
    { field: 'summary', value: capability.summary },
    ...capability.triggers.map((value) => ({ field: 'trigger', value })),
  ].filter(({ value }) => String(value ?? '').trim());
}

function evidence(channel, fragment, field, value, categoryPath) {
  const record = { channel, fragment: clip(fragment), field, value: clip(value) };
  if (categoryPath) record.categoryPath = categoryPath;
  return record;
}

function pushEvidence(reasons, id, item) {
  const items = reasons.get(id) ?? [];
  const key = JSON.stringify(item);
  if (!items.some((current) => JSON.stringify(current) === key)) items.push(item);
  reasons.set(id, items);
}

function addChannel(scores, reasons, entries, weight) {
  const seen = new Set();
  entries.forEach((entry, index) => {
    if (!seen.has(entry.id)) {
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + weight / (RRF_K + index + 1));
      seen.add(entry.id);
    }
    if (entry.evidence) pushEvidence(reasons, entry.id, entry.evidence);
  });
}

function ftsIds(db, table, query) {
  if (!query) return [];
  return db.prepare(`
    SELECT capability_id, bm25(${table}) AS score
    FROM ${table} WHERE ${table} MATCH ?
    ORDER BY score, capability_id LIMIT ${RETRIEVAL_LIMIT}
  `).all(query).map((row) => row.capability_id);
}

function providerFor(db, providerId) {
  if (!providerId) return null;
  const row = db.prepare('SELECT id, kind, name, summary FROM capability WHERE id = ?').get(providerId);
  return row ? { id: row.id, kind: row.kind, name: row.name, summary: row.summary } : { id: providerId };
}

function boundedStringList(value, label, maximumItems, maximumChars) {
  const raw = asArray(value);
  if (raw.length > maximumItems) throw new Error(`${label} may contain at most ${maximumItems} items.`);
  const result = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`${label} items must be strings.`);
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (codePointLength(trimmed) > maximumChars) {
      throw new Error(`${label} items may contain at most ${maximumChars} characters.`);
    }
    if (!result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

function normalizeIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error('Resolve intent must be an object.');
  }
  if (typeof intent.task !== 'string') throw new Error('Resolve intent task must be a string.');
  const task = intent.task.trim();
  if (!task) throw new Error('Resolve intent requires a non-empty task.');
  if (codePointLength(task) > MAX_TASK_CHARS) {
    throw new Error(`Resolve intent task may contain at most ${MAX_TASK_CHARS} characters.`);
  }
  return {
    task,
    needs: boundedStringList(intent.needs, 'Resolve intent needs', MAX_NEEDS_HINTS, MAX_NEED_HINT_CHARS),
    hints: boundedStringList(intent.hints, 'Resolve intent hints', MAX_NEEDS_HINTS, MAX_NEED_HINT_CHARS),
    categories: boundedStringList(intent.categories,
      'Resolve intent categories', MAX_KINDS_CATEGORIES, MAX_KIND_CATEGORY_CHARS),
    kinds: boundedStringList(intent.kinds,
      'Resolve intent kinds', MAX_KINDS_CATEGORIES, MAX_KIND_CATEGORY_CHARS),
  };
}

function intentInputs(intent) {
  return [
    { field: 'task', value: intent.task },
    ...intent.needs.map((value) => ({ field: 'need', value })),
    ...intent.hints.map((value) => ({ field: 'hint', value })),
  ].map((item) => ({ ...item, normalized: normalize(item.value), tokens: new Set(tokenize(item.value)) }));
}

function bestMetadataMatch(capability, input, predicate) {
  return metadataFields(capability)
    .map((item) => ({ ...item, normalized: normalize(item.value) }))
    .filter((item) => predicate(item.normalized, input.normalized))
    .sort((left, right) => codePointLength(right.normalized) - codePointLength(left.normalized)
      || left.field.localeCompare(right.field) || left.value.localeCompare(right.value))[0];
}

function keywordMetadataEvidence(capability, query) {
  const terms = tokenize(query);
  const matches = metadataFields(capability).map((item) => {
    const normalizedValue = normalize(item.value);
    const valueTokens = new Set(tokenize(item.value));
    const hits = terms.filter((term) => valueTokens.has(term) || normalizedValue.includes(term));
    return { ...item, hits };
  }).filter(({ hits }) => hits.length > 0)
    .sort((left, right) => right.hits.length - left.hits.length
      || left.field.localeCompare(right.field) || left.value.localeCompare(right.value));
  const match = matches[0] ?? metadataFields(capability)[0];
  return evidence('keyword', (match?.hits ?? terms).slice(0, 8).join(' '),
    match?.field ?? 'name', match?.value ?? capability.name);
}

function inferCategoryMatches(db, intent) {
  const inputs = intentInputs(intent);
  const categories = db.prepare(`
    SELECT id, name, description, aliases_json, path FROM category ORDER BY id
  `).all();
  const matches = [];
  for (const category of categories) {
    const descriptors = [
      { field: 'category.id', value: category.id },
      { field: 'category.name', value: category.name },
      { field: 'category.description', value: category.description },
      ...parseJson(category.aliases_json, []).map((value) => ({ field: 'category.alias', value })),
    ].filter(({ value }) => String(value ?? '').trim());
    let best = null;
    for (const input of inputs) {
      for (const descriptor of descriptors) {
        const normalizedValue = normalize(descriptor.value);
        if (codePointLength(normalizedValue) < 2) continue;
        let strength = 0;
        let fragment = input.value;
        if (input.normalized === normalizedValue) strength = 3;
        else if (input.normalized.includes(normalizedValue)) strength = 2;
        else {
          const matchingToken = tokenize(normalizedValue)
            .filter((token) => codePointLength(token) >= 3 && input.tokens.has(token))
            .sort((left, right) => codePointLength(right) - codePointLength(left))[0];
          if (matchingToken) {
            strength = 1;
            fragment = matchingToken;
          }
        }
        if (strength > (best?.strength ?? 0)) {
          best = {
            categoryId: category.id,
            categoryPath: category.path,
            strength,
            fragment,
            field: descriptor.field,
            value: descriptor.value,
          };
        }
      }
    }
    if (best) matches.push(best);
  }
  for (const categoryId of intent.categories) {
    const category = categories.find(({ id }) => id === categoryId);
    if (!category) throw new Error(`Unknown capability category: ${categoryId}`);
    matches.push({
      categoryId,
      categoryPath: category.path,
      strength: 4,
      fragment: categoryId,
      field: 'category.hint',
      value: category.name,
      explicit: true,
    });
  }
  return matches.sort((left, right) => right.strength - left.strength
    || left.categoryId.localeCompare(right.categoryId));
}

function retrievalCandidateIds(db, intent) {
  const ids = new Set(exactAliasCandidateIds(db, intent));
  const inputs = intentInputs(intent);
  const combined = inputs.map(({ value }) => value).join(' ');
  let wordIds = ftsIds(db, 'capability_fts_word', wordFtsQuery(combined));
  if (wordIds.length === 0) wordIds = ftsIds(db, 'capability_fts_word', wordFtsQuery(combined, 'OR'));
  for (const id of wordIds) ids.add(id);
  for (const { normalized } of inputs) {
    for (const id of ftsIds(db, 'capability_fts_trigram', trigramFtsQuery(normalized))) ids.add(id);
  }
  const membershipQuery = db.prepare(`
    SELECT DISTINCT capability_id FROM capability_category
    WHERE category_id IN (SELECT id FROM category WHERE id = ?)
       OR category_id IN (
         WITH RECURSIVE descendants(id) AS (
           SELECT id FROM category WHERE parent_id = ?
           UNION ALL
           SELECT category.id FROM category JOIN descendants ON category.parent_id = descendants.id
         ) SELECT id FROM descendants
       )
    ORDER BY capability_id LIMIT ${RETRIEVAL_LIMIT}
  `);
  for (const match of inferCategoryMatches(db, intent)) {
    for (const row of membershipQuery.all(match.categoryId, match.categoryId)) ids.add(row.capability_id);
  }
  return [...ids].sort();
}

function addCategoryChannels(db, scores, reasons, candidateIds, intent) {
  if (candidateIds.size === 0) return;
  for (const match of inferCategoryMatches(db, intent)) {
    const descendants = categoryDescendants(db, [match.categoryId]);
    const categoryPlaceholders = [...descendants].map(() => '?').join(', ');
    const candidatePlaceholders = [...candidateIds].map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT capability_category.capability_id, category.path
      FROM capability_category JOIN category ON category.id = capability_category.category_id
      WHERE capability_category.category_id IN (${categoryPlaceholders})
        AND capability_category.capability_id IN (${candidatePlaceholders})
      ORDER BY capability_category.capability_id, category.path
    `).all(...descendants, ...candidateIds);
    addChannel(scores, reasons, rows.map((row) => ({
      id: row.capability_id,
      evidence: evidence('category', match.fragment, match.field, match.value, row.path),
    })), match.explicit ? 1.8 : 1.2 + (match.strength * 0.15));
  }
}

function rankCapabilities(db, candidates, intent) {
  const scores = new Map();
  const reasons = new Map();
  const inputs = intentInputs(intent);
  const normalizedInputs = inputs.map(({ normalized }) => normalized).filter(Boolean);
  const searchFragments = [...new Set([
    ...normalizedInputs,
    ...inputs.flatMap(({ value }) => tokenize(value)),
  ])].filter((fragment) => codePointLength(fragment) >= 2);
  const eligibleCandidates = new Map([...candidates].filter(([, capability]) =>
    !capability.antiTriggers.map(normalize).some((phrase) =>
      phrase && normalizedInputs.some((input) => input.includes(phrase)))));
  const candidateIds = new Set(eligibleCandidates.keys());

  const exact = [];
  for (const capability of eligibleCandidates.values()) {
    for (const input of inputs) {
      const match = bestMetadataMatch(capability, input, (metadata, request) => metadata === request);
      if (match) {
        exact.push({ id: capability.id, evidence: evidence('exact', input.value, match.field, match.value) });
        break;
      }
    }
  }
  exact.sort((left, right) => left.id.localeCompare(right.id));
  addChannel(scores, reasons, exact, 12);

  const embedded = [];
  for (const capability of eligibleCandidates.values()) {
    let best = null;
    for (const input of inputs) {
      const match = bestMetadataMatch(capability, input,
        (metadata, request) => codePointLength(metadata) >= 2 && request.includes(metadata));
      if (match && codePointLength(match.value) > codePointLength(best?.match?.value ?? '')) best = { input, match };
    }
    if (best) embedded.push({
      id: capability.id,
      length: codePointLength(best.match.value),
      evidence: evidence('embedded', best.input.value, best.match.field, best.match.value),
    });
  }
  embedded.sort((left, right) => right.length - left.length || left.id.localeCompare(right.id));
  addChannel(scores, reasons, embedded, 8);
  addCategoryChannels(db, scores, reasons, candidateIds, intent);

  const combined = inputs.map(({ value }) => value).join(' ');
  let wordIds = ftsIds(db, 'capability_fts_word', wordFtsQuery(combined))
    .filter((id) => candidateIds.has(id));
  if (wordIds.length === 0) {
    wordIds = ftsIds(db, 'capability_fts_word', wordFtsQuery(combined, 'OR'))
      .filter((id) => candidateIds.has(id));
  }
  addChannel(scores, reasons, wordIds.map((id) => ({
    id,
    evidence: keywordMetadataEvidence(eligibleCandidates.get(id), combined),
  })), 6);

  const trigramEntries = [];
  const trigramSeen = new Set();
  const addTrigramMatches = (fragments) => {
    for (const fragment of fragments) {
      const query = trigramFtsQuery(fragment);
      if (!query) continue;
      for (const id of ftsIds(db, 'capability_fts_trigram', query)) {
        if (!candidateIds.has(id) || trigramSeen.has(id)) continue;
        const capability = eligibleCandidates.get(id);
        const request = { value: fragment, normalized: normalize(fragment) };
        const match = bestMetadataMatch(capability, request, (metadata, input) => metadata.includes(input));
        trigramEntries.push({
          id,
          evidence: evidence('trigram', fragment,
            match?.field ?? 'metadata', match?.value ?? capability.searchText),
        });
        trigramSeen.add(id);
      }
    }
  };
  addTrigramMatches(normalizedInputs);
  if (trigramEntries.length === 0) {
    addTrigramMatches(searchFragments.filter((fragment) => !normalizedInputs.includes(fragment)));
  }
  addChannel(scores, reasons, trigramEntries, 3);

  let substringMatches = [];
  for (const capability of eligibleCandidates.values()) {
    let best = null;
    for (const input of inputs) {
      const match = bestMetadataMatch(capability, input, (metadata, request) => metadata.includes(request));
      if (match) {
        const position = normalize(match.value).indexOf(input.normalized);
        if (!best || position < best.position) best = { input, match, position };
      }
    }
    if (best) substringMatches.push({
      id: capability.id,
      position: best.position,
      evidence: evidence('substring', best.input.value, best.match.field, best.match.value),
    });
  }
  if (substringMatches.length === 0) {
    for (const capability of eligibleCandidates.values()) {
      for (const fragment of searchFragments) {
        const request = { value: fragment, normalized: normalize(fragment) };
        const match = bestMetadataMatch(capability, request, (metadata, input) => metadata.includes(input));
        if (match) {
          substringMatches.push({
            id: capability.id,
            position: normalize(match.value).indexOf(request.normalized),
            evidence: evidence('substring', fragment, match.field, match.value),
          });
          break;
        }
      }
    }
  }
  substringMatches.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  addChannel(scores, reasons, substringMatches, 2);

  return [...scores]
    .sort(([idA, scoreA], [idB, scoreB]) => scoreB - scoreA || idA.localeCompare(idB))
    .map(([id, score]) => ({ capability: eligibleCandidates.get(id), score, reasons: reasons.get(id) ?? [] }));
}

function fullCapability(db, id) {
  const row = db.prepare('SELECT * FROM capability WHERE id = ?').get(id);
  if (!row) throw new Error(`Capability disappeared from index: ${id}`);
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    targets: parseJson(row.targets_json, []),
    providerId: row.provider_id,
    activation: parseJson(row.activation_json, {}),
    resource: row.resource,
  };
}

function resultRecord(db, ranked, rank) {
  const capability = fullCapability(db, ranked.capability.id);
  return {
    rank,
    id: capability.id,
    role: capability.role,
    kind: capability.kind,
    name: capability.name,
    summary: capability.summary,
    score: Number(ranked.score.toFixed(8)),
    reasons: ranked.reasons,
    matchedCategoryPaths: [...new Set(ranked.reasons.map((reason) => reason.categoryPath).filter(Boolean))],
    provider: providerFor(db, capability.providerId),
    activation: capability.activation,
    targets: capability.targets,
    resource: capability.resource,
    ...(capability.kind === 'context' ? { path: capability.resource } : {}),
  };
}

function boundedLimit(limit) {
  const parsed = Number(limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('Limit must be a positive integer.');
  return Math.min(parsed, MAX_RESULTS);
}

function checkedHost(host) {
  const normalized = normalize(host);
  if (!normalized) throw new Error('A host is required.');
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) throw new Error(`Invalid capability host: ${host}`);
  return normalized;
}

function assertKnownHost(db, host) {
  if (SUPPORTED_HOSTS.has(host)) return;
  const declared = db.prepare('SELECT 1 FROM capability_target WHERE target = ? LIMIT 1').get(host);
  if (!declared) throw new Error(`Unsupported capability host: ${host}`);
}

export async function resolveCapabilities({ dbPath, host, intent, limit = DEFAULT_LIMIT }) {
  const resolvedHost = checkedHost(host);
  const normalizedIntent = normalizeIntent(intent);
  const explicitKinds = normalizedIntent.kinds.length > 0;
  return withReadOnlyCapabilityIndex(dbPath, (db, revision) => {
    assertKnownHost(db, resolvedHost);
    const retrievalIds = retrievalCandidateIds(db, normalizedIntent);
    let candidates = candidateMap(db, resolvedHost, normalizedIntent.kinds, explicitKinds,
      retrievalIds.length > 0 ? retrievalIds : null);
    if (retrievalIds.length > 0 && candidates.size === 0) {
      candidates = candidateMap(db, resolvedHost, normalizedIntent.kinds, explicitKinds);
    }
    const ranked = rankCapabilities(db, candidates, normalizedIntent).slice(0, boundedLimit(limit));
    return {
      ok: true,
      revision,
      host: resolvedHost,
      intent: normalizedIntent,
      results: ranked.map((entry, index) => resultRecord(db, entry, index + 1)),
    };
  });
}

export async function browseCategory({ dbPath, host, category, kind, limit = DEFAULT_LIMIT }) {
  const resolvedHost = checkedHost(host);
  if (!String(category ?? '').trim()) throw new Error('Browse requires a category.');
  const kinds = boundedStringList(kind, 'Browse kinds', MAX_KINDS_CATEGORIES, MAX_KIND_CATEGORY_CHARS);
  const categoryId = String(category).trim();
  if (codePointLength(categoryId) > MAX_KIND_CATEGORY_CHARS) {
    throw new Error(`Browse category may contain at most ${MAX_KIND_CATEGORY_CHARS} characters.`);
  }
  const explicitKinds = kinds.length > 0;
  return withReadOnlyCapabilityIndex(dbPath, (db, revision) => {
    assertKnownHost(db, resolvedHost);
    const candidates = candidateMap(db, resolvedHost, kinds, explicitKinds);
    const descendants = categoryDescendants(db, [categoryId]);
    const placeholders = [...descendants].map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT DISTINCT capability_category.capability_id, category.path
      FROM capability_category JOIN category ON category.id = capability_category.category_id
      WHERE capability_category.category_id IN (${placeholders})
      ORDER BY capability_category.capability_id, category.path
    `).all(...descendants).filter((row) => candidates.has(row.capability_id));
    const grouped = new Map();
    for (const row of rows) {
      const paths = grouped.get(row.capability_id) ?? [];
      paths.push(row.path);
      grouped.set(row.capability_id, paths);
    }
    const selected = [...grouped].slice(0, boundedLimit(limit));
    return {
      ok: true,
      revision,
      host: resolvedHost,
      category: categoryId,
      results: selected.map(([capabilityId, paths], index) => resultRecord(db, {
        capability: candidates.get(capabilityId),
        score: 1 / (RRF_K + index + 1),
        reasons: paths.map((path) =>
          evidence('category-browse', categoryId, 'category.id', categoryId, path)),
      }, index + 1)),
    };
  });
}
