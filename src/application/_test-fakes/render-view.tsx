/**
 * `renderView` — single entry point for Ink view tests.
 *
 * Wraps `ink-testing-library`'s `render()` with the production-equivalent
 * router + view-hints providers and a fully wired {@link SharedDeps} graph
 * built from {@link buildTuiDeps}. Returns the ink-testing harness plus
 * the deps + router recorder so tests can assert on both the rendered
 * frame AND the side effects.
 *
 * Why a single helper:
 *  - Removes the ~50-line setup boilerplate from each `*-view.test.tsx`.
 *  - Pins router/hints providers so a view that calls `useRouter()` works
 *    in tests without each test re-mocking the API.
 *  - Auto-cleans up via `afterEach` (resets shared deps, unmounts the
 *    Ink tree).
 *
 * Usage:
 * ```tsx
 * import { renderView } from '.../render-view.tsx';
 *
 * it('renders the home banner', async () => {
 *   const { lastFrame, settle } = renderView(<HomeView sessionManager={null} />);
 *   await settle();
 *   expect(lastFrame()).toContain('Pipeline');
 * });
 * ```
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, vi } from 'vitest';

type InkRenderResult = ReturnType<typeof render>;
import { resetSharedDeps, setSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { RouterProvider, type RouterApi, type ViewEntry } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider } from '@src/application/tui/views/view-hints-context.tsx';
import { buildTuiDeps, type TuiDepsOptions, type TuiTestDeps } from './build-tui-deps.ts';

export interface RecordingRouter extends RouterApi {
  /** vi.fn() spies the test asserts against. */
  readonly mocks: {
    readonly push: ReturnType<typeof vi.fn>;
    readonly pop: ReturnType<typeof vi.fn>;
    readonly replace: ReturnType<typeof vi.fn>;
    readonly reset: ReturnType<typeof vi.fn>;
  };
}

export interface RenderViewOptions extends TuiDepsOptions {
  /** Initial router stack. Defaults to `[{ id: 'home' }]`. */
  readonly initialStack?: readonly ViewEntry[];
}

export interface RenderViewResult extends InkRenderResult {
  readonly deps: TuiTestDeps;
  readonly router: RecordingRouter;
  /**
   * Awaits `setTimeout(ms)` so `useEffect` data loaders settle before
   * assertions run. Most views fire one async load on mount; calling
   * `await settle()` after `renderView()` is the standard pattern.
   *
   * Declared as an arrow-function field so destructuring is safe under the
   * `@typescript-eslint/unbound-method` rule.
   */
  readonly settle: (ms?: number) => Promise<void>;
}

let activeUnmount: (() => void) | null = null;

afterEach(() => {
  activeUnmount?.();
  activeUnmount = null;
  resetSharedDeps();
  vi.restoreAllMocks();
});

function makeRouter(initialStack: readonly ViewEntry[]): RecordingRouter {
  const stack = initialStack.length > 0 ? initialStack : [{ id: 'home' as const }];
  const current = stack[stack.length - 1] ?? { id: 'home' as const };
  const mocks = {
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
  return {
    current,
    stack,
    push: mocks.push,
    pop: mocks.pop,
    replace: mocks.replace,
    reset: mocks.reset,
    mocks,
  };
}

export function renderView(view: React.ReactElement, opts: RenderViewOptions = {}): RenderViewResult {
  const deps = buildTuiDeps(opts);
  setSharedDeps(deps);

  const router = makeRouter(opts.initialStack ?? [{ id: 'home' }]);

  const tree = (
    <RouterProvider value={router}>
      <ViewHintsProvider>{view}</ViewHintsProvider>
    </RouterProvider>
  );

  const result = render(tree);
  activeUnmount = result.unmount;

  return {
    ...result,
    deps,
    router,
    settle: async (ms = 50) => {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
}
