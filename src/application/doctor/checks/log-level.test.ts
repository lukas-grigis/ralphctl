import { describe, expect, it } from 'vitest';

import { logLevelCheck } from './log-level.ts';

describe('logLevelCheck', () => {
  it('reports info as the default when RALPHCTL_LOG_LEVEL is unset', async () => {
    const result = await logLevelCheck({});
    expect(result.status).toBe('pass');
    expect(result.name).toBe('Log level');
    expect(result.message).toContain('Current: info');
    expect(result.message).toContain('RALPHCTL_LOG_LEVEL=debug');
  });

  it('reports the resolved level when RALPHCTL_LOG_LEVEL is set', async () => {
    const result = await logLevelCheck({ RALPHCTL_LOG_LEVEL: 'debug' });
    expect(result.message).toContain('Current: debug');
  });

  it('falls back to info on an unknown level', async () => {
    const result = await logLevelCheck({ RALPHCTL_LOG_LEVEL: 'verbose' });
    expect(result.message).toContain('Current: info');
  });

  it('lowercases the input', async () => {
    const result = await logLevelCheck({ RALPHCTL_LOG_LEVEL: 'WARN' });
    expect(result.message).toContain('Current: warn');
  });
});
