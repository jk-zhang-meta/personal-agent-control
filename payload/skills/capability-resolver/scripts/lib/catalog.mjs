import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { readCapabilityOverlay } from "./capability-overlay.mjs";

const HEADERS = {
  plugins: [
    "plugin", "marketplace", "acquisition", "source", "ref", "resolved-commit",
    "tree-id", "version", "targets", "bundled-skills", "license", "visibility",
  ],
  tools: ["name", "version", "owner", "purpose", "integrity-or-lock"],
};

const HOST_NAMES = new Map([
  ["codex", "codex"],
  ["codexcli", "codex"],
  ["claude", "claude"],
  ["claudecode", "claude"],
]);

export function defaultSkillRoot(home = homedir()) {
  return path.join(path.resolve(home), ".local/share/agent-skills/.agents/skills");
}

export function loadSourceModel({ repo, home, skillRoot, strictRouting = true, profile = null }) {
  const roots = normalizeRoots(repo, home, skillRoot, profile);
  return compileSourceModel({ ...roots, strictRouting, validationOnly: false });
}

export function validateRepositoryMetadata({ repo, skillRoot = defaultSkillRoot(), profile = null }) {
  const repoRoot = absoluteDirectory(repo, "repository");
  const profileRoot = profile === null ? null : absoluteDirectory(profile, "Profile repository");
  const result = compileSourceModel({
    repo: repoRoot,
    profile: profileRoot,
    home: null,
    skillRoot: absoluteDirectory(skillRoot, "Skill inventory root"),
    strictRouting: true,
    validationOnly: true,
  });
  return {
    revision: result.revision,
    taxonomyCount: result.taxonomy.length,
    capabilityCount: result.capabilities.length,
    relationCount: result.relations.length,
  };
}

