import { describe, expect, it } from 'vitest';
import { verifyGatesSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-gates/schema.ts';

const TS = '2026-05-23T10:00:00.000Z';

describe('verifyGatesSignalSchema', () => {
  it('accepts a valid multi-gate payload', () => {
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [
        { pathPrefix: 'services/api/', command: 'api-check' },
        { pathPrefix: 'services/web/', command: 'web-check' },
      ],
      timestamp: TS,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the empty-string catch-all prefix', () => {
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [{ pathPrefix: '', command: 'e2e-suite' }],
      timestamp: TS,
    });
    expect(result.success).toBe(true);
  });

  it('treats timeoutMs as optional', () => {
    const withTimeout = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [{ pathPrefix: 'api/', command: 'api-check', timeoutMs: 60_000 }],
      timestamp: TS,
    });
    expect(withTimeout.success).toBe(true);

    const withoutTimeout = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [{ pathPrefix: 'api/', command: 'api-check' }],
      timestamp: TS,
    });
    expect(withoutTimeout.success).toBe(true);
  });

  it('rejects an empty gates array — single-module repos omit the signal entirely', () => {
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('drops the whole payload when a gate is missing command', () => {
    // Field-name parity guard: a gate without the exact `command` key fails the parse rather
    // than silently validating with an undefined command.
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [{ pathPrefix: 'api/' }],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('drops the whole payload when a gate is missing pathPrefix', () => {
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [{ command: 'api-check' }],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string command', () => {
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [{ pathPrefix: 'api/', command: 42 }],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-number timeoutMs', () => {
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-gates',
      gates: [{ pathPrefix: 'api/', command: 'api-check', timeoutMs: 'soon' }],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects the wrong type discriminator', () => {
    const result = verifyGatesSignalSchema.safeParse({
      type: 'verify-script',
      gates: [{ pathPrefix: 'api/', command: 'api-check' }],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });
});
