/**
 * Real-size (renderAtSize) fences for the content-first viewport: the wordmark never eats a
 * short terminal, the Home cursor stays on screen, Doctor leads with what needs action, and the
 * Settings body card spans the content width.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { Result } from '@src/domain/result.ts';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';
import { FlowsAliasView } from '@src/application/ui/tui/views/flows-view.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { DoctorView } from '@src/application/ui/tui/views/doctor-view.tsx';
import { SettingsView } from '@src/application/ui/tui/views/settings-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { DoctorReport, ProbeGroup, ProbeResult } from '@src/application/flows/doctor/ctx.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { DOWN, ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, stripAnsi } from '@tests/integration/application/ui/tui/_harness.tsx';

const reportRef = vi.hoisted(() => ({ current: undefined as DoctorReport | undefined }));

vi.mock('@src/application/flows/doctor/flow.ts', () => ({
  createDoctorFlow: () => ({
    execute: async () => Result.ok({ ctx: { output: reportRef.current } }),
  }),
}));

const PROJECT_ID = 'project-fixture-id' as unknown as ProjectId;
const SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;
const WORDMARK_ROW = '██████╗';

const project = { id: PROJECT_ID, slug: 'fixture', displayName: 'Fixture', repositories: [] } as unknown as Project;
const sprint = {
  id: SPRINT_ID,
  projectId: PROJECT_ID,
  slug: 'fixture-sprint',
  name: 'Fixture Sprint',
  status: 'draft',
  tickets: [],
} as unknown as Sprint;

const deps = {
  eventBus: createInMemoryEventBus(),
  projectRepo: {
    async list() {
      return Result.ok([project]);
    },
    async findById() {
      return Result.ok(project);
    },
  } as unknown as ProjectRepository,
  sprintRepo: {
    async list() {
      return Result.ok([sprint]);
    },
    async findById() {
      return Result.ok(sprint);
    },
  } as unknown as SprintRepository,
  taskRepo: {
    async findBySprintId() {
      return Result.ok([]);
    },
  } as unknown as TaskRepository,
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
  },
} as unknown as AppDeps;

/** Pin the root to the terminal height, as the real App does, so ScrollRegion actually clips. */
const Framed = ({
  rows,
  children,
}: {
  readonly rows: number;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <Box flexDirection="column" height={rows}>
    {children}
  </Box>
);

const renderFramed = (
  node: React.ReactNode,
  opts: Omit<Parameters<typeof renderView>[1], 'size'>,
  size: { readonly columns: number; readonly rows: number }
): ReturnType<typeof renderView> => renderView(<Framed rows={size.rows}>{node}</Framed>, { ...opts, size });

const selection = {
  projectId: PROJECT_ID,
  projectLabel: 'Fixture',
  sprintId: SPRINT_ID,
  sprintLabel: 'Fixture Sprint',
};

describe.each([
  { columns: 100, rows: 30 },
  { columns: 120, rows: 36 },
])('wordmark suppressed at $columns x $rows', ({ columns, rows }) => {
  it('Work shows its agenda, not the wordmark', async () => {
    const { result } = renderFramed(
      <HomeView />,
      {
        deps,
        initial: { id: 'home' },
        selection,
      },
      { columns, rows }
    );
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('FLOWS'));
    expect(result.lastFrame() ?? '').not.toContain(WORDMARK_ROW);
  });

  it('Flows shows at least one flow row', async () => {
    const { result } = renderFramed(
      <FlowsAliasView />,
      {
        deps,
        initial: { id: 'flows' },
        selection,
      },
      { columns, rows }
    );
    await waitForPredicate(() => /Refine|Add ticket|Remove ticket/.test(result.lastFrame() ?? ''));
    expect(result.lastFrame() ?? '').not.toContain(WORDMARK_ROW);
  });
});

describe('Home cursor at 80x24', () => {
  it('keeps the focused row on screen across twelve ↓ presses', async () => {
    const { result } = renderFramed(
      <HomeView />,
      {
        deps,
        initial: { id: 'home' },
        selection,
      },
      { columns: 80, rows: 24 }
    );
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('▸'));
    for (let i = 0; i < 12; i += 1) {
      result.stdin.write(DOWN);
      await tick(40);
      expect(result.lastFrame() ?? '', `after press ${String(i + 1)}`).toContain('▸');
    }
  });
});

const probe = (id: string, status: ProbeResult['status'], group: ProbeGroup): ProbeResult => ({
  id,
  label: `probe ${id}`,
  status,
  group,
});

describe('DoctorView at 120x36', () => {
  it('shows warn rows first and collapses passes into one expandable line', async () => {
    reportRef.current = {
      probes: [
        ...Array.from({ length: 20 }, (_, i) => probe(`pass-${String(i)}`, 'pass', i < 10 ? 'storage' : 'runtime')),
        probe('warn-a', 'warn', 'ai'),
        probe('warn-b', 'warn', 'ai'),
      ],
      allPassed: false,
      hasFailures: false,
    };
    const { result } = renderFramed(
      <DoctorView />,
      {
        deps,
        initial: { id: 'doctor' },
      },
      { columns: 120, rows: 36 }
    );
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('probe warn-a'));
    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('probe warn-b');
    expect(frame).toContain('20 passed');
    expect(frame).not.toContain('probe pass-0');
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('probe pass-0'));
  });
});

describe.each([
  { columns: 80, rows: 24 },
  { columns: 160, rows: 45 },
])('SettingsView body card at $columns x $rows', ({ columns, rows }) => {
  it('spans the content width', async () => {
    const { result } = renderFramed(
      <SettingsView />,
      {
        deps,
        initial: { id: 'settings' },
      },
      { columns, rows }
    );
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('▸ Mixed'));
    const lines = stripAnsi(result.lastFrame() ?? '').split('\n');
    const top = lines.find((l) => /^\s*╭─+╮\s*$/.test(l));
    expect(top).toBeDefined();
    const start = (top ?? '').indexOf('╭');
    const end = (top ?? '').lastIndexOf('╮');
    expect(end - start + 1).toBe(columns - 2 * spacing.indent);
  });
});
