/** Runs whose live-run record outlived their owner, newest first; `dismiss` drops one record and refreshes. */

import { useCallback, useEffect, useState } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import type { InterruptedRun } from '@src/business/runs/detect-interrupted-runs.ts';

export interface InterruptedRunsApi {
  readonly runs: readonly InterruptedRun[];
  readonly dismiss: (runId: string) => Promise<boolean>;
}

export const useInterruptedRuns = (): InterruptedRunsApi => {
  const deps = useDeps();
  const [runs, setRuns] = useState<readonly InterruptedRun[]>([]);

  const load = useCallback(async (): Promise<readonly InterruptedRun[]> => {
    try {
      const detected = await deps.detectInterruptedRuns.execute();
      if (!detected.ok) return [];
      return [...detected.value].sort((a, b) => Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt));
    } catch {
      // The list is an enrichment of Runs; without it the view shows live sessions only.
      return [];
    }
  }, [deps]);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setRuns(next);
    });
    return (): void => {
      cancelled = true;
    };
  }, [load]);

  const dismiss = useCallback(
    async (runId: string): Promise<boolean> => {
      try {
        const removed = await deps.dismissInterruptedRuns.execute([runId]);
        setRuns(await load());
        return removed.ok;
      } catch {
        return false;
      }
    },
    [deps, load]
  );

  return { runs, dismiss };
};
