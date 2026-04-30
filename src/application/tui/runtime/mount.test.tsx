import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mountInkApp } from './mount.tsx';

describe('mountInkApp', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure non-interactive environment for tests
    process.env['CI'] = '1';
  });

  afterEach(() => {
    // Restore env
    Object.assign(process.env, originalEnv);
    delete process.env['CI'];
  });

  it('returns fallback:true in CI environment', async () => {
    const result = await mountInkApp({ initialView: 'home' });
    expect(result.fallback).toBe(true);
  });

  it('returns fallback:true when RALPHCTL_NO_TUI is set', async () => {
    delete process.env['CI'];
    process.env['RALPHCTL_NO_TUI'] = '1';
    const result = await mountInkApp();
    expect(result.fallback).toBe(true);
    delete process.env['RALPHCTL_NO_TUI'];
  });

  it('returns fallback:true when RALPHCTL_JSON is set', async () => {
    delete process.env['CI'];
    process.env['RALPHCTL_JSON'] = '1';
    const result = await mountInkApp();
    expect(result.fallback).toBe(true);
    delete process.env['RALPHCTL_JSON'];
  });

  it('returns fallback:true when stdout is not a TTY', async () => {
    delete process.env['CI'];
    // In test environments stdout.isTTY is undefined/false
    const result = await mountInkApp();
    expect(result.fallback).toBe(true);
  });
});
