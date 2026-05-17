/**
 * Smoke tests for DoctorView. Stubs the four port boundaries the doctor use-case touches
 * (project repo, sprint repo, sprint-execution repo, settings repo) plus the two shell
 * adapters (commandExists, runCommand). The view runs probes on mount; we wait for the load
 * and assert on the rendered summary + at least one group section.
 *
 * NOTE: doctor-view.tsx imports `commandExists` and `runCommand` directly (not via deps), so
 * we can't substitute them here without rewriting the view. Instead, the test relies on the
 * real platform implementations against repository stubs that always succeed — the storage
 * roots are pointed at process.cwd() in the harness, which is readable + writable in tests.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DoctorView } from '@src/application/ui/tui/views/doctor-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const deps: AppDeps = {
  projectRepo: {
    async list() {
      return Result.ok([]);
    },
  } as unknown as ProjectRepository,
  sprintRepo: {
    async list() {
      return Result.ok([]);
    },
  } as unknown as SprintRepository,
  sprintExecutionRepo: {
    async findById(id: unknown) {
      return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id), message: 'no executions' }));
    },
  } as unknown as SprintExecutionRepository,
  settingsRepo: {
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
  } as unknown as SettingsRepository,
} as unknown as AppDeps;

describe('DoctorView', () => {
  it('renders the grouped probe report with a summary header', async () => {
    const { result } = renderView(<DoctorView />, { deps, initial: { id: 'doctor' } });
    // Probes shell out to git / gh / glab; give them time to settle.
    await tick(6000);
    const frame = result.lastFrame() ?? '';
    // Summary header is one of "passed / warnings / failures".
    expect(frame).toMatch(/passed/);
    // At least the storage section renders.
    expect(frame).toContain('Storage');
    // The reload hint is visible.
    expect(frame).toContain('r reload');
    result.unmount();
  });

  it('publishes the r reload hint', async () => {
    const { result } = renderView(<DoctorView />, { deps, initial: { id: 'doctor' } });
    await tick(6000);
    expect(result.lastFrame() ?? '').toContain('reload');
    result.unmount();
  });
});
