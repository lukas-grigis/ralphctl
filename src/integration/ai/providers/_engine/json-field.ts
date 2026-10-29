/**
 * JSON-narrowing helpers shared by the provider stream parsers. Each takes several candidate key
 * names because CLIs rename keys across versions; the first match wins. An `undefined` object
 * yields `undefined`, so nested reads chain without guards.
 */

type JsonObject = Record<string, unknown> | undefined;

/** Narrow an unknown to a plain object (non-null). */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const firstField = <T>(obj: JsonObject, names: readonly string[], guard: (v: unknown) => v is T): T | undefined => {
  if (obj === undefined) return undefined;
  for (const name of names) {
    const v = obj[name];
    if (guard(v)) return v;
  }
  return undefined;
};

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const stringField = (obj: JsonObject, ...names: readonly string[]): string | undefined =>
  firstField(obj, names, isString);

export const numberField = (obj: JsonObject, ...names: readonly string[]): number | undefined =>
  firstField(obj, names, isFiniteNumber);

export const recordField = (obj: JsonObject, ...names: readonly string[]): Record<string, unknown> | undefined =>
  firstField(obj, names, isRecord);
