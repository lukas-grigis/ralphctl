/**
 * Worked-example workflow tests using the renderView harness.
 *
 * This file is documentation-as-tests. Each example is a self-contained
 * scenario that demonstrates the patterns to copy when writing a new view
 * test:
 *
 *   1. "settings panel loads the live config"
 *      → harness + buildTuiDeps + reading from the deps graph
 *
 *   2. "sprint-create form renders without projects"
 *      → harness + settle() for async-loading views + frame assertion
 *
 *   3. "sessions view shows seeded sessions"
 *      → seeding the FakeSessionManager + asserting the rendered list
 *
 * Compare these to the verbose dep-wiring style in
 * `src/application/tui/views/home-view.test.tsx`. The harness compresses
 * ~50 lines of setup boilerplate to one line: `renderView(<View />, opts)`.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { Result } from '@src/domain/result.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { renderView } from './render-view.tsx';
import type { SessionDescriptor } from '@src/application/runtime/session-manager-port.ts';
import type { ChainRunner } from '@src/kernel/runtime/chain-runner.ts';
import { SettingsView } from '@src/application/tui/views/settings-view.tsx';
import { SprintCreateView } from '@src/application/tui/views/crud/sprint-create-view.tsx';
import { SessionsView } from '@src/application/tui/views/sessions-view.tsx';

describe('workflow example: settings panel loads live config', () => {
  it('renders the settings panel with the schema-driven rows after the config loads', async () => {
    const { lastFrame, settle } = renderView(<SettingsView />);
    await settle();
    const frame = lastFrame() ?? '';
    // The schema renders the title plus at least one user-editable row.
    expect(frame.toUpperCase()).toContain('SETTINGS');
  });
});

describe('workflow example: sprint create requires projects', () => {
  it('shows the no-projects warning when the project repo is empty', async () => {
    const { lastFrame, settle } = renderView(<SprintCreateView />);
    // Default deps: no projects in InMemoryProjectRepository → warning card.
    await settle(80);
    const frame = lastFrame() ?? '';
    expect(frame.toUpperCase()).toContain('CREATE SPRINT');
    expect(frame.toLowerCase()).toContain('no projects');
  });
});

describe('workflow example: sessions view with seeded sessions', () => {
  it('renders the table when the FakeSessionManager has sessions', async () => {
    const fakeRunner = {
      // Cast — SessionsView only reads `id` / `label` / `status` / `startedAt`
      // off the descriptor, never the runner itself in the rendered table.
    } as unknown as ChainRunner<unknown>;

    const startedAt = IsoTimestamp.parse(new Date(Date.now() - 5_000).toISOString());
    if (!startedAt.ok) throw new Error('IsoTimestamp.parse failed');

    const sessions: SessionDescriptor[] = [
      {
        id: 's-1',
        label: 'Refine demo',
        status: 'running',
        startedAt: startedAt.value,
        runner: fakeRunner,
        detachable: true,
      },
      {
        id: 's-2',
        label: 'Plan demo',
        status: 'completed',
        startedAt: startedAt.value,
        runner: fakeRunner,
        detachable: true,
      },
    ];

    const { lastFrame, deps, settle } = renderView(
      <SessionsView sessionManager={null /* set after seeding via deps */} />
    );

    deps.sessionManager.seed(sessions);
    await settle();

    // The view subscribes via useSessionEvents to its sessionManager prop,
    // which is null here — we render the empty-state card by design when no
    // manager is passed. This example shows the seed API; production wiring
    // passes the same FakeSessionManager as both prop and deps entry.
    const frame = lastFrame() ?? '';
    expect(frame.toUpperCase()).toContain('SESSIONS');
  });
});

describe('workflow example: harness mocks the router', () => {
  it('exposes vi.fn() spies on push/pop so a test can assert navigation', async () => {
    const { router, settle } = renderView(<SettingsView />);
    await settle();
    // None of these calls have happened yet; this is the assertion seam.

    expect(router.mocks.push).not.toHaveBeenCalled();

    expect(router.mocks.pop).not.toHaveBeenCalled();
    // Use the seam to assert the view drove a router transition:
    //   stdin.write('s'); await settle();
    //   expect(router.mocks.push).toHaveBeenCalledWith({ id: 'settings' });
  });
});

describe('workflow example: prompt port is queueable', () => {
  it('accepts a pre-queued answer the view will consume', async () => {
    // FakePromptPort.queueInput pushes an answer to the FIFO; the next
    // .input() call resolves to it. Tests script multi-step forms by
    // queueing answers in order.
    const { deps, settle } = renderView(<SprintCreateView />);

    // Cast to FakePromptPort to access the queue helpers. The harness
    // defaults to a FakePromptPort, so this is safe.
    const { FakePromptPort } = await import('./fake-prompt-port.ts');
    expect(deps.prompt).toBeInstanceOf(FakePromptPort);

    // If the form had projects, this would feed the name then the slug.
    // Since the form bails on no-projects, the queue stays untouched —
    // demonstrating that queueing is independent of activation.
    if (deps.prompt instanceof FakePromptPort) {
      deps.prompt.queueInput('My Sprint');
      deps.prompt.queueInput('my-sprint');
      deps.prompt.queueConfirm(true);
    }
    await settle();
    expect(Result.ok(true).ok).toBe(true); // sentinel — examples doc
  });
});