function compileSourceModel({ repo, profile, home, skillRoot, strictRouting, validationOnly }) {
  const taxonomyDocument = readJson(path.join(repo, "catalog/taxonomy.json"));
  const taxonomy = validateTaxonomy(taxonomyDocument);
  const categoryIds = new Set(taxonomy.map(({ id }) => id));
  const profileManifest = profile === null ? null : readProfileManifest(profile);
  const profileOverlayFile = optionalRegularFile(profile, "catalog/capabilities.jsonl");
  const coreOverlay = readCapabilityOverlay(path.join(repo, "catalog/capabilities.jsonl"), categoryIds);
  const profileOverlay = profileOverlayFile === null
    ? new Map()
    : readCapabilityOverlay(profileOverlayFile, categoryIds);
  const overlay = new Map(coreOverlay);
  for (const [id, record] of profileOverlay) {
    if (overlay.has(id)) throw new Error(`duplicate capability overlay id ${id}`);
    overlay.set(id, record);
  }

  const pluginRows = [
    ...readTsv(path.join(repo, "catalog/plugins.tsv"), HEADERS.plugins),
    ...readOptionalTsv(profile, "catalog/plugins.tsv", HEADERS.plugins),
  ];
  const providerRows = readProviderCatalog(repo);
  validatePluginRows(pluginRows);
  const toolRows = readTsv(path.join(repo, "catalog/tools.tsv"), HEADERS.tools);
  const pluginRuntime = loadPluginRuntime(repo, home, pluginRows, validationOnly, profileManifest);
  const profileIdentity = profile === null ? null : readProfileIdentity(profile);
  const enabledProviders = profileManifest?.providers?.enabled ?? [];
  const knownProviders = new Set(providerRows.map(({ name }) => name));
  const unknownProviders = enabledProviders.filter((name) => !knownProviders.has(name));
  if (unknownProviders.length) {
    throw new Error(`pac-profile.json enables unknown provider(s): ${unknownProviders.join(", ")}`);
  }

  const toolNames = new Set(toolRows.map((row) => row.name));
  const capabilities = new Map();
  const relations = [];
  const frontmatters = [];
  const declaredIds = new Set();
  const skillNames = new Set();
  const bundledSkillIndexes = new Map();
  const profileSkillTargets = new Map(
    (profileManifest?.skills ?? []).map((skill) => [skill.name, skill.targets]),
  );
  const seenProfileSkills = new Set();

  const standaloneSkills = scanStandaloneSkills(skillRoot);
  for (const [id, metadata] of profileOverlay) {
    if (!id.startsWith("context:")) continue;
    const name = id.slice("context:".length);
    requireString(name, "Profile context id");
    declareId(declaredIds, id);
    validateOverlayIdentity(metadata, "capability", "context", id, metadata.name ?? name);
    const resource = resolveProfileContextPath(profile, metadata.path, id);
    const required = parseList(metadata.requires);
    validateDependencies(required, toolNames, name);
    const dependencies = required.map((dependency) => `dependency:${dependency}`).sort();
    capabilities.set(id, makeCapability({
      id,
      role: "capability",
      kind: "context",
      name: metadata.name ?? name,
      summary: metadata.summary ?? "",
      metadata,
      memberships: ["kind.context"],
      targets: parseTargets(metadata.targets),
      providerId: null,
      delivery: metadata.delivery ?? "profile-context",
      requires: dependencies,
      visibility: metadata.visibility ?? "private",
      activation: {
        type: "read-context",
        path: resource,
        policy: metadata.activationPolicy ?? "automatic",
      },
      resource,
    }, categoryIds));
    for (const dependency of dependencies) relations.push({ from: id, type: "requires", to: dependency });
  }
  for (const skill of standaloneSkills) {
    const id = `skill:${skill.name}`;
    declareSkillName(skillNames, skill.name);
    declareId(declaredIds, id);
    const metadata = overlay.get(id);
    if (strictRouting && !metadata) throw new Error(`missing capability overlay metadata for ${id}`);
    validateOverlayIdentity(metadata, "capability", "skill", id, skill.name);
    const required = parseList(metadata?.requires);
    validateDependencies(required, toolNames, skill.name);
    const targets = parseTargets(metadata?.targets);
    if (strictRouting && targets.length === 0) {
      throw new Error(`standalone Skill ${skill.name} must declare at least one target in capabilities.jsonl`);
    }
    const declaredProfileTargets = profileSkillTargets.get(skill.name);
    if (declaredProfileTargets) {
      if (JSON.stringify(targets) !== JSON.stringify(declaredProfileTargets)) {
        throw new Error(
          `Profile Skill ${skill.name} targets differ between pac-profile.json and capabilities.jsonl`,
        );
      }
      if (metadata?.delivery !== "profile") {
        throw new Error(
          `Profile Skill ${skill.name} delivery must be profile in capabilities.jsonl`,
        );
      }
      seenProfileSkills.add(skill.name);
    }
    frontmatters.push({ id, ...skill.frontmatter });
    const dependencies = required.map((name) => `dependency:${name}`).sort();
    capabilities.set(id, makeCapability({
      id,
      role: "capability",
      kind: "skill",
      name: skill.name,
      summary: skill.frontmatter.description,
      metadata,
      memberships: ["kind.skill"],
      targets,
      providerId: null,
      delivery: metadata?.delivery ?? "apm",
      requires: dependencies,
      visibility: metadata?.visibility ?? "private",
      activation: {
        type: "read-skill",
        resource: skill.resource,
        policy: metadata?.activationPolicy ?? "automatic",
      },
      resource: skill.resource,
    }, categoryIds));
    for (const dependency of dependencies) relations.push({ from: id, type: "requires", to: dependency });
  }
  const missingProfileSkills = [...profileSkillTargets.keys()]
    .filter((name) => !seenProfileSkills.has(name));
  if (missingProfileSkills.length) {
    throw new Error(`Profile manifest Skill(s) missing from the installed inventory: ${missingProfileSkills.join(", ")}`);
  }

  for (const row of [...pluginRows].sort(compareBy("marketplace", "plugin"))) {
    const providerId = `provider:plugin:${row.plugin}@${row.marketplace}`;
    declareId(declaredIds, providerId);
    const metadata = overlay.get(providerId);
    if (strictRouting && !metadata) throw new Error(`missing capability overlay metadata for ${providerId}`);
    validateOverlayIdentity(metadata, "provider", "plugin", providerId, row.plugin);
    const catalogTargets = parseTargets(row.targets);
    const targets = validationOnly
      ? catalogTargets
      : catalogTargets.filter((target) => pluginRuntime.enabledHosts.includes(target));
    const bundledSkills = parseList(row["bundled-skills"]);
    const bundledMetadata = new Map();
    for (const skillName of bundledSkills) {
      const skillId = `skill:${skillName}`;
      declareSkillName(skillNames, skillName);
      declareId(declaredIds, skillId);
      const skillMetadata = overlay.get(skillId);
      if (strictRouting && !skillMetadata) throw new Error(`missing capability overlay metadata for ${skillId}`);
      validateOverlayIdentity(skillMetadata, "capability", "skill", skillId, skillName);
      bundledMetadata.set(skillName, skillMetadata);
    }
    if (!validationOnly && (!pluginRuntime.enabledPlugins.includes(row.plugin) || targets.length === 0)) {
      continue;
    }

    const sourceRoot = validationOnly ? null
      : path.join(home, ".local/share/agent-plugins/sources", row.marketplace);
    capabilities.set(providerId, makeCapability({
      id: providerId,
      role: "provider",
      kind: "plugin",
      name: row.plugin,
      summary: metadata?.summary ?? "",
      metadata,
      memberships: ["kind.provider.plugin"],
      targets,
      providerId: null,
      delivery: "native-plugin",
      requires: [],
      visibility: row.visibility,
      activation: { type: "host-plugin", plugin: row.plugin, marketplace: row.marketplace },
      resource: sourceRoot,
    }, categoryIds));

    for (const skillName of bundledSkills) {
      const skillId = `skill:${skillName}`;
      const skillMetadata = bundledMetadata.get(skillName);
      let resource = null;
      let frontmatter = null;
      if (!validationOnly) {
        resource = findBundledSkill(sourceRoot, row.plugin, skillName, bundledSkillIndexes);
        frontmatter = readSkillFrontmatter(resource, skillName);
        frontmatters.push({ id: skillId, ...frontmatter });
      }
      capabilities.set(skillId, makeCapability({
        id: skillId,
        role: "capability",
        kind: "skill",
        name: skillName,
        summary: frontmatter?.description ?? "",
        metadata: skillMetadata,
        memberships: ["kind.skill"],
        targets,
        providerId,
        delivery: "native-plugin",
        requires: [],
        visibility: row.visibility,
        activation: {
          type: "native-plugin-skill",
          plugin: row.plugin,
          marketplace: row.marketplace,
          skill: skillName,
        },
        resource,
      }, categoryIds));
      relations.push({ from: providerId, type: "provides", to: skillId });
    }
  }

  for (const row of providerRows) {
    const providerId = `provider:${row.name}`;
    declareId(declaredIds, providerId);
    const metadata = overlay.get(providerId);
    if (strictRouting && !metadata) throw new Error(`missing capability overlay metadata for ${providerId}`);
    validateOverlayIdentity(metadata, "provider", row.kind, providerId, row.name);
    const catalogTargets = parseTargets(Object.keys(row.hosts));
    const targets = validationOnly
      ? catalogTargets
      : enabledProviders.includes(row.name)
        ? catalogTargets.filter((target) => pluginRuntime.enabledHosts.includes(target))
        : [];
    capabilities.set(providerId, makeCapability({
      id: providerId,
      role: "provider",
      kind: row.kind,
      name: row.name,
      summary: metadata?.summary ?? "",
      metadata,
      memberships: ["kind.provider", `kind.provider.${row.kind}`],
      targets,
      providerId: null,
      delivery: "mcp",
      requires: [],
      visibility: metadata?.visibility ?? "private",
      activation: { type: "mcp-server", name: row.name, command: row.command, args: row.args },
      resource: null,
    }, categoryIds));
  }

  const agentRows = loadCanonicalSubagents(repo);
  for (const agent of agentRows) {
    const id = `subagent:${agent.name}`;
    declareId(declaredIds, id);
    const metadata = overlay.get(id);
    if (strictRouting && !metadata) throw new Error(`missing capability overlay metadata for ${id}`);
    validateOverlayIdentity(metadata, "capability", "subagent", id, agent.name);
    frontmatters.push({ id, name: agent.name, description: agent.description, targets: agent.targets });
    capabilities.set(id, makeCapability({
      id,
      role: "capability",
      kind: "subagent",
      name: agent.name,
      summary: agent.description,
      metadata,
      memberships: ["kind.subagent"],
      targets: agent.targets,
      providerId: null,
      delivery: "native-subagent",
      requires: [],
      visibility: "private",
      activation: { type: "delegate", name: agent.name },
      resource: agent.resource,
    }, categoryIds));
  }

  for (const [id] of overlay) {
    if (declaredIds.has(id)) continue;
    throw new Error(`capability overlay invents an undeclared capability: ${id}`);
  }

  const sortedCapabilities = [...capabilities.values()].sort(compareBy("id"));
  const sortedRelations = dedupeRelations(relations);
  const normalizedCatalogs = {
    plugins: sortRecords(pluginRows),
    tools: sortRecords(toolRows),
    providers: sortRecords(providerRows),
  };
  const logicalCapabilities = sortedCapabilities.map(({ resource: _resource, activation, ...rest }) => ({
    ...rest,
    activation: stripMachinePaths(activation),
  }));
  const revision = sha256(stableStringify({
    schemaVersion: 2,
    profileIdentity,
    taxonomy,
    overlay: sortRecords([...overlay.values()].map(normalizeOverlayRecord)),
    catalogs: normalizedCatalogs,
    pluginRuntime,
    frontmatters: sortRecords(frontmatters),
    capabilities: logicalCapabilities,
    relations: sortedRelations,
  }));

  return { revision, taxonomy, capabilities: sortedCapabilities, relations: sortedRelations };
}

