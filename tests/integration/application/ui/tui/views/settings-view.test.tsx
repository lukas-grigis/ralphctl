/**
 * Smoke tests for SettingsView. Renders the editable fields after the settings load, and the
 * status bar surfaces ↑/↓ + ↵/e hints.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SettingsView } from '@src/application/ui/tui/views/settings-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const fakeSettingsRepo: SettingsRepository = {
  path: '/tmp/test-settings.json',
  async exists() {
    return Result.ok(true);
  },
  async load() {
    return Result.ok(DEFAULT_SETTINGS);
  },
  async save() {
    return Result.ok(undefined);
  },
};

const deps: AppDeps = {
  settingsRepo: fakeSettingsRepo,
} as unknown as AppDeps;

describe('SettingsView', () => {
  it('renders every editable field after the load completes', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Provider');
    expect(frame).toContain('Refine');
    expect(frame).toContain('Plan');
    expect(frame).toContain('Implement');
    expect(frame).toContain('Max turns');
    expect(frame).toContain('Concurrency');
    expect(frame).toContain('Log level');
    result.unmount();
  });

  it('shows the storage paths card', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Storage paths');
    expect(frame).toContain('App root');
    result.unmount();
  });

  it('exposes ↑/↓ navigate and ↵/e edit hints', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('navigate');
    expect(frame).toContain('edit');
    result.unmount();
  });
});
