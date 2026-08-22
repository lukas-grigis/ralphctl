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
import { join } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useRunForensics } from '@src/application/ui/tui/views/execute-view-internals/use-run-forensics.ts';
import type { ForensicPath } from '@src/application/ui/shared/next-steps.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

const SPRINT_ID = '01933fbb-2222-7000-8000-0000000000aa' as unknown as SprintId;

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path ${p}`);
  return r.value;
};

const cleanups: Array<() => Promise<void>> = [];

/** Allocates a tmp root and registers it for teardown — every test in this file routes through here. */
const nextTmpRoot = async (): Promise<AbsolutePath> => {
  const { root, cleanup } = await makeTmpRoot();
  cleanups.push(cleanup);
  return root;
};

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

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
  const dataRoot = await nextTmpRoot();
  const sprintDir = join(String(dataRoot), 'sprints', `${String(SPRINT_ID)}--demo-sprint`);
  await fs.mkdir(sprintDir, { recursive: true });
  return { dataRoot, sprintDir };
};

/**
 * Settle marker for the negative tests.
 *
 * `useRunForensics` seeds its state to `[]` and only fills it once an async `fs.stat` pass
 * resolves inside `useEffect`, so the hook's EMPTY output is also its FIRST FRAME — waiting for
 * "empty" is satisfied at t≈0, before the effect can possibly have run, and a regression that
 * resolved a fabricated sprint dir one tick later would sail straight through. So each negative
 * test renders this control alongside the probe under test: it is pinned at a sprint directory
 * that really exists, does strictly MORE filesystem work than any negative case (resolve + four
 * stats vs. zero or one), and its effect is scheduled by the same commit. Once `CONTROL:n` has
 * appeared with n > 0 the negative case has definitively finished its own pass, and the whole
 * `seen` history — not just the last frame — can be asserted empty.
 */
const ControlProbe = ({ dataRoot }: { readonly dataRoot: AbsolutePath }): React.JSX.Element => {
  const forensics = useRunForensics({
    enabled: true,
    pinnedSprintId: SPRINT_ID,
    flowId: 'implement',
    dataRoot,
    runsRoot: dataRoot,
  });
  return <Text>{`CONTROL:${String(forensics.length)}`}</Text>;
};

/** Grace beyond the control's settle, so a leak racing just behind it still lands in `seen`. */
const SETTLE_GRACE_MS = 50;

const controlSettled = (frame: string): boolean => /CONTROL:[1-9]/.test(frame);

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
    await waitForPredicate(() => (lastFrame() ?? '').includes('progress.md'));
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
    await waitForPredicate(() => (lastFrame() ?? '').includes('events.ndjson'));
    const labels = (seen.at(-1) ?? []).map((f) => f.label);
    expect(labels).toEqual(['progress.md', 'events.ndjson', 'verify logs', 'sprint dir']);
    unmount();
  });

  it('returns nothing when the run has no pinned sprint (the create-sprint case)', async () => {
    // `mkSprintDir()` puts a REAL `<root>/sprints/<SPRINT_ID>--demo-sprint` with a real
    // progress.md on disk: a regression that guessed the pin from the ambient data root would
    // find something to report, and every frame in `seen` would stop being empty.
    const { dataRoot, sprintDir } = await mkSprintDir();
    await fs.writeFile(join(sprintDir, 'progress.md'), '# progress\n', 'utf8');
    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <>
        <Probe
          args={{ enabled: true, pinnedSprintId: undefined, flowId: 'create-sprint', dataRoot, runsRoot: dataRoot }}
          seen={seen}
        />
        <ControlProbe dataRoot={dataRoot} />
      </>
    );

    await waitForPredicate(() => controlSettled(lastFrame() ?? ''), { label: 'the control probe settled' });
    await tick(SETTLE_GRACE_MS);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entries) => entries.length === 0)).toBe(true);
    unmount();
  });

  it('returns nothing while disabled (a completed run owes no post-mortem)', async () => {
    const { dataRoot, sprintDir } = await mkSprintDir();
    await fs.writeFile(join(sprintDir, 'progress.md'), '# progress\n', 'utf8');
    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <>
        <Probe
          args={{ enabled: false, pinnedSprintId: SPRINT_ID, flowId: 'implement', dataRoot, runsRoot: dataRoot }}
          seen={seen}
        />
        <ControlProbe dataRoot={dataRoot} />
      </>
    );

    // The control proves the artifacts ARE resolvable from this very root — so an empty list
    // here can only come from the `enabled: false` gate, not from an unpopulated tmp dir.
    await waitForPredicate(() => controlSettled(lastFrame() ?? ''), { label: 'the control probe settled' });
    await tick(SETTLE_GRACE_MS);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entries) => entries.length === 0)).toBe(true);
    unmount();
  });

  it('returns nothing when the sprint directory is gone', async () => {
    // A sibling sprint exists under `sprints/` so the resolver has a real directory to scan and
    // mis-match against — "empty because the tree is empty" would prove much less.
    const root = await nextTmpRoot();
    const strangerDir = join(String(root), 'sprints', '01933fbb-9999-7000-8000-0000000000bb--other-sprint');
    await fs.mkdir(strangerDir, { recursive: true });
    await fs.writeFile(join(strangerDir, 'progress.md'), '# not ours\n', 'utf8');

    const { dataRoot: controlRoot } = await mkSprintDir();
    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <>
        <Probe
          args={{
            enabled: true,
            pinnedSprintId: SPRINT_ID,
            flowId: 'implement',
            dataRoot: root,
            runsRoot: root,
          }}
          seen={seen}
        />
        <ControlProbe dataRoot={controlRoot} />
      </>
    );

    await waitForPredicate(() => controlSettled(lastFrame() ?? ''), { label: 'the control probe settled' });
    await tick(SETTLE_GRACE_MS);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entries) => entries.length === 0)).toBe(true);
    unmount();
  });

  it('points a one-shot flow at its runs directory, never at a fabricated run id', async () => {
    // `<runsRoot>/<flowId>/<run-id>/` — the run-id segment is generated inside the chain and
    // never reaches the descriptor, so the hook stops one level up and names `ralphctl runs list`.
    const root = await nextTmpRoot();
    const runsRoot = join(String(root), 'runs');
    await fs.mkdir(join(runsRoot, 'readiness'), { recursive: true });

    const seen: ForensicPath[][] = [];
    const { lastFrame, unmount } = render(
      <Probe
        args={{
          enabled: true,
          pinnedSprintId: undefined,
          flowId: 'readiness',
          dataRoot: root,
          runsRoot: absPath(runsRoot),
        }}
        seen={seen}
      />
    );
    await waitForPredicate(() => (lastFrame() ?? '').includes('run artifacts'));
    const entry = (seen.at(-1) ?? []).find((f) => f.label === 'run artifacts');
    expect(entry?.path).toBe(join(runsRoot, 'readiness'));
    unmount();
  });
});
