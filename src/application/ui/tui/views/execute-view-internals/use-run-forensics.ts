/**
 * Resolves the post-mortem artifacts a settled-with-failure run left on disk, for the settled `ResultCard`'s
 * `Post-mortem` block.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ForensicPath } from '@src/application/ui/shared/next-steps.ts';

/** Flows whose forensic output lands under `runsRoot` rather than in a sprint directory. */
const RUNS_ROOT_FLOW_IDS: ReadonlySet<string> = new Set(['detect-scripts', 'detect-skills', 'readiness']);

export interface UseRunForensicsInput {
  /** Only failed / aborted runs owe a post-mortem — a completed run's artifacts are not news. */
  readonly enabled: boolean;
  readonly pinnedSprintId: SprintId | undefined;
  readonly flowId: string;
  readonly dataRoot: AbsolutePath;
  readonly runsRoot: AbsolutePath;
}

/** `fs.stat` probe that answers "does this path exist?" without ever throwing. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
};

const collectSprintArtifacts = async (dataRoot: AbsolutePath, sprintId: SprintId): Promise<readonly ForensicPath[]> => {
  const dir = await resolveSprintDir(dataRoot, sprintId);
  if (dir === undefined) return [];
  const candidates: readonly ForensicPath[] = [
    { label: 'progress.md', path: join(dir, 'progress.md') },
    { label: 'events.ndjson', path: join(dir, 'events.ndjson') },
    { label: 'verify logs', path: join(dir, 'logs') },
    { label: 'sprint dir', path: dir },
  ];
  const found: ForensicPath[] = [];
  for (const candidate of candidates) {
    if (await exists(candidate.path)) found.push(candidate);
  }
  return found;
};

export const useRunForensics = ({
  enabled,
  pinnedSprintId,
  flowId,
  dataRoot,
  runsRoot,
}: UseRunForensicsInput): readonly ForensicPath[] => {
  const [paths, setPaths] = React.useState<readonly ForensicPath[]>([]);

  React.useEffect(() => {
    if (!enabled) {
      setPaths([]);
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      const found: ForensicPath[] = [];
      if (pinnedSprintId !== undefined) {
        found.push(...(await collectSprintArtifacts(dataRoot, pinnedSprintId)));
      }
      if (RUNS_ROOT_FLOW_IDS.has(flowId)) {
        const flowDir = join(String(runsRoot), flowId);
        if (await exists(flowDir)) found.push({ label: 'run artifacts', path: flowDir });
      }
      if (!cancelled) setPaths(found);
    };
    void load();
    return (): void => {
      cancelled = true;
    };
  }, [enabled, pinnedSprintId, flowId, dataRoot, runsRoot]);

  return paths;
};
