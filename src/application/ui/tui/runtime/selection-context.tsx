/** Tracks the user's "current selection" — which project and which sprint the next flow should target. */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Sprint, SprintStatus } from '@src/domain/entity/sprint.ts';
import type { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/** Most-recent "I just switched to this sprint" record. */
export interface LastSprintSwitch {
  readonly sprintId: SprintId;
  readonly sprintLabel: string;
  /** `Date.now()` at the moment of the switch — Home compares against `Date.now()` on render. */
  readonly at: number;
}

interface SelectionApi {
  readonly projectId: ProjectId | undefined;
  readonly sprintId: SprintId | undefined;
  readonly projectLabel: string | undefined;
  readonly sprintLabel: string | undefined;
  /** Lifecycle status of the currently-selected sprint — used by the breadcrumb status chip. */
  readonly sprintStatus: SprintStatus | undefined;
  /**
   * Last sprint-switch record (see {@link LastSprintSwitch}). `undefined` before any switch in this session.
   */
  readonly lastSwitch: LastSprintSwitch | undefined;
  setProject(id: ProjectId | undefined, label?: string): void;
  setSprint(id: SprintId | undefined, label?: string, status?: SprintStatus): void;
  /** Toast-free status refresh for the CURRENTLY selected sprint. */
  syncSprintStatus(id: SprintId, status: SprintStatus): void;
  /**
   * Atomic project + sprint switch — used by the cross-project sprint picker so picking a sprint from a different
   * project updates both ids in a single state batch.
   */
  setProjectAndSprint(
    projectId: ProjectId,
    projectLabel: string,
    sprintId: SprintId,
    sprintLabel: string,
    sprintStatus?: SprintStatus
  ): void;
  /** Converge the selection onto a focused Execute-view run's pinned project/sprint. */
  followFocusedRun(projectId: ProjectId, projectLabel: string, sprintId: SprintId, sprintLabel: string): void;
}

const SelectionContext = createContext<SelectionApi | undefined>(undefined);

export interface SelectionSeed {
  readonly projectId?: ProjectId;
  readonly projectLabel?: string;
  readonly sprintId?: SprintId;
  readonly sprintLabel?: string;
}

/**
 * Slim port used by the done-on-boot clear. Production wires this to the full {@link SprintRepository} via `App.tsx`;
 * tests pass an inline stub.
 */
export interface SprintStatusReader {
  findById(id: SprintId): Promise<Result<Sprint, DomainError>>;
}

export interface SelectionProviderProps {
  readonly children: React.ReactNode;
  /** Initial selection. Used by launch to pre-pick a project when storage has exactly one. */
  readonly seed?: SelectionSeed;
  /**
   * Called with the latest selection whenever it changes — production wires this to a small file-backed store so the
   * next launch pre-selects the same project.
   */
  readonly onChange?: (next: SelectionSeed) => void;
  /** Best-effort lookup for the seeded sprint. */
  readonly sprintRepo?: SprintStatusReader;
}

/** Exact tuple `followFocusedRun` is about to write — see {@link useSelectionPersistence}. */
interface SkipPersistTuple {
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  readonly sprintId: SprintId;
  readonly sprintLabel: string;
}

/**
 * Fires `onChange` whenever the canonical selection changes.
 */
const useSelectionPersistence = (
  selection: {
    readonly projectId: ProjectId | undefined;
    readonly projectLabel: string | undefined;
    readonly sprintId: SprintId | undefined;
    readonly sprintLabel: string | undefined;
  },
  onChange: ((next: SelectionSeed) => void) | undefined
): { readonly skipNextPersist: (tuple: SkipPersistTuple) => void } => {
  const { projectId, projectLabel, sprintId, sprintLabel } = selection;
  // Keep the callback in a ref so re-renders don't churn the persistence effect's deps.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Set by `followFocusedRun` (via `skipNextPersist`) right before its state writes, to the EXACT tuple it's about to
  // write.
  const skipPersistForRef = useRef<SkipPersistTuple | undefined>(undefined);

  const isFirstPersist = useRef(true);
  useEffect(() => {
    if (isFirstPersist.current) {
      isFirstPersist.current = false;
      return;
    }
    const skip = skipPersistForRef.current;
    if (
      skip !== undefined &&
      skip.projectId === projectId &&
      skip.projectLabel === projectLabel &&
      skip.sprintId === sprintId &&
      skip.sprintLabel === sprintLabel
    ) {
      skipPersistForRef.current = undefined;
      return;
    }
    onChangeRef.current?.({
      ...(projectId !== undefined ? { projectId } : {}),
      ...(projectLabel !== undefined ? { projectLabel } : {}),
      ...(sprintId !== undefined ? { sprintId } : {}),
      ...(sprintLabel !== undefined ? { sprintLabel } : {}),
    });
  }, [projectId, projectLabel, sprintId, sprintLabel]);

  const skipNextPersist = useCallback((tuple: SkipPersistTuple): void => {
    skipPersistForRef.current = tuple;
  }, []);

  return { skipNextPersist };
};

/**
 * Runs once per seeded sprint id: if `sprintRepo.findById` resolves to a sprint with status `done`, drop both ids so
 * the first paint of Home shows the empty-sprint card.
 */
const useDoneOnBootClear = (args: {
  readonly seedSprintId: SprintId | undefined;
  readonly sprintRepo: SprintStatusReader | undefined;
  readonly sprintIdRef: React.RefObject<SprintId | undefined>;
  readonly setSprintId: (id: SprintId | undefined) => void;
  readonly setSprintLabel: (label: string | undefined) => void;
  readonly setSprintStatus: (status: SprintStatus | undefined) => void;
}): void => {
  const { seedSprintId, sprintRepo, sprintIdRef, setSprintId, setSprintLabel, setSprintStatus } = args;
  const sprintRepoRef = useRef(sprintRepo);
  sprintRepoRef.current = sprintRepo;

  useEffect(() => {
    if (seedSprintId === undefined) return undefined;
    const repo = sprintRepoRef.current;
    if (repo === undefined) return undefined;
    let cancelled = false;
    void repo
      .findById(seedSprintId)
      .then((r) => {
        if (cancelled) return;
        // Bail via the live ref.
        if (sprintIdRef.current !== seedSprintId) return;
        if (!r.ok) return;
        if (r.value.status === 'done') {
          setSprintId(undefined);
          setSprintLabel(undefined);
          setSprintStatus(undefined);
          return;
        }
        // Live sprint: the seed carries only ids + labels (status is never persisted), so without this the breadcrumb
        // chip is missing after every restart until a manual re-pick.
        setSprintStatus(r.value.status);
      })
      .catch(() => {
        // Swallow — a probe failure must never break the TUI boot. The seeded sprint stays in
        // place; Home's own load may surface a fresh error if the entity is unreachable.
      });
    return (): void => {
      cancelled = true;
    };
  }, [seedSprintId, sprintIdRef, setSprintId, setSprintLabel, setSprintStatus]);
};

/**
 * Raw state + setters {@link useSelectionSetters} needs — the `useState` setters are passed directly (stable by
 * construction) rather than re-wrapped.
 */
interface UseSelectionSettersArgs {
  readonly projectIdRef: React.RefObject<ProjectId | undefined>;
  readonly sprintIdRef: React.RefObject<SprintId | undefined>;
  readonly setProjectId: React.Dispatch<React.SetStateAction<ProjectId | undefined>>;
  readonly setSprintId: React.Dispatch<React.SetStateAction<SprintId | undefined>>;
  readonly setProjectLabel: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setSprintLabel: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setSprintStatus: React.Dispatch<React.SetStateAction<SprintStatus | undefined>>;
  readonly setLastSwitch: React.Dispatch<React.SetStateAction<LastSprintSwitch | undefined>>;
  readonly skipNextPersist: (tuple: SkipPersistTuple) => void;
}

interface SelectionSetters {
  readonly setProject: SelectionApi['setProject'];
  readonly setSprint: SelectionApi['setSprint'];
  readonly syncSprintStatus: SelectionApi['syncSprintStatus'];
  readonly setProjectAndSprint: SelectionApi['setProjectAndSprint'];
  readonly followFocusedRun: SelectionApi['followFocusedRun'];
}

const useSelectionSetters = (args: UseSelectionSettersArgs): SelectionSetters => {
  const {
    projectIdRef,
    sprintIdRef,
    setProjectId,
    setSprintId,
    setProjectLabel,
    setSprintLabel,
    setSprintStatus,
    setLastSwitch,
    skipNextPersist,
  } = args;

  const setProject = useCallback(
    (id: ProjectId | undefined, label?: string) => {
      const changed = id !== projectIdRef.current;
      setProjectId(id);
      setProjectLabel(id === undefined ? undefined : label);
      // Only clear the sprint cursor when the project actually changes.
      if (changed) {
        setSprintId(undefined);
        setSprintLabel(undefined);
        setSprintStatus(undefined);
      }
    },
    [projectIdRef, setProjectId, setProjectLabel, setSprintId, setSprintLabel, setSprintStatus]
  );

  const setSprint = useCallback(
    (id: SprintId | undefined, label?: string, status?: SprintStatus) => {
      setSprintId(id);
      setSprintLabel(id === undefined ? undefined : label);
      setSprintStatus(id === undefined ? undefined : status);
      // Record the switch so Home's transient feedback line can flash.
      if (id !== undefined) {
        setLastSwitch({ sprintId: id, sprintLabel: label ?? String(id), at: Date.now() });
      }
    },
    [setSprintId, setSprintLabel, setSprintStatus, setLastSwitch]
  );

  const syncSprintStatus = useCallback(
    (id: SprintId, status: SprintStatus) => {
      // Ref check (not a dep) keeps the setter identity stable AND makes the guard live: a
      // snapshot loaded for sprint A must never restamp the chip after the user picked sprint B.
      if (sprintIdRef.current !== id) return;
      // Functional update so an unchanged status bails out without a re-render — callers fire
      // this on every snapshot load.
      setSprintStatus((prev) => (prev === status ? prev : status));
    },
    [sprintIdRef, setSprintStatus]
  );

  const setProjectAndSprint = useCallback(
    (pId: ProjectId, pLabel: string, sId: SprintId, sLabel: string, sStatus?: SprintStatus) => {
      // React batches the five setState calls inside a single event handler — onChange's
      // effect runs once after the batch, with both ids visible together.
      setProjectId(pId);
      setProjectLabel(pLabel);
      setSprintId(sId);
      setSprintLabel(sLabel);
      setSprintStatus(sStatus);
      setLastSwitch({ sprintId: sId, sprintLabel: sLabel, at: Date.now() });
    },
    [setProjectId, setProjectLabel, setSprintId, setSprintLabel, setSprintStatus, setLastSwitch]
  );

  const followFocusedRun = useCallback(
    (pId: ProjectId, pLabel: string, sId: SprintId, sLabel: string) => {
      // Record the exact tuple being written before the state writes below.
      skipNextPersist({ projectId: pId, projectLabel: pLabel, sprintId: sId, sprintLabel: sLabel });
      setProjectId(pId);
      setProjectLabel(pLabel);
      setSprintId(sId);
      setSprintLabel(sLabel);
      // Status is unknown at focus time (the descriptor only carries ids/labels).
      setSprintStatus(undefined);
      setLastSwitch({ sprintId: sId, sprintLabel: sLabel, at: Date.now() });
    },
    [skipNextPersist, setProjectId, setProjectLabel, setSprintId, setSprintLabel, setSprintStatus, setLastSwitch]
  );

  return { setProject, setSprint, syncSprintStatus, setProjectAndSprint, followFocusedRun };
};

export const SelectionProvider = ({
  children,
  seed,
  onChange,
  sprintRepo,
}: SelectionProviderProps): React.JSX.Element => {
  const [projectId, setProjectId] = useState<ProjectId | undefined>(seed?.projectId);
  const [sprintId, setSprintId] = useState<SprintId | undefined>(seed?.sprintId);
  const [projectLabel, setProjectLabel] = useState<string | undefined>(seed?.projectLabel);
  const [sprintLabel, setSprintLabel] = useState<string | undefined>(seed?.sprintLabel);
  const [sprintStatus, setSprintStatus] = useState<SprintStatus | undefined>(undefined);
  const [lastSwitch, setLastSwitch] = useState<LastSprintSwitch | undefined>(undefined);
  // Mirror projectId in a ref so `setProject` can decide whether the sprint cursor needs
  // clearing without taking `projectId` as a dep (which would re-create the setter every render
  // and force every memoised consumer to re-evaluate).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  // Same mirror for the sprint cursor — lets `syncSprintStatus` and the done-on-boot probe
  // check "is this still the selected sprint?" at resolution time instead of capture time.
  const sprintIdRef = useRef(sprintId);
  sprintIdRef.current = sprintId;

  const { skipNextPersist } = useSelectionPersistence({ projectId, projectLabel, sprintId, sprintLabel }, onChange);

  useDoneOnBootClear({
    seedSprintId: seed?.sprintId,
    sprintRepo,
    sprintIdRef,
    setSprintId,
    setSprintLabel,
    setSprintStatus,
  });

  const { setProject, setSprint, syncSprintStatus, setProjectAndSprint, followFocusedRun } = useSelectionSetters({
    projectIdRef,
    sprintIdRef,
    setProjectId,
    setSprintId,
    setProjectLabel,
    setSprintLabel,
    setSprintStatus,
    setLastSwitch,
    skipNextPersist,
  });

  const api = useMemo<SelectionApi>(
    () => ({
      projectId,
      sprintId,
      projectLabel,
      sprintLabel,
      sprintStatus,
      lastSwitch,
      setProject,
      setSprint,
      syncSprintStatus,
      setProjectAndSprint,
      followFocusedRun,
    }),
    [
      projectId,
      sprintId,
      projectLabel,
      sprintLabel,
      sprintStatus,
      lastSwitch,
      setProject,
      setSprint,
      syncSprintStatus,
      setProjectAndSprint,
      followFocusedRun,
    ]
  );

  return <SelectionContext.Provider value={api}>{children}</SelectionContext.Provider>;
};

export const useSelection = (): SelectionApi => {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection: must be used inside <SelectionProvider>');
  return ctx;
};
