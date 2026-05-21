/**
 * Tracks the user's "current selection" — which project and which sprint the next flow should
 * target. Updated when the user opens a project / sprint detail screen (or explicitly via the
 * sprint detail's "make current" action). The home view reads this to summarise state and the
 * flow launcher reads it to build chain ctx without re-prompting.
 *
 * Display labels are cached alongside the ids so the status bar can show "proj: foo · sprint:
 * bar" without re-loading the aggregates on every render.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

interface SelectionApi {
  readonly projectId: ProjectId | undefined;
  readonly sprintId: SprintId | undefined;
  readonly projectLabel: string | undefined;
  readonly sprintLabel: string | undefined;
  setProject(id: ProjectId | undefined, label?: string): void;
  setSprint(id: SprintId | undefined, label?: string): void;
  /**
   * Atomic project + sprint switch — used by the cross-project sprint picker so picking a
   * sprint from a different project updates both ids in a single state batch. Going through
   * `setProject` then `setSprint` would clear the sprint mid-flight (setProject zeroes the
   * sprint cursor as a side effect) and fire `onChange` twice; this setter fires it once.
   */
  setProjectAndSprint(projectId: ProjectId, projectLabel: string, sprintId: SprintId, sprintLabel: string): void;
}

const SelectionContext = createContext<SelectionApi | undefined>(undefined);

export interface SelectionSeed {
  readonly projectId?: ProjectId;
  readonly projectLabel?: string;
  readonly sprintId?: SprintId;
  readonly sprintLabel?: string;
}

export interface SelectionProviderProps {
  readonly children: React.ReactNode;
  /** Initial selection. Used by launch to pre-pick a project when storage has exactly one. */
  readonly seed?: SelectionSeed;
  /**
   * Called with the latest selection whenever it changes — production wires this to a small
   * file-backed store so the next launch pre-selects the same project.
   */
  readonly onChange?: (next: SelectionSeed) => void;
}

export const SelectionProvider = ({ children, seed, onChange }: SelectionProviderProps): React.JSX.Element => {
  const [projectId, setProjectId] = useState<ProjectId | undefined>(seed?.projectId);
  const [sprintId, setSprintId] = useState<SprintId | undefined>(seed?.sprintId);
  const [projectLabel, setProjectLabel] = useState<string | undefined>(seed?.projectLabel);
  const [sprintLabel, setSprintLabel] = useState<string | undefined>(seed?.sprintLabel);
  // Keep the callback in a ref so re-renders don't churn the persistence effect's deps.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Persist whenever the canonical selection changes. The initial render also fires this, so
  // closing the picker without changes is a no-op write — fine for our flat-file store.
  useEffect(() => {
    onChangeRef.current?.({
      ...(projectId !== undefined ? { projectId } : {}),
      ...(projectLabel !== undefined ? { projectLabel } : {}),
      ...(sprintId !== undefined ? { sprintId } : {}),
      ...(sprintLabel !== undefined ? { sprintLabel } : {}),
    });
  }, [projectId, projectLabel, sprintId, sprintLabel]);

  const setProject = useCallback((id: ProjectId | undefined, label?: string) => {
    setProjectId(id);
    setProjectLabel(id === undefined ? undefined : label);
    // Picking a different project clears the sprint cursor — sprint ids are scoped to a project.
    setSprintId(undefined);
    setSprintLabel(undefined);
  }, []);

  const setSprint = useCallback((id: SprintId | undefined, label?: string) => {
    setSprintId(id);
    setSprintLabel(id === undefined ? undefined : label);
  }, []);

  const setProjectAndSprint = useCallback((pId: ProjectId, pLabel: string, sId: SprintId, sLabel: string) => {
    // React batches the four setState calls inside a single event handler — onChange's
    // effect runs once after the batch, with both ids visible together.
    setProjectId(pId);
    setProjectLabel(pLabel);
    setSprintId(sId);
    setSprintLabel(sLabel);
  }, []);

  const api = useMemo<SelectionApi>(
    () => ({
      projectId,
      sprintId,
      projectLabel,
      sprintLabel,
      setProject,
      setSprint,
      setProjectAndSprint,
    }),
    [projectId, sprintId, projectLabel, sprintLabel, setProject, setSprint, setProjectAndSprint]
  );

  return <SelectionContext.Provider value={api}>{children}</SelectionContext.Provider>;
};

export const useSelection = (): SelectionApi => {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection: must be used inside <SelectionProvider>');
  return ctx;
};
