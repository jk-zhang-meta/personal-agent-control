import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectExecutionSurface,
} from '../payload/skills/graph-workflow/scripts/select-execution-surface.mjs';

const ready = { native: true, durable: true };

test('ordinary work uses the native surface', () => {
  assert.deepEqual(selectExecutionSurface({ availability: ready }), {
    surface: 'native', reason: 'native-default', hardRequirements: [],
  });
});

test('a hard durability requirement uses a ready durable surface', () => {
  assert.deepEqual(selectExecutionSurface({
    requirements: ['workflow-survive-process-restart'], availability: ready,
  }), {
    surface: 'durable',
    reason: 'hard-durability-requirement',
    hardRequirements: ['workflow-survive-process-restart'],
  });
});

test('a hard durability requirement fails closed when durable is unavailable', () => {
  assert.throws(() => selectExecutionSurface({
    requirements: ['automatic-post-event-continuation'],
    availability: { native: true, durable: false },
  }), (error) => error.code === 'DURABLE_SURFACE_UNAVAILABLE');
});

test('explicit native conflicts with a hard durability requirement', () => {
  assert.throws(() => selectExecutionSurface({
    mode: 'native', requirements: ['checkpoint-replay'], availability: ready,
  }), (error) => error.code === 'DURABILITY_CONFLICT');
});

test('explicit durable still requires a ready approved provider', () => {
  assert.throws(() => selectExecutionSurface({
    mode: 'durable', availability: { native: true, durable: false },
  }), (error) => error.code === 'DURABLE_SURFACE_UNAVAILABLE');
});

test('complexity alone is outside the hard-requirement contract', () => {
  assert.equal(selectExecutionSurface({
    requirements: [],
    availability: ready,
  }).surface, 'native');
});

test('one scheduler-owned long experiment remains native without a workflow durability need', () => {
  assert.deepEqual(selectExecutionSurface({
    requirements: [], availability: ready,
  }), {
    surface: 'native', reason: 'native-default', hardRequirements: [],
  });
});

test('an unscoped external wait is rejected instead of selecting a durable graph', () => {
  assert.throws(() => selectExecutionSurface({
    requirements: ['external-wait'], availability: ready,
  }), (error) => error.code === 'EXECUTION_POLICY_INVALID');
});

test('unknown fields fail closed instead of hiding a misspelled requirement', () => {
  assert.throws(() => selectExecutionSurface({
    requirments: ['workflow-survive-process-restart'], availability: ready,
  }), (error) => error.code === 'EXECUTION_POLICY_INVALID'
    && error.details.unknownFields[0] === 'requirments');
});

test('native unavailability fails instead of pretending execution started', () => {
  assert.throws(() => selectExecutionSurface({
    availability: { native: false, durable: true },
  }), (error) => error.code === 'NATIVE_SURFACE_UNAVAILABLE');
});