function makeCapability(input, categoryIds) {
  const metadata = input.metadata ?? {};
  const memberships = uniqueSorted([...input.memberships, ...arrayField(metadata.memberships)]);
  for (const membership of memberships) {
    if (!categoryIds.has(membership)) throw new Error(`${input.id} uses unknown category ${membership}`);
  }
  return {
    id: input.id,
    role: input.role,
    kind: input.kind,
    name: input.name,
    summary: normalizeText(input.summary),
    aliases: uniqueSorted(arrayField(metadata.aliases).map(normalizeText).filter(Boolean)),
    triggers: uniqueSorted(arrayField(metadata.triggers).map(normalizeText).filter(Boolean)),
    antiTriggers: uniqueSorted(
      arrayField(metadata.antiTriggers ?? metadata.anti_triggers).map(normalizeText).filter(Boolean),
    ),
    memberships,
    targets: uniqueSorted(input.targets),
    providerId: input.providerId,
    delivery: input.delivery ?? null,
    requires: uniqueSorted(input.requires),
    visibility: input.visibility ?? "private",
    activation: input.activation,
    resource: input.resource ?? null,
  };
}

function loadCanonicalSubagents(repo) {
  const directory = path.join(repo, ".rulesync/subagents");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const resource = path.join(directory, entry.name);
      const values = parseFrontmatter(resource);
      requireString(values.name, `${resource} frontmatter name`);
      requireString(values.description, `${resource} frontmatter description`);
      return {
        name: values.name,
        description: normalizeText(values.description),
        targets: parseTargets(values.targets),
        resource,
      };
    });
}

