/**
 * Config schema provider — utilities for working with the config schema.
 *
 * This adapter provides functions used by:
 * - CLI `config show` command (iterate schema, display all keys)
 * - CLI `config set key value` command (validate against schema)
 * - Settings panel (render form fields from schema)
 * - Doctor health checks (validate config against schema rules)
 * - Defaults resolution (get default value for missing keys)
 */

import { Result } from 'typescript-result';
import type { DomainResult } from '@src/domain/types.ts';
import {
  ConfigSchemaDefinition,
  getSchemaEntry,
  getAllSchemaEntries,
  getDefaultValue,
  type ConfigSchemaKeys,
  type ConfigValue,
} from '@src/domain/config-schema.ts';
import { ValidationError } from '@src/domain/errors.ts';

/**
 * Get the complete config schema definition.
 * Used by CLI and settings panel to iterate all keys.
 */
export function getConfigSchema() {
  return ConfigSchemaDefinition;
}

/**
 * Get all schema entries as an array.
 * Useful for commands that iterate over all config keys.
 */
export function getAllConfigSchemaEntries() {
  return getAllSchemaEntries();
}

/**
 * Get a single schema entry by key.
 * Type-safe: returns entry if key is valid.
 */
function getConfigSchemaEntry(key: ConfigSchemaKeys) {
  return getSchemaEntry(key);
}

/**
 * Get default value for a config key.
 * Used when config key is missing from config.json.
 */
export function getConfigDefaultValue(key: ConfigSchemaKeys): ConfigValue {
  return getDefaultValue(key) as ConfigValue;
}

/**
 * Validate a config value against schema rules.
 * Returns Result<ConfigValue, ValidationError>.
 *
 * Used by `config set key value` to validate before persisting.
 * Also used by doctor health checks.
 */
export function validateConfigValue(key: string, value: unknown): DomainResult<ConfigValue> {
  // Check if key is valid
  if (!(key in ConfigSchemaDefinition)) {
    return Result.error(new ValidationError(`Unknown config key: ${key}`, key));
  }

  const schemaKey = key as ConfigSchemaKeys;
  const entry = getConfigSchemaEntry(schemaKey);

  // Run validation function from schema
  if (!entry.validation(value)) {
    let errorMsg = `Invalid value for ${key}`;
    if (entry.type === 'enum' && entry.enum) {
      errorMsg += `: must be one of ${entry.enum.join(', ')}`;
    } else if (entry.type === 'integer' || entry.type === 'number') {
      const constraints = [];
      if (entry.min !== undefined) constraints.push(`min: ${String(entry.min)}`);
      if (entry.max !== undefined) constraints.push(`max: ${String(entry.max)}`);
      if (constraints.length > 0) errorMsg += ` (${constraints.join(', ')})`;
    }

    return Result.error(new ValidationError(errorMsg, key));
  }

  return Result.ok(value as ConfigValue);
}

/**
 * Parse and validate a config value from a string (CLI input).
 * Coerces string to the correct type based on schema.
 */
export function parseConfigValue(key: string, stringValue: string): DomainResult<ConfigValue> {
  if (!(key in ConfigSchemaDefinition)) {
    return Result.error(new ValidationError(`Unknown config key: ${key}`, key));
  }

  const schemaKey = key as ConfigSchemaKeys;
  const entry = getConfigSchemaEntry(schemaKey);

  let parsedValue: unknown;

  try {
    switch (entry.type) {
      case 'string':
        parsedValue = stringValue === 'null' ? null : stringValue;
        break;
      case 'integer':
        parsedValue = stringValue === 'null' ? null : Number.parseInt(stringValue, 10);
        if (Number.isNaN(parsedValue)) {
          return Result.error(new ValidationError(`Expected integer for ${key}, got ${stringValue}`, key));
        }
        break;
      case 'number':
        parsedValue = stringValue === 'null' ? null : Number.parseFloat(stringValue);
        if (Number.isNaN(parsedValue)) {
          return Result.error(new ValidationError(`Expected number for ${key}, got ${stringValue}`, key));
        }
        break;
      case 'boolean':
        if (stringValue.toLowerCase() === 'true' || stringValue === '1') {
          parsedValue = true;
        } else if (stringValue.toLowerCase() === 'false' || stringValue === '0') {
          parsedValue = false;
        } else if (stringValue === 'null') {
          parsedValue = null;
        } else {
          return Result.error(new ValidationError(`Expected boolean for ${key}, got ${stringValue}`, key));
        }
        break;
      case 'enum':
        if (stringValue === 'null') {
          parsedValue = null;
        } else {
          parsedValue = stringValue;
        }
        break;
    }
  } catch (err) {
    return Result.error(
      new ValidationError(`Failed to parse ${key}: ${err instanceof Error ? err.message : String(err)}`, key)
    );
  }

  return validateConfigValue(key, parsedValue);
}

/**
 * Get a user-friendly description for a config key.
 * Used by CLI help text and settings panel tooltips.
 */
export function getConfigKeyDescription(key: ConfigSchemaKeys): string {
  return getConfigSchemaEntry(key).description;
}

/**
 * Get the scope of a config key.
 * Useful for filtering config display by scope (global vs user vs sprint).
 */
export function getConfigKeyScope(key: ConfigSchemaKeys): string {
  return getConfigSchemaEntry(key).scope;
}
