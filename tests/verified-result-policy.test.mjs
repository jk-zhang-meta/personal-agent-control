import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(join(root, relative), 'utf8');

test('the global kernel keeps one critical path inline and completes on verified results', () => {
  const kernel = read('.rulesync/rules/00-kernel.md');
  const compact = kernel.replace(/\s+/gu, ' ');

  assert.match(kernel, /Keep one critical path inline/u);
  assert.match(kernel, /ordinary serial work does not require a graph/u);
  assert.doesNotMatch(kernel, /use the host's native graph for dependencies/u);
  assert.match(compact,
    /submission, a run handle, queued or running state, and successful process exit are intermediate evidence/iu);
  assert.match(compact,
    /authoritative terminal success is confirmed and exact-attempt result evidence exists and passes the declared oracle/iu);
  assert.match(kernel, /next action/u);
  assert.doesNotMatch(kernel, /next graph node/u);
});

test('graph routing distinguishes workflow durability from a long compute job', () => {
  const skill = read('payload/skills/graph-workflow/SKILL.md');
  const capability = read('catalog/capabilities.jsonl').split(/\r?\n/u)
    .filter(Boolean).map(JSON.parse)
    .find(({ id }) => id === 'skill:graph-workflow');

  assert.match(skill, /fan-out\/fan-in/u);
  assert.match(skill, /automatic workflow control/u);
  assert.match(skill, /single scheduler-owned long computation/u);
  assert.match(skill, /Compute-job durability is distinct from workflow-state durability/u);
  assert.doesNotMatch(skill, /persisted evaluation, monitoring/u);
  assert.ok(capability.triggers.includes('coordinate dependency fan-out and fan-in'));
  assert.ok(capability.antiTriggers.includes('single scheduler-owned long experiment'));
  assert.ok(!capability.aliases.includes('long-running workflow'));
});

test('a result-bearing graph node requires execution and exact-attempt result proof', () => {
  const contract = read('payload/skills/graph-workflow/references/GRAPH_CONTRACT.md');
  const compact = contract.replace(/\s+/gu, ' ');

  assert.match(contract, /A submission node may complete with a stable run reference/u);
  assert.match(contract, /A result-bearing node may not/u);
  assert.match(compact, /authoritative execution system reports terminal success/u);
  assert.match(compact, /exact-attempt result evidence/u);
  assert.match(compact, /result oracle passes/u);
  assert.match(contract, /A negative or neutral scientific finding is still a verified result/u);
});
