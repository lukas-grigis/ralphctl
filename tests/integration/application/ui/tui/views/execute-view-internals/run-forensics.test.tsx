/**
 * `useRunForensics` resolves the post-mortem artifacts a failed run left on disk. Every entry is
 * `fs.stat`-gated — the block must never print a path that does not resolve, which is exactly
 * what an unconditional "see chain.log" line would do (there is no `chain.log`; the on-disk trace
 * is `events.ndjson`, written by the implement flow only and only under `RALPHCTL_DEBUG_TRACE`).
 *
 * The create-sprint constraint is the other fence here: a run with no pinned sprint has no
 * derivable sprint dir, so the hook must return an empty list WITHOUT touching the filesystem
 * rather than guessing a path.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useRunForensics } from '@src/application/ui/tui/views/execute-view-internals/use-run-forensics.ts';
import type { ForensicPath } from '@src/application/ui/shared/next-steps.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_keys.ts';

const SPRINT_ID = '01933fbb-2222-7000-8000-0000000000aa' as unknown as SprintId;

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path ${p}`);
  return r.value;
};

interface ProbeArgs {
  readonly enabled: boolean;
  readonly pinnedSprintId: SprintId | undefined;
  readonly flowId: string;
  readonly dataRoot: AbsolutePath;
  readonly runsRoot: AbsolutePath;
}

/** Renders the hook's output as one line per entry so `lastFrame()` can be asserted on. */
const Probe = ({ args, seen }: { readonly args: ProbeArgs; readonly seen: ForensicPath[][] }): React.JSX.Element => {
  const forensics = useRunForensics(args);
  seen.push([...forensics]);
  return <Text>{forensics.length === 0 ? 'NONE' : forensics.map((f) => `${f.label}=${f.path}`).join('|')}</Text>;
};

const mkSprintDir = async (): Promise<{ readonly dataRoot: AbsolutePath; readonly sprintDir: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'ralphctl-forensics-'));
  const sprintDir = join(root, 'sprints', `${String(SPRINT_ID)}--demo-sprint`);
  await fs.mkdir(sprintDir, { recursive: true });
  return { dataRoot: absPath(root), sprintDir };
};

describe('useRunForensics', () => {
  it('lists only the artifacts that actually exist on disk', async () => {
    const { dataRoot, sprintDir } = await mkSprintDir();
    await fs.writeFile(join(sprintDir, 'progress.md'), '# progress\n', 'utf8');

    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <Probe
        args={{
          enabled: true,
          pinnedSprintId: SPRINT_ID,
          flowId: 'implement',
          dataRoot,
          runsRoot: dataRoot,
        }}
        seen={seen}
      />
    );
    await waitFor(() => (lastFrame() ?? '').includes('progress.md'));
    const labels = (seen.at(-1) ?? []).map((f) => f.label);
    // progress.md + the sprint dir itself; events.ndjson and the verify logs dir do not exist.
    expect(labels).toContain('progress.md');
    expect(labels).toContain('sprint dir');
    expect(labels).not.toContain('events.ndjson');
    expect(labels).not.toContain('verify logs');
    expect((seen.at(-1) ?? []).find((f) => f.label === 'progress.md')?.path).toBe(join(sprintDir, 'progress.md'));
    unmount();
  });

  it('picks up events.ndjson and the verify-log dir once they exist', async () => {
    const { dataRoot, sprintDir } = await mkSprintDir();
    await fs.writeFile(join(sprintDir, 'progress.md'), '# progress\n', 'utf8');
    await fs.writeFile(join(sprintDir, 'events.ndjson'), '{}\n', 'utf8');
    await fs.mkdir(join(sprintDir, 'logs'), { recursive: true });

    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <Probe
        args={{ enabled: true, pinnedSprintId: SPRINT_ID, flowId: 'implement', dataRoot, runsRoot: dataRoot }}
        seen={seen}
      />
    );
    await waitFor(() => (lastFrame() ?? '').includes('events.ndjson'));
    const labels = (seen.at(-1) ?? []).map((f) => f.label);
    expect(labels).toEqual(['progress.md', 'events.ndjson', 'verify logs', 'sprint dir']);
    unmount();
  });

  it('returns nothing when the run has no pinned sprint (the create-sprint case)', async () => {
    const { dataRoot } = await mkSprintDir();
    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <Probe
        args={{ enabled: true, pinnedSprintId: undefined, flowId: 'create-sprint', dataRoot, runsRoot: dataRoot }}
        seen={seen}
      />
    );
    await waitFor(() => (lastFrame() ?? '').includes('NONE'));
    expect(seen.at(-1)).toEqual([]);
    unmount();
  });

  it('returns nothing while disabled (a completed run owes no post-mortem)', async () => {
    const { dataRoot, sprintDir } = await mkSprintDir();
    await fs.writeFile(join(sprintDir, 'progress.md'), '# progress\n', 'utf8');
    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <Probe
        args={{ enabled: false, pinnedSprintId: SPRINT_ID, flowId: 'implement', dataRoot, runsRoot: dataRoot }}
        seen={seen}
      />
    );
    await waitFor(() => (lastFrame() ?? '').includes('NONE'));
    expect(seen.at(-1)).toEqual([]);
    unmount();
  });

  it('returns nothing when the sprint directory is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ralphctl-forensics-empty-'));
    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <Probe
        args={{
          enabled: true,
          pinnedSprintId: SPRINT_ID,
          flowId: 'implement',
          dataRoot: absPath(root),
          runsRoot: absPath(root),
        }}
        seen={seen}
      />
    );
    await waitFor(() => (lastFrame() ?? '').includes('NONE'));
    expect(seen.at(-1)).toEqual([]);
    unmount();
  });

  it('points a one-shot flow at its runs directory, never at a fabricated run id', async () => {
    // `<runsRoot>/<flowId>/<run-id>/` — the run-id segment is generated inside the chain and
    // never reaches the descriptor, so the hook stops one level up and names `ralphctl runs list`.
    const root = await mkdtemp(join(tmpdir(), 'ralphctl-forensics-runs-'));
    const runsRoot = join(root, 'runs');
    await fs.mkdir(join(runsRoot, 'readiness'), { recursive: true });

    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <Probe
        args={{
          enabled: true,
          pinnedSprintId: undefined,
          flowId: 'readiness',
          dataRoot: absPath(root),
          runsRoot: absPath(runsRoot),
        }}
        seen={seen}
      />
    );
    await waitFor(() => (lastFrame() ?? '').includes('run artifacts'));
    const entry = (seen.at(-1) ?? []).find((f) => f.label === 'run artifacts');
    expect(entry?.path).toBe(join(runsRoot, 'readiness'));
    unmount();
  });
});
