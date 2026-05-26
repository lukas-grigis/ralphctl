/**
 * Review-step description scroll tests for the add-ticket wizard. The Review step renders a
 * three-row FieldList (Title / Description / Link) plus a ConfirmPrompt; long descriptions
 * used to push the Link row and the confirm pills off the bottom of the terminal. The
 * description body now lives in a bounded viewport that scrolls under ↑/↓ + PgUp/PgDn so the
 * Link row and the pills stay in view.
 *
 * Covered:
 *   - long description: ↓ shifts the visible window by one line; position indicator updates
 *   - short description: no indicator, no scroll widget — static rendering matches today's
 *     output for that content (a single `<Text>` value alongside the Description label)
 *   - PgDn then PgUp: window shifts by a page, then returns
 *   - resize: changing stdout rows triggers a clamp so the offset stays within the new bounds
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AddTicketView } from '@src/application/ui/tui/views/add-ticket-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { ExternalIssue, IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { DOWN, ENTER, UP } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const buildDescription = (lineCount: number): string => {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (i === 0) lines.push('FIRST-LINE-SENTINEL');
    else if (i === lineCount - 1) lines.push('LAST-LINE-SENTINEL');
    else lines.push(`filler-line-${String(i).padStart(2, '0')}`);
  }
  return lines.join('\n');
};

const makeDepsWithFetchedDescription = (description: string): { deps: AppDeps; sprint: Sprint } => {
  const sprint = makeDraftSprint();
  const save = vi.fn(async (s: Sprint) => {
    void s;
    return Result.ok(undefined);
  });
  const sprintRepo: SprintRepository = {
    async findById() {
      return Result.ok(sprint);
    },
    save,
  } as unknown as SprintRepository;
  const fetched: ExternalIssue = {
    url: 'https://github.com/acme/repo/issues/42',
    title: 'Long ticket',
    body: description,
    state: 'open',
    comments: [],
  };
  const issueFetcher: IssueFetcher = async () => Result.ok(fetched);
  const deps: AppDeps = { sprintRepo, issueFetcher } as unknown as AppDeps;
  return { deps, sprint };
};

/**
 * Walk the wizard via the URL-prefill path (link → fetch → title prefilled → description
 * prefilled → confirm). Returns once the Review step is on screen. The harness's auto-cleanup
 * unmounts on test end so callers do not need to dispose explicitly.
 */
const walkToReview = async (
  deps: AppDeps,
  sprintId: Sprint['id']
): Promise<ReturnType<typeof renderView>['result']> => {
  const { result } = renderView(<AddTicketView />, {
    deps,
    initial: { id: 'add-ticket', props: { sprintId } },
  });

  await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
  result.stdin.write('https://github.com/acme/repo/issues/42');
  await waitFor(() => expect(result.lastFrame()).toContain('issues/42'));
  result.stdin.write(ENTER);

  // Title step: prompt header is "▸ Title".
  await waitFor(() => expect(result.lastFrame()).toMatch(/▸\s*Title/));
  result.stdin.write(ENTER);

  // Description step: prompt header is "▸ Description". Distinct from the FieldList
  // "Description:" label that appears later on the Review card (no cursor glyph).
  await waitFor(() => expect(result.lastFrame()).toMatch(/▸\s*Description/));
  result.stdin.write(ENTER);

  // Review card + ConfirmPrompt.
  await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
  return result;
};