function readSkillFrontmatter(resource, expectedName = null) {
  const values = parseFrontmatter(resource);
  requireString(values.name, `${resource} frontmatter name`);
  requireString(values.description, `${resource} frontmatter description`);
  if (expectedName !== null && values.name !== expectedName) {
    throw new Error(`Skill frontmatter name mismatch at ${resource}: expected ${expectedName}, got ${values.name}`);
  }
  return { name: values.name, description: normalizeText(values.description) };
}

function scanStandaloneSkills(skillRoot) {
  const skills = [];
  for (const entry of readdirSync(skillRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`standalone Skill inventory entry must not be a symlink: ${path.join(skillRoot, entry.name)}`);
    }
    if (!entry.isDirectory()) continue;
    const resource = path.join(skillRoot, entry.name, 'SKILL.md');
    const frontmatter = readSkillFrontmatter(resource);
    skills.push({ name: frontmatter.name, resource, frontmatter });
  }
  return skills;
}

function parseFrontmatter(file) {
  const text = readFrontmatter(file);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const values = {};
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim() === "") {
      index += 1;
      continue;
    }
    const lineNumber = index + 2;
    if (/^[ \t]/.test(lines[index])) {
      throw yamlError(file, lineNumber, "unexpected indented YAML content");
    }
    if (lines[index].startsWith("#")) {
      throw yamlError(file, lineNumber, "YAML comments are unsupported");
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(lines[index]);
    if (!match) {
      throw yamlError(file, lineNumber, "unsupported YAML syntax or indicator");
    }
    const [, key, captured = ""] = match;
    const raw = captured.trim();
    if (Object.hasOwn(values, key)) throw yamlError(file, lineNumber, `duplicate YAML key ${key}`);
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-" || raw === ">+" || raw === "|+") {
      const block = [];
      index += 1;
      const blockStartLine = index + 2;
      while (index < lines.length && (lines[index].trim() === "" || /^[ \t]+/.test(lines[index]))) {
        block.push(lines[index]);
        index += 1;
      }
      validateYamlIndentation(block, file, blockStartLine);
      values[key] = parseYamlBlock(block, raw.startsWith(">"));
      continue;
    }
    if (raw.startsWith(">") || raw.startsWith("|")) {
      throw yamlError(file, lineNumber, `unsupported YAML block scalar indicator ${raw}`);
    }
    if (raw === "") {
      const block = [];
      index += 1;
      const blockStartLine = index + 2;
      while (index < lines.length && (lines[index].trim() === "" || /^[ \t]+/.test(lines[index]))) {
        block.push(lines[index]);
        index += 1;
      }
      values[key] = parseYamlIndentedBlock(block, file, blockStartLine);
      continue;
    }
    values[key] = parseYamlScalar(raw, file, lineNumber);
    index += 1;
  }
  return values;
}

function readFrontmatter(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular frontmatter source: ${file}`);
  const descriptor = openSync(file, "r");
  const chunks = [];
  let total = 0;
  try {
    while (total < 131072) {
      const buffer = Buffer.allocUnsafe(4096);
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
      const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      const normalized = text.replaceAll("\r\n", "\n");
      if (!normalized.startsWith("---\n")) throw new Error(`missing YAML frontmatter in ${file}`);
      const closing = /\n---[ \t]*(?:\n|$)/g;
      closing.lastIndex = 4;
      const match = closing.exec(normalized);
      if (match) return normalized.slice(4, match.index);
    }
  } finally {
    closeSync(descriptor);
  }
  throw new Error(`unterminated or oversized YAML frontmatter in ${file}`);
}

function parseYamlScalar(raw, file, lineNumber) {
  const value = raw.trim();
  if (value.startsWith("[")) {
    return parseYamlFlowSequence(value, file, lineNumber);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      throw yamlError(file, lineNumber, "unterminated or multiline double-quoted YAML scalar");
    }
    try { return JSON.parse(value); } catch {
      throw yamlError(file, lineNumber, `invalid double-quoted YAML scalar: ${value}`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      throw yamlError(file, lineNumber, "unterminated or multiline single-quoted YAML scalar");
    }
    const inner = value.slice(1, -1);
    for (let index = 0; index < inner.length; index += 1) {
      if (inner[index] !== "'") continue;
      if (inner[index + 1] !== "'") {
        throw yamlError(file, lineNumber, `invalid single-quoted YAML scalar: ${value}`);
      }
      index += 1;
    }
    return inner.replaceAll("''", "'");
  }
  assertNoYamlComment(value, file, lineNumber);
  if (/^[!&*{}?,\]\[%@`|>]/.test(value) || /^(?:-|:)(?:$|[ \t])/.test(value)) {
    throw yamlError(file, lineNumber, `unsupported YAML indicator in scalar: ${value}`);
  }
  if (/:[ \t]/.test(value)) {
    throw yamlError(file, lineNumber, `unsupported unquoted mapping indicator in scalar: ${value}`);
  }
  return value;
}

