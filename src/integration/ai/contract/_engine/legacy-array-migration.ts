// v0 → v1: a bare signal array is wrapped into the { schemaVersion, signals } envelope.
export const wrapLegacySignalArray = (raw: unknown): unknown =>
  Array.isArray(raw) ? { schemaVersion: 1, signals: raw } : raw;