describe('AddTicketView — Review step scrollable description', () => {
  it('long description: ↓ shifts the visible window by one line and the position indicator updates', async () => {
    const description = buildDescription(20);
    const { deps, sprint } = makeDepsWithFetchedDescription(description);
    const result = await walkToReview(deps, sprint.id);

    // On the default 24-row test terminal the 20-line description overflows the viewport.
    // The FIRST-LINE sentinel is visible at the head of the window; LAST-LINE is not yet on
    // screen; a `lines 1–N of 20` indicator hangs below the slice.
    const initial = result.lastFrame() ?? '';
    expect(initial).toContain('FIRST-LINE-SENTINEL');
    expect(initial).not.toContain('LAST-LINE-SENTINEL');
    expect(initial).toMatch(/lines 1[–-]\d+ of 20/);

    // ↓ shifts the window by one line — FIRST-LINE leaves; the indicator advances to start at 2.
    result.stdin.write(DOWN);
    await waitFor(() => expect(result.lastFrame()).toMatch(/lines 2[–-]\d+ of 20/));
    const shifted = result.lastFrame() ?? '';
    expect(shifted).not.toContain('FIRST-LINE-SENTINEL');
    // Link row and the confirm pills remain visible regardless of scroll position.
    expect(shifted).toContain('https://github.com/acme/repo/issues/42');
    expect(shifted).toContain('Add this ticket?');
  });

  it('short description: no position indicator, no scroll widget — static rendering matches', async () => {
    const description = 'A short two-line description.\nNothing more to scroll.';
    const { deps, sprint } = makeDepsWithFetchedDescription(description);
    const result = await walkToReview(deps, sprint.id);

    const frame = result.lastFrame() ?? '';
    // Full body fits in one viewport — no `lines N–M of T` indicator anywhere on the frame.
    expect(frame).not.toMatch(/lines \d+[–-]\d+ of \d+/);
    // The description renders inline next to the Description label, identical to the pre-fix
    // single-`<Text>` value. Both lines visible end-to-end.
    expect(frame).toContain('A short two-line description.');
    expect(frame).toContain('Nothing more to scroll.');
    // Footer ↑/↓ scroll hint is suppressed on this view because arrows are inert here. The
    // footer hint row is the last line that ends with `quit`.
    const footerLine =
      frame
        .split('\n')
        .reverse()
        .find((l) => l.includes('quit')) ?? '';
    expect(footerLine).not.toContain('↑/↓');
  });

  it('PgDn then PgUp: window shifts by a page then returns', async () => {
    const description = buildDescription(30);
    const { deps, sprint } = makeDepsWithFetchedDescription(description);
    const result = await walkToReview(deps, sprint.id);

    // Start at the top.
    await waitFor(() => expect(result.lastFrame()).toMatch(/lines 1[–-]\d+ of 30/));

    // PgDn → window shifts by one viewport-height. The exact viewport size depends on the
    // chrome heuristic, so we only assert the start index strictly increases past 1.
    result.stdin.write('\x1b[6~'); // VT220 PgDn — ink maps this to key.pageDown
    await waitFor(() => {
      const m = /lines (\d+)[–-]\d+ of 30/.exec(result.lastFrame() ?? '');
      expect(m).not.toBeNull();
      const start = Number(m?.[1] ?? '1');
      expect(start).toBeGreaterThan(1);
    });

    // PgUp returns toward the top.
    result.stdin.write('\x1b[5~'); // VT220 PgUp — ink maps this to key.pageUp
    await waitFor(() => expect(result.lastFrame()).toMatch(/lines 1[–-]\d+ of 30/));

    // PgUp at the top clamps — one more press is a no-op.
    result.stdin.write('\x1b[5~');
    await tick(30);
    expect(result.lastFrame()).toMatch(/lines 1[–-]\d+ of 30/);
  });

  it('↑ at the top clamps and Link / confirm rows stay visible', async () => {
    const description = buildDescription(20);
    const { deps, sprint } = makeDepsWithFetchedDescription(description);
    const result = await walkToReview(deps, sprint.id);

    // ↑ at offset 0 — clamp keeps us at line 1.
    result.stdin.write(UP);
    await tick(30);
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/lines 1[–-]\d+ of 20/);
    // Link row + confirm pills still on screen.
    expect(frame).toContain('https://github.com/acme/repo/issues/42');
    expect(frame).toContain('Add this ticket?');
  });

  it('resize: shrinking the terminal clamps the offset within the new bounds', async () => {
    const description = buildDescription(30);
    const { deps, sprint } = makeDepsWithFetchedDescription(description);
    const result = await walkToReview(deps, sprint.id);

    // ink-testing-library's stdout does not expose `rows` natively; the production terminal-
    // size hook falls back to 24 when rows is undefined. We monkey-patch `rows` onto the
    // emitter and dispatch 'resize' to drive the production listener. The viewport on the
    // pre-resize 24-row default is ~10 rows (CHROME=14, MIN=4); after rows=40 the viewport
    // grows to ~26 — equivalent to a wider terminal that needs less scroll headroom.
    const stdout = result.stdout as unknown as { rows?: number; emit(event: string): boolean };

    // Scroll near the bottom of the 30-line body on the default 24-row viewport.
    for (let i = 0; i < 6; i++) {
      result.stdin.write('\x1b[6~'); // PgDn
      await tick(20);
    }
    await waitFor(() => expect(result.lastFrame()).toContain('LAST-LINE-SENTINEL'));
    const beforeMatch = /lines (\d+)[–-]\d+ of 30/.exec(result.lastFrame() ?? '');
    expect(beforeMatch).not.toBeNull();
    const beforeStart = Number(beforeMatch?.[1] ?? '0');
    expect(beforeStart).toBeGreaterThan(1);

    // Grow the terminal: rows 24 → 40 ⇒ viewport ≈ 10 → 26 ⇒ maxOffset shrinks. Any offset
    // that exceeded the new maxOffset must clamp down. The clamp effect runs on the
    // maxOffset dependency; emitting 'resize' triggers the useTerminalSize listener which
    // updates the rows state, which re-derives the viewport, which trips the effect.
    stdout.rows = 40;
    stdout.emit('resize');
    await tick(60);

    const after = result.lastFrame() ?? '';
    const afterMatch = /lines (\d+)[–-](\d+) of 30/.exec(after);
    expect(afterMatch).not.toBeNull();
    const afterStart = Number(afterMatch?.[1] ?? '0');
    const afterEnd = Number(afterMatch?.[2] ?? '0');
    // Offset stays valid: start ≥ 1, end ≤ 30. After clamp the offset is ≤ the new maxOffset
    // (= 30 - viewport), so the bottom of the body remains pinned to the bottom of the
    // viewport — LAST-LINE-SENTINEL still visible.
    expect(afterStart).toBeGreaterThanOrEqual(1);
    expect(afterEnd).toBeLessThanOrEqual(30);
    expect(after).toContain('LAST-LINE-SENTINEL');
  });
});