function parseYamlFlowSequence(value, file, lineNumber) {
  if (!value.endsWith("]")) {
    throw yamlError(file, lineNumber, "unterminated or multiline YAML flow sequence");
  }
  const inner = value.slice(1, -1);
  if (inner.trim() === "") return [];
  const items = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote === '"') {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      current += character;
      if (character !== "'") continue;
      if (inner[index + 1] === "'") {
        current += inner[index + 1];
        index += 1;
      } else quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      if (current.trim() !== "") {
        throw yamlError(file, lineNumber, "unsupported mixed quoted YAML flow scalar");
      }
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      if (current.trim() === "") throw yamlError(file, lineNumber, "empty YAML flow sequence item");
      items.push(current.trim());
      current = "";
      continue;
    }
    if ("[{}]".includes(character)) {
      throw yamlError(file, lineNumber, "nested YAML flow collections are unsupported");
    }
    if (character === "#" && (index === 0 || /\s/u.test(inner[index - 1]))) {
      throw yamlError(file, lineNumber, "YAML comments are unsupported");
    }
    current += character;
  }
  if (quote) throw yamlError(file, lineNumber, "unterminated or multiline quoted YAML flow scalar");
  if (current.trim() !== "") items.push(current.trim());
  return items.map((item) => parseYamlScalar(item, file, lineNumber));
}

function parseYamlIndentedBlock(lines, file, startLine) {
  validateYamlIndentation(lines, file, startLine);
  const content = lines.map((line, offset) => ({
    line,
    lineNumber: startLine + offset,
    indent: line.match(/^ */)[0].length,
    value: line.trim(),
  })).filter(({ value }) => value !== "");
  if (content.length === 0) return "";
  const baseIndent = Math.min(...content.map(({ indent }) => indent));
  if (content.every(({ indent, value }) => indent === baseIndent && /^-[ \t]+.+$/.test(value))) {
    return content.map(({ value, lineNumber }) => parseYamlScalar(
      /^-[ \t]+(.+)$/.exec(value)[1], file, lineNumber,
    ));
  }
  const isPlainContinuation = content.every(({ value }) =>
    !/^[A-Za-z][A-Za-z0-9_-]*:/.test(value) && !/^-[ \t]/.test(value));
  if (isPlainContinuation) {
    for (const { value, lineNumber } of content) {
      const parsed = parseYamlScalar(value, file, lineNumber);
      if (typeof parsed !== "string" || parsed !== value) {
        throw yamlError(file, lineNumber, "quoted and flow scalars cannot span implicit YAML lines");
      }
    }
    return parseYamlBlock(lines, true);
  }
  for (const { value, lineNumber } of content) {
    if (value.startsWith("#")) throw yamlError(file, lineNumber, "YAML comments are unsupported");
    const mapping = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(value);
    if (mapping) {
      const nested = (mapping[2] ?? "").trim();
      if (nested === ">" || nested === "|" || /^[>|]/.test(nested)) {
        throw yamlError(file, lineNumber, "nested YAML block scalars are unsupported");
      }
      if (nested) parseYamlScalar(nested, file, lineNumber);
      continue;
    }
    const item = /^-[ \t]+(.+)$/.exec(value);
    if (item) {
      parseYamlScalar(item[1], file, lineNumber);
      continue;
    }
    throw yamlError(file, lineNumber, "unsupported YAML mapping or sequence form");
  }
  return {};
}

function validateYamlIndentation(lines, file, startLine) {
  for (let offset = 0; offset < lines.length; offset += 1) {
    if (lines[offset].trim() === "") continue;
    const indentation = /^[ \t]*/.exec(lines[offset])[0];
    if (indentation.length === 0 || indentation.includes("\t")) {
      throw yamlError(file, startLine + offset, "YAML indentation must use spaces");
    }
  }
}

function assertNoYamlComment(value, file, lineNumber) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "#" && (index === 0 || /\s/u.test(value[index - 1]))) {
      throw yamlError(file, lineNumber, "YAML comments are unsupported");
    }
  }
}

function yamlError(file, lineNumber, message) {
  return new Error(`${file}:${lineNumber}: ${message}`);
}

function parseYamlBlock(lines, folded) {
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const indent = nonEmpty.length
    ? Math.min(...nonEmpty.map((line) => line.match(/^[ \t]*/)[0].length))
    : 0;
  const stripped = lines.map((line) => line.slice(Math.min(indent, line.length)).trimEnd());
  if (!folded) return stripped.join("\n").trim();
  const paragraphs = [];
  let current = [];
  for (const line of stripped) {
    if (line === "") {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
    } else current.push(line.trim());
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function findBundledSkill(sourceRoot, pluginName, skillName, indexes) {
  if (!sourceRoot || !existsSync(sourceRoot)) throw new Error(`missing managed Plugin source: ${sourceRoot}`);
  let skillsByName = indexes.get(sourceRoot);
  if (!skillsByName) {
    skillsByName = indexBundledSkills(sourceRoot);
    indexes.set(sourceRoot, skillsByName);
  }
  const candidates = skillsByName.get(skillName) ?? [];
  const exact = candidates.filter((candidate) => path.basename(path.dirname(path.dirname(path.dirname(candidate)))) === pluginName);
  const usable = exact.length ? exact : candidates;
  if (usable.length !== 1) {
    throw new Error(`expected exactly one ${skillName} Skill in Plugin ${pluginName}, found ${usable.length}`);
  }
  return usable[0];
}

function indexBundledSkills(sourceRoot) {
  const skillsByName = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        const skillDirectory = path.dirname(candidate);
        const skillsDirectory = path.dirname(skillDirectory);
        if (path.basename(skillsDirectory) === "skills") {
          const skillName = path.basename(skillDirectory);
          const candidates = skillsByName.get(skillName) ?? [];
          candidates.push(candidate);
          skillsByName.set(skillName, candidates);
        }
      }
    }
  };
  visit(sourceRoot);
  return skillsByName;
}

