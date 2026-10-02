/**
 * At narrow widths the breadcrumb/header line and the footer hint line each stay on ONE line, clipped with an
 * ellipsis — a row of shrinking Boxes used to wrap them into one-letter columns.
 */

import { describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { Breadcrumb } from '@src/application/ui/tui/components/breadcrumb.tsx';
import { StatusBar } from '@src/application/ui/tui/components/status-bar.tsx';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { FIXED_PROJECT_ID, makeDraftSprint } from '@tests/fixtures/domain.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';

const deps = { eventBus: { publish: () => undefined, subscribe: () => () => undefined } } as unknown as AppDeps;

const LONG_PROJECT = 'A project with a really quite long display name indeed';
const LONG_SPRINT = 'A sprint named after an entire sentence about nothing';

describe('narrow chrome', () => {
  it.each([50, 70, 100])('keeps the header line on one row at %i columns', async (columns) => {
    const { result } = renderView(
      <Box flexDirection="column">
        <Breadcrumb />
        <StatusBar />
      </Box>,
      {
        deps,
        initial: { id: 'projects' },
        queue: createPromptQueue(),
        selection: {
          projectId: FIXED_PROJECT_ID,
          projectLabel: LONG_PROJECT,
          sprintId: makeDraftSprint().id,
          sprintLabel: LONG_SPRINT,
        },
        size: { columns, rows: 20 },
      }
    );
    await waitForViewReady(result, (f) => f.includes('project:'));
    const lines = (result.lastFrame() ?? '').split('\n');
    const header = lines.filter((l) => l.includes('project:') || l.includes('Projects'));
    expect(header).toHaveLength(1);
    expect([...(header[0] ?? '').trimEnd()].length).toBeLessThanOrEqual(columns);
    // Nothing wrapped into a one-letter column: every non-empty line carries real text.
    for (const line of lines.filter((l) => l.trim() !== '')) expect(line.trim().length).toBeGreaterThan(3);
    expect(lines.some((l) => l.includes('help') || l.includes('esc back'))).toBe(true);
  });
});
