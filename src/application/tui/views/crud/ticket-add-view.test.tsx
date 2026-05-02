import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TicketAddView } from './ticket-add-view.tsx';
import { RouterProvider } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider } from '@src/application/tui/views/view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { Result } from 'typescript-result';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';

function makeRouter() {
  return {
    current: { id: 'ticket-add' as const },
    stack: [{ id: 'home' as const }, { id: 'ticket-add' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

function makeSlug(s: string) {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function asProjectName(s: string) {
  const r = ProjectName.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeSprint() {
  const r = Sprint.create({
    name: 'Test Sprint',
    slug: makeSlug('test'),
    now: IsoTimestamp.now(),
    projectName: asProjectName('api-service'),
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

let fakePrompt: FakePromptPort;
const testSprint = makeSprint();

beforeEach(() => {
  fakePrompt = new FakePromptPort();
  setSharedDeps({
    configStore: {
      load: vi.fn(() =>
        Promise.resolve(
          Result.ok({
            ...CONFIG_DEFAULTS,
            currentSprint: testSprint.id,
          })
        )
      ),
      save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
    },
    sprintRepo: {
      findById: vi.fn(() => Promise.resolve(Result.ok(testSprint))),
      save: vi.fn((sprint: Sprint) => Promise.resolve(Result.ok(sprint))),
      list: vi.fn(),
      remove: vi.fn(),
    },
    external: {
      fetchIssue: vi.fn(() => Promise.resolve(Result.ok(null))),
    },
    prompt: fakePrompt,
  } as unknown as SharedDeps);
});

afterEach(() => {
  resetSharedDeps();
});

describe('TicketAddView', () => {
  it('renders without crashing', async () => {
    fakePrompt.queueInput(''); // no link → no prefill
    fakePrompt.queueInput('My Ticket');
    fakePrompt.queueEditor(null); // skip description
    fakePrompt.queueConfirm(false); // "Add another?" → No

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows ADD TICKET header', async () => {
    // Only 20ms wait — header check fires before prompts complete, so no
    // need to pre-fill the full sequence.
    fakePrompt.queueInput('');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('ADD TICKET');
  });

  it('shows success card after adding ticket', async () => {
    fakePrompt.queueInput(''); // no link → no prefill
    fakePrompt.queueInput('My Ticket');
    fakePrompt.queueEditor(null);
    fakePrompt.queueConfirm(false); // "Add another?" → No

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ticket added');
  });

  it('shows error when no current sprint', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(),
      },
      sprintRepo: { findById: vi.fn(), save: vi.fn(), list: vi.fn(), remove: vi.fn() },
      external: {
        fetchIssue: vi.fn(() => Promise.resolve(Result.ok(null))),
      },
      prompt: fakePrompt,
    } as unknown as SharedDeps);

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Failed');
  });

  it('shows success card then prompts "Add another?"', async () => {
    fakePrompt.queueInput(''); // no link
    fakePrompt.queueInput('My Ticket');
    fakePrompt.queueEditor(null);
    fakePrompt.queueConfirm(false); // "Add another?" → No

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ticket added');
    // The confirm prompt should have fired
    expect(fakePrompt.confirmMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'Add another ticket?' }));
  });

  it('re-runs the form when "Add another?" is answered Yes', async () => {
    // First run: add one ticket, say yes to add another.
    fakePrompt.queueInput('');
    fakePrompt.queueInput('First Ticket');
    fakePrompt.queueEditor(null);
    fakePrompt.queueConfirm(true); // "Add another?" → Yes

    // Second run: add another ticket, say no.
    fakePrompt.queueInput('');
    fakePrompt.queueInput('Second Ticket');
    fakePrompt.queueEditor(null);
    fakePrompt.queueConfirm(false); // "Add another?" → No

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // Allow both runs to complete
    await new Promise((r) => setTimeout(r, 400));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ticket added');
    // Two confirm calls — one per run
    expect(fakePrompt.confirmMock).toHaveBeenCalledTimes(2);
  });

  it('calls router.reset to Home on Enter after success', async () => {
    fakePrompt.queueInput('');
    fakePrompt.queueInput('My Ticket');
    fakePrompt.queueEditor(null);
    fakePrompt.queueConfirm(false); // "Add another?" → No

    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 200));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    expect(router.reset).toHaveBeenCalledWith({ id: 'home' });
  });
});