function validateTaxonomy(document) {
  if (!isPlainObject(document) || document.schemaVersion !== 1 || !Array.isArray(document.categories)) {
    throw new Error("taxonomy must have schemaVersion 1 and a categories array");
  }
  const categories = document.categories.map((category) => {
    if (!isPlainObject(category)) throw new Error("taxonomy category must be an object");
    requireString(category.id, "taxonomy category id");
    requireString(category.label, `taxonomy label for ${category.id}`);
    if (category.parent !== null && typeof category.parent !== "string") {
      throw new Error(`invalid taxonomy parent for ${category.id}`);
    }
    if (category.description !== undefined) {
      requireString(category.description, `taxonomy description for ${category.id}`);
    }
    if (category.aliases !== undefined && !Array.isArray(category.aliases)) {
      throw new Error(`taxonomy aliases for ${category.id} must be an array of strings`);
    }
    const aliases = (category.aliases ?? []).map((alias) => {
      requireString(alias, `taxonomy alias for ${category.id}`);
      return normalizeText(alias);
    });
    return {
      id: category.id,
      parent: category.parent,
      label: category.label,
      ...(category.description === undefined ? {} : { description: normalizeText(category.description) }),
      ...(category.aliases === undefined ? {} : { aliases: uniqueSorted(aliases) }),
    };
  });
  const byId = uniqueMap(categories, "id", "taxonomy category");
  const roots = categories.filter(({ parent }) => parent === null);
  if (roots.length !== 1) throw new Error(`taxonomy must have exactly one root, found ${roots.length}`);
  for (const category of categories) {
    if (category.parent !== null && !byId.has(category.parent)) {
      throw new Error(`taxonomy category ${category.id} has missing parent ${category.parent}`);
    }
    const seen = new Set();
    let cursor = category;
    while (cursor.parent !== null) {
      if (seen.has(cursor.id)) throw new Error(`taxonomy contains a cycle at ${cursor.id}`);
      seen.add(cursor.id);
      cursor = byId.get(cursor.parent);
    }
    if (cursor.id !== roots[0].id) throw new Error(`taxonomy category ${category.id} is disconnected`);
  }
  return categories.sort(compareBy("id"));
}

function readTsv(file, expectedHeader) {
  const lines = readFileSync(file, "utf8").replaceAll("\r\n", "\n").split("\n");
  const expected = `# ${expectedHeader.join("\t")}`;
  if (lines[0] !== expected) throw new Error(`invalid catalog header in ${file}`);
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index] || lines[index].startsWith("#")) continue;
    const values = lines[index].split("\t");
    if (values.length !== expectedHeader.length) {
      throw new Error(`${file}:${index + 1}: expected ${expectedHeader.length} columns, got ${values.length}`);
    }
    rows.push(Object.fromEntries(expectedHeader.map((key, offset) => [key, values[offset]])));
  }
  return rows;
}

