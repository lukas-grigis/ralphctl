/**
 * Small file-backed store for the user's most recent project pick. Lives under `stateRoot`
 * because it's ephemeral coordination (a single id), not part of the projects/sprints data
 * model. Read at launch to pre-select the picker; written whenever the user lands on a new
 * project.
 *
 * Failures are silent: this is a UX optimisation, not a contract — losing the file just means
 * the picker doesn't have a default cursor next launch.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

const FILE_NAME = 'last-selection.json';

export interface LastSelection {
  readonly projectId: ProjectId;
  readonly projectLabel?: string;
  /**
   * Most-recent sprint pick under {@link projectId}. Optional — older files (and selections made
   * before any sprint was picked) omit it. CLI `sprint set-current` writes here; the TUI reads
   * it at launch to pre-select the last-used sprint after the project pick lands.
   */
  readonly sprintId?: SprintId;
}

export interface LastSelectionStore {
  read(): Promise<LastSelection | undefined>;
  write(value: LastSelection | undefined): Promise<void>;
}

export const createLastSelectionStore = (stateRoot: AbsolutePath): LastSelectionStore => {
  const path = join(String(stateRoot), FILE_NAME);
  return {
    async read(): Promise<LastSelection | undefined> {
      try {
        const raw = await fs.readFile(path, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return undefined;
        const rec = parsed as { projectId?: unknown; projectLabel?: unknown; sprintId?: unknown };
        if (typeof rec.projectId !== 'string' || rec.projectId.length === 0) return undefined;
        const out: LastSelection = {
          projectId: rec.projectId as ProjectId,
          ...(typeof rec.projectLabel === 'string' ? { projectLabel: rec.projectLabel } : {}),
          ...(typeof rec.sprintId === 'string' && rec.sprintId.length > 0
            ? { sprintId: rec.sprintId as SprintId }
            : {}),
        };
        return out;
      } catch {
        return undefined;
      }
    },
    async write(value: LastSelection | undefined): Promise<void> {
      try {
        if (value === undefined) {
          await fs.rm(path, { force: true });
          return;
        }
        await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
      } catch {
        // best-effort
      }
    },
  };
};
