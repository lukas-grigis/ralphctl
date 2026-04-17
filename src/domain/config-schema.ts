/**
 * Configuration schema definition — single source of truth for all config keys.
 *
 * This schema drives:
 * - CLI `config show` — displays all keys with defaults and descriptions
 * - CLI `config set key value` — validates against schema rules
 * - Settings panel — renders form fields based on schema
 * - Doctor checks — validates config against schema
 * - Defaults resolution — when config key missing, use schema.default
 *
 * Adding a new config option requires ONE schema entry here.
 */

/**
 * Validation function type — returns true if value is valid for this key.
 * Used by validateConfigValue() in integration layer.
 */
export type ConfigValidation = (val: unknown) => boolean;

/**
 * Configuration scope — indicates when/where this config key applies.
 * - 'global': Used across all operations, not sprint-specific
 * - 'user': User preference, preserved across sprints
 * - 'sprint': Sprint-specific, can change between sprints
 */
export type ConfigScope = 'global' | 'user' | 'sprint';

/**
 * Single entry in the config schema definition.
 * Exhaustive type information for validation, defaults, and UI rendering.
 */
export interface ConfigSchemaEntry {
  key: string; // Config key name (must match object key below)
  label: string; // Human-friendly title for UI surfaces
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum';
  enum?: string[] | number[] | boolean[]; // For enum type only
  min?: number; // For integer/number types only
  max?: number; // For integer/number types only
  default: unknown;
  description: string;
  validation: ConfigValidation; // Function to validate values
  scope: ConfigScope;
}

/**
 * Complete config schema definition — all configuration options.
 * as const ensures type inference: ConfigSchemaKeys is a literal union.
 */
export const ConfigSchemaDefinition = {
  currentSprint: {
    key: 'currentSprint',
    label: 'Current Sprint',
    type: 'string',
    default: null,
    description: 'Currently active sprint ID (set by `sprint start`, cleared on `sprint close`)',
    validation: (val) => val === null || (typeof val === 'string' && val.length > 0),
    scope: 'global',
  },

  aiProvider: {
    key: 'aiProvider',
    label: 'AI Provider',
    type: 'enum',
    enum: ['claude', 'copilot'],
    default: null,
    description: 'AI provider for task execution (Claude Code or GitHub Copilot CLI)',
    validation: (val) => val === null || (typeof val === 'string' && ['claude', 'copilot'].includes(val)),
    scope: 'global',
  },

  evaluationIterations: {
    key: 'evaluationIterations',
    label: 'Evaluation Iterations',
    type: 'integer',
    min: 0,
    max: 10,
    default: 1,
    description:
      'Number of fix-attempt iterations after initial evaluation; 0 = disabled. Higher values allow more refinement rounds.',
    validation: (val) => typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 10,
    scope: 'sprint',
  },

  // Phase 2+ additions can be added here as single schema entries
  // maxTaskTurns: { ... },
  // checkScriptTimeout: { ... },
} as const satisfies Record<string, ConfigSchemaEntry>;

/**
 * Extract config schema keys as a literal union type.
 * Type-safe: only keys that exist in ConfigSchemaDefinition are valid.
 *
 * Usage: ConfigSchemaKeys = 'currentSprint' | 'aiProvider' | 'evaluationIterations'
 */
export type ConfigSchemaKeys = keyof typeof ConfigSchemaDefinition;

/**
 * Config value type — union of all possible config value types.
 * Validated against schema rules in integration layer.
 */
export type ConfigValue = string | number | boolean | null;

/**
 * Get a schema entry by key.
 * Type-safe: returns the schema entry if key is valid.
 *
 * Usage:
 *   getSchemaEntry('aiProvider') // returns ConfigSchemaEntry for aiProvider
 *   getSchemaEntry('invalidKey') // compile error: not a valid key
 */
export function getSchemaEntry(key: ConfigSchemaKeys): ConfigSchemaEntry {
  return ConfigSchemaDefinition[key];
}

/**
 * Get all schema entries as an array.
 * Useful for CLI commands that iterate over all config keys.
 *
 * Usage:
 *   getAllSchemaEntries().forEach(entry => console.log(entry.key, entry.default));
 */
export function getAllSchemaEntries(): ConfigSchemaEntry[] {
  return Object.values(ConfigSchemaDefinition);
}

/**
 * Get default value for a config key.
 * Type-safe: returns the correct type for the key.
 *
 * Usage:
 *   getDefaultValue('evaluationIterations') // returns 1 (number)
 *   getDefaultValue('aiProvider') // returns null (string | null)
 */
export function getDefaultValue(key: ConfigSchemaKeys): unknown {
  return ConfigSchemaDefinition[key].default;
}