function optionalRegularFile(root, relative) {
  if (root === null) return null;
  const file = path.join(root, ...relative.split('/'));
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Profile catalog must be a regular file: ${file}`);
  }
  return file;
}

function readOptionalTsv(root, relative, expectedHeader) {
  const file = optionalRegularFile(root, relative);
  return file === null ? [] : readTsv(file, expectedHeader);
}

function validatePluginRows(rows) {
  const providers = new Set();
  for (const row of rows) {
    const provider = `${row.plugin}@${row.marketplace}`;
    if (providers.has(provider)) throw new Error(`duplicate Plugin provider ${provider}`);
    providers.add(provider);
  }
  uniqueMap(rows, 'plugin', 'Plugin name');
  uniqueMap(rows, 'marketplace', 'Plugin marketplace');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
}

function readProviderCatalog(repo) {
  const file = path.join(repo, "catalog/providers.json");
  if (!existsSync(file)) return [];
  const value = readJson(file);
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.providers)) {
    throw new Error("catalog/providers.json must use schemaVersion 1 and declare providers");
  }
  const names = new Set();
  return value.providers.map((provider) => {
    if (!isPlainObject(provider) || typeof provider.name !== "string" || names.has(provider.name)
        || typeof provider.kind !== "string" || !isPlainObject(provider.hosts)
        || typeof provider.command !== "string" || !Array.isArray(provider.args)) {
      throw new Error("catalog/providers.json contains an invalid provider");
    }
    names.add(provider.name);
    return provider;
  });
}

function loadPluginRuntime(repo, home, pluginRows, validationOnly, profileManifest) {
  const catalogPlugins = uniqueSorted(pluginRows.map(({ plugin }) => plugin));
  const profilePlugins = profileManifest?.plugins.enabled ?? [];
  const disabledProfilePlugins = profileManifest?.plugins.disabled ?? [];
  const known = new Set(catalogPlugins);
  const unknownProfilePlugins = [...profilePlugins, ...disabledProfilePlugins]
    .filter((plugin) => !known.has(plugin));
  if (unknownProfilePlugins.length) {
    throw new Error(`pac-profile.json enables unknown Plugin(s): ${unknownProfilePlugins.join(", ")}`);
  }
  if (validationOnly) {
    return {
      mode: "catalog-validation",
      enabledHosts: ["claude", "codex"],
      enabledPlugins: catalogPlugins,
    };
  }

  const config = readJson(path.join(repo, "pac.json"));
  if (!isPlainObject(config) || config.schemaVersion !== 1 || !isPlainObject(config.hosts)) {
    throw new Error("pac.json must use schemaVersion 1 and declare hosts");
  }
  let enabledHosts = [];
  for (const host of ["codex", "claude"]) {
    if (!isPlainObject(config.hosts[host]) || typeof config.hosts[host].enabled !== "boolean") {
      throw new Error(`pac.json has an invalid ${host} host entry`);
    }
    if (config.hosts[host].enabled) enabledHosts.push(host);
  }
  let mode = "source-default";
  const machineFile = path.join(home, ".config/personal-agent-control/machine.json");
  const machineStat = lstatSync(machineFile, { throwIfNoEntry: false });
  if (machineStat) {
    if (!machineStat.isFile() || machineStat.isSymbolicLink()) {
      throw new Error(`machine profile must be a regular file: ${machineFile}`);
    }
    const machine = readJson(machineFile);
    if (!isPlainObject(machine) || machine.schemaVersion !== 1 || !Array.isArray(machine.enabledHosts)) {
      throw new Error("machine.json must use schemaVersion 1 and declare enabledHosts");
    }
    if (new Set(machine.enabledHosts).size !== machine.enabledHosts.length
        || machine.enabledHosts.some((host) => !["codex", "claude"].includes(host))) {
      throw new Error("machine.json enabledHosts must contain unique supported host IDs");
    }
    enabledHosts = machine.enabledHosts;
    mode = "machine-profile";
  }
  if (!isPlainObject(config.plugins) || !Array.isArray(config.plugins.enabled)) {
    throw new Error("pac.json plugins.enabled must be an array");
  }
  const disabled = new Set(disabledProfilePlugins);
  const enabledPlugins = uniqueSorted([...config.plugins.enabled.map((plugin) => {
    requireString(plugin, "pac.json enabled Plugin name");
    return plugin;
  }), ...profilePlugins]).filter((plugin) => !disabled.has(plugin));
  const unknown = enabledPlugins.filter((plugin) => !known.has(plugin));
  if (unknown.length) throw new Error(`pac.json enables unknown Plugin(s): ${unknown.join(", ")}`);
  return { mode, enabledHosts: uniqueSorted(enabledHosts), enabledPlugins };
}

function readProfileManifest(profile) {
  const file = path.join(profile, 'pac-profile.json');
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Profile manifest must be a regular file: ${file}`);
  }
  const manifest = readJson(file);
  if (!isPlainObject(manifest) || ![1, 2, 3].includes(manifest.schemaVersion)
      || !Array.isArray(manifest.skills)
      || !isPlainObject(manifest.plugins) || !Array.isArray(manifest.plugins.enabled)
      || (manifest.schemaVersion >= 2 && !Array.isArray(manifest.plugins.disabled))
      || (manifest.schemaVersion === 3
        && (!isPlainObject(manifest.providers) || !Array.isArray(manifest.providers.enabled)))) {
    throw new Error('pac-profile.json must use schemaVersion 1, 2, or 3 and declare its overlays');
  }
  const skillNames = new Set();
  const skills = manifest.skills.map((skill) => {
    if (!isPlainObject(skill)) throw new Error('pac-profile.json Skill entries must be objects');
    requireString(skill.name, 'pac-profile.json Skill name');
    const name = skill.name;
    if (skillNames.has(name)) throw new Error(`duplicate pac-profile.json Skill name: ${name}`);
    skillNames.add(name);
    const targets = parseTargets(skill.targets);
    if (targets.length === 0) throw new Error(`Profile Skill ${name} must declare at least one target`);
    return { name, targets };
  });
  const enabled = manifest.plugins.enabled.map((plugin) => {
    requireString(plugin, 'pac-profile.json enabled Plugin name');
    return plugin;
  });
  if (new Set(enabled).size !== enabled.length) {
    throw new Error('pac-profile.json plugins.enabled must contain unique Plugin names');
  }
  const disabled = (manifest.plugins.disabled ?? []).map((plugin) => {
    requireString(plugin, 'pac-profile.json disabled Plugin name');
    return plugin;
  });
  if (new Set(disabled).size !== disabled.length
      || disabled.some((plugin) => enabled.includes(plugin))) {
    throw new Error('pac-profile.json plugins.disabled must be unique and disjoint from enabled');
  }
  const providers = manifest.providers?.enabled ?? [];
  if (providers.some((provider) => typeof provider !== 'string')
      || new Set(providers).size !== providers.length) {
    throw new Error('pac-profile.json providers.enabled must contain unique provider names');
  }
  return { schemaVersion: manifest.schemaVersion, skills, plugins: { enabled, disabled }, providers: { enabled: providers } };
}

