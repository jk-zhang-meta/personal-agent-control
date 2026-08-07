const MODES = new Set(['auto', 'native', 'durable']);

export const HARD_DURABILITY_REQUIREMENTS = Object.freeze([
  'survive-process-restart',
  'external-wait',
  'scheduled',
  'shared-run-state',
  'checkpoint-replay',
]);

const HARD = new Set(HARD_DURABILITY_REQUIREMENTS);
const INPUT_FIELDS = new Set(['mode', 'requirements', 'availability']);

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

export function selectExecutionSurface(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('EXECUTION_POLICY_INVALID', 'Execution policy input is invalid.');
  }
  const unknownFields = Object.keys(input).filter((field) => !INPUT_FIELDS.has(field));
  if (unknownFields.length) {
    fail('EXECUTION_POLICY_INVALID', 'Execution policy input contains unknown fields.', {
      unknownFields: unknownFields.sort(),
    });
  }
  const {
    mode = 'auto',
    requirements = [],
    availability = { native: true, durable: false },
  } = input;
  if (!MODES.has(mode) || !Array.isArray(requirements)
      || requirements.some((item) => typeof item !== 'string' || !HARD.has(item))
      || !availability || typeof availability !== 'object'
      || typeof availability.native !== 'boolean'
      || typeof availability.durable !== 'boolean') {
    fail('EXECUTION_POLICY_INVALID', 'Execution policy input is invalid.');
  }

  const hardRequirements = [...new Set(requirements)].sort();
  if (mode === 'native' && hardRequirements.length) {
    fail(
      'DURABILITY_CONFLICT',
      'Native execution cannot satisfy the declared durability requirements.',
      { hardRequirements },
    );
  }

  const durableRequired = mode === 'durable' || hardRequirements.length > 0;
  if (durableRequired) {
    if (!availability.durable) {
      fail(
        'DURABLE_SURFACE_UNAVAILABLE',
        'Durable execution is required but no approved durable surface is ready.',
        { hardRequirements },
      );
    }
    return {
      surface: 'durable',
      reason: mode === 'durable' ? 'explicit-durable' : 'hard-durability-requirement',
      hardRequirements,
    };
  }

  if (!availability.native) {
    fail('NATIVE_SURFACE_UNAVAILABLE', 'Native execution is selected but the native surface is unavailable.');
  }
  return {
    surface: 'native',
    reason: mode === 'native' ? 'explicit-native' : 'native-default',
    hardRequirements,
  };
}