function readProfileIdentity(profile) {
  try {
    const output = execFileSync('git', [
      '-C', profile, 'rev-parse', '--show-toplevel', 'HEAD',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/u);
    if (output.length === 2
        && realpathSync(output[0]) === realpathSync(profile)
        && /^[0-9a-f]{40,64}$/u.test(output[1])) {
      return { type: 'git-commit', value: output[1] };
    }
  } catch {
    // A validated non-Git Profile remains identifiable by its real path and logical catalogs.
  }
  return { type: 'profile-root', value: realpathSync(profile) };
}

function normalizeRoots(repo, home, skillRoot, profile) {
  const resolvedHome = absoluteDirectory(home, "home");
  return {
    repo: absoluteDirectory(repo, "repository"),
    profile: profile === null ? null : absoluteDirectory(profile, "Profile repository"),
    home: resolvedHome,
    skillRoot: absoluteDirectory(skillRoot ?? defaultSkillRoot(resolvedHome), "Skill inventory root"),
  };
}

function absoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${resolved}`);
  return resolved;
}

function resolveProfileContextPath(profile, value, id) {
  requireString(value, `${id} path`);
  const relativePath = value.trim();
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`${id} path must be relative to the Profile repository`);
  }
  const segments = relativePath.split(/[\\/]+/u);
  if (segments.includes("..")) {
    throw new Error(`${id} path must not escape the Profile repository`);
  }
  const candidate = path.resolve(profile, ...segments);
  const suffix = path.relative(profile, candidate);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
    throw new Error(`${id} path must stay inside the Profile repository`);
  }
  if (![".md", ".markdown"].includes(path.extname(candidate).toLowerCase())) {
    throw new Error(`${id} path must reference a Markdown file`);
  }
  let cursor = profile;
  const parts = suffix.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const entry = lstatSync(cursor, { throwIfNoEntry: false });
    if (!entry) throw new Error(`${id} path does not exist: ${candidate}`);
    if (entry.isSymbolicLink()) throw new Error(`${id} path must not contain symlinks: ${cursor}`);
    const final = index === parts.length - 1;
    if ((final && !entry.isFile()) || (!final && !entry.isDirectory())) {
      throw new Error(`${id} path must reference a regular Markdown file: ${candidate}`);
    }
  }
  return realpathSync(candidate);
}

function parseTargets(value) {
  const values = Array.isArray(value) ? value : parseList(value);
  if (values.includes('*')) {
    if (values.length !== 1) throw new Error('wildcard host target must be declared alone');
    return uniqueSorted([...new Set(HOST_NAMES.values())]);
  }
  return uniqueSorted(values.map((target) => {
    const normalized = HOST_NAMES.get(String(target).trim().toLowerCase());
    if (!normalized) throw new Error(`unsupported host target: ${target}`);
    return normalized;
  }));
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value === undefined || value === null || value === "" || value === "-") return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function arrayField(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function validateDependencies(names, available, owner) {
  for (const name of names) {
    if (!available.has(name)) throw new Error(`${owner} requires undeclared tool ${name}`);
  }
}

function validateOverlayIdentity(metadata, role, kind, id, name) {
  if (!metadata) return;
  if (metadata.role !== undefined && metadata.role !== role) {
    throw new Error(`${id} overlay role must be ${role}`);
  }
  if (metadata.kind !== undefined && metadata.kind !== kind) {
    throw new Error(`${id} overlay kind must be ${kind}`);
  }
  if (metadata.name !== undefined && metadata.name !== name) {
    throw new Error(`${id} overlay name must be ${name}`);
  }
}

function declareId(ids, id) {
  if (ids.has(id)) throw new Error(`duplicate capability id ${id}`);
  ids.add(id);
}

function declareSkillName(names, name) {
  if (names.has(name)) {
    throw new Error(`duplicate Skill leaf name ${name}; v1 requires globally unique Skill leaf names`);
  }
  names.add(name);
}

function uniqueMap(rows, key, label) {
  const result = new Map();
  for (const row of rows) {
    if (result.has(row[key])) throw new Error(`duplicate ${label} ${row[key]}`);
    result.set(row[key], row);
  }
  return result;
}

function dedupeRelations(relations) {
  const unique = new Map();
  for (const relation of relations) unique.set(`${relation.from}\0${relation.type}\0${relation.to}`, relation);
  return [...unique.values()].sort(compareBy("from", "type", "to"));
}

function sortRecords(records) {
  return [...records].map((record) => ({ ...record })).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function normalizeOverlayRecord(record) {
  const normalized = { ...record };
  for (const field of ["memberships", "aliases", "triggers", "antiTriggers", "anti_triggers", "targets", "requires"]) {
    if (normalized[field] !== undefined) normalized[field] = uniqueSorted(arrayField(normalized[field]));
  }
  if (normalized.activation !== undefined) normalized.activation = stripMachinePaths(normalized.activation);
  if (typeof normalized.resource === "string"
      && (path.isAbsolute(normalized.resource) || /^[A-Za-z]:[\\/]/.test(normalized.resource))) {
    normalized.resource = "<absolute-path>";
  }
  return normalized;
}

function stripMachinePaths(value) {
  if (Array.isArray(value)) return value.map(stripMachinePaths);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, stripMachinePaths(child)]));
  }
  if (typeof value === "string" && (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value))) {
    return "<absolute-path>";
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function compareBy(...keys) {
  return (left, right) => {
    for (const key of keys) {
      const comparison = String(left[key]).localeCompare(String(right[key]));
      if (comparison !== 0) return comparison;
    }
    return 0;
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
