/**
 * Tracks the user's "current selection" — which project and which sprint the next flow should
 * target. Updated when the user opens a project / sprint detail screen (or explicitly via the
 * sprint detail's "make current" action). The home view reads this to summarise state and the
 * flow launcher reads it to build chain ctx without re-prompting.
 *
 * Display labels are cached alongside the ids so the status bar can show "proj: foo · sprint:
 * bar" without re-loading the aggregates on every render.
 *
 * Done-on-boot clear: when the persisted seed includes a `sprintId`, the provider asks the
 * caller's `resolveSprintStatus` (best-effort, optional) whether it's `done`. If yes, both the
 * sprint id AND label are cleared before the user lands on Home — there's no value in pre-
 * selecting a closed sprint when the natural next step is to pick or create another. The clear
 * is async + non-blocking: the initial render still uses the seed, but a `setSprint(undefined)`
 * fires once the status is known. Home's empty-sprint card then takes over.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Sprint, SprintStatus } from '@src/domain/entity/sprint.ts';
import type { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Most-recent "I just switched to this sprint" record. Updated by every setter that lands the
 * user on a new sprint id (inline shortcut, picker, sprint-detail `m`, create-sprint reseat).
 * Home reads it to render a transient "✓ now on <name>" line above the menu; the freshness
 * gate (a small window in real-time) lives in Home, not here — the context just records the
 * fact. The record is intentionally NOT persisted across boots; it's purely UI-ephemeral.
 */
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
   * Last sprint-switch record (see {@link LastSprintSwitch}). `undefined` before any switch in
   * this session. Updated whenever `setSprint` / `setProjectAndSprint` lands on a non-undefined
   * id; clearing the sprint (passing `undefined`) does NOT count as a switch and leaves this
   * record unchanged.
   */
  readonly lastSwitch: LastSprintSwitch | undefined;
  setProject(id: ProjectId | undefined, label?: string): void;
  setSprint(id: SprintId | undefined, label?: string, status?: SprintStatus): void;
  /**
   * Atomic project + sprint switch — used by the cross-project sprint picker so picking a
   * sprint from a different project updates both ids in a single state batch. Going through
   * `setProject` then `setSprint` would clear the sprint mid-flight (setProject zeroes the
   * sprint cursor as a side effect) and fire `onChange` twice; this setter fires it once.
   */
  setProjectAndSprint(
    projectId: ProjectId,
    projectLabel: string,
    sprintId: SprintId,
    sprintLabel: string,
    sprintStatus?: SprintStatus
  ): void;
}

const SelectionContext = createContext<SelectionApi | undefined>(undefined);

export interface SelectionSeed {
  readonly projectId?: ProjectId;
  readonly projectLabel?: string;
  readonly sprintId?: SprintId;
  readonly sprintLabel?: string;
}

/**
 * Slim port used by the done-on-boot clear. Production wires this to the full
 * {@link SprintRepository} via `App.tsx`; tests pass an inline stub. Only `findById` is needed
 * — the provider checks the resolved sprint's status and clears the seed when it's `done`.
 */
export interface SprintStatusReader {
  findById(id: SprintId): Promise<Result<Sprint, DomainError>>;
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
  /**
   * Best-effort lookup for the seeded sprint. When provided AND the seed carries a
   * `sprintId`, the provider asks for the sprint once on mount; a `done` status clears both
   * `sprintId` and `sprintLabel` so Home renders the "pick or create a sprint" empty state
   * instead of waving a stale closed sprint at the user. Failures leave the seed in place —
   * we never clear on a transient I/O error.
   */
  readonly sprintRepo?: SprintStatusReader;
}

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
  // Keep the callback in a ref so re-renders don't churn the persistence effect's deps.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Mirror projectId in a ref so `setProject` can decide whether the sprint cursor needs
  // clearing without taking `projectId` as a dep (which would re-create the setter every render
  // and force every memoised consumer to re-evaluate).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Persist whenever the canonical selection changes — but skip the initial render. The launch
  // router may seed an auto-default project/sprint (first project + most-recent sprint) when
  // nothing was persisted; persisting that on mount would freeze the auto-default as if it were
  // a real user choice. A restored real selection is already on disk, so skipping the first
  // write is a harmless no-op there too. Only post-mount selection changes reach the store.
  const isFirstPersist = useRef(true);
  useEffect(() => {
    if (isFirstPersist.current) {
      isFirstPersist.current = false;
      return;
    }
    onChangeRef.current?.({
      ...(projectId !== undefined ? { projectId } : {}),
      ...(projectLabel !== undefined ? { projectLabel } : {}),
      ...(sprintId !== undefined ? { sprintId } : {}),
      ...(sprintLabel !== undefined ? { sprintLabel } : {}),
    });
  }, [projectId, projectLabel, sprintId, sprintLabel]);

  const setProject = useCallback((id: ProjectId | undefined, label?: string) => {
    const changed = id !== projectIdRef.current;
    setProjectId(id);
    setProjectLabel(id === undefined ? undefined : label);
    // Only clear the sprint cursor when the project actually changes. Re-opening the same
    // project (e.g. browsing its detail view, which calls setProject on mount) must not drop
    // a sprint the user picked earlier — they'd lose their place every time they navigated
    // back through the projects list.
    if (changed) {
      setSprintId(undefined);
      setSprintLabel(undefined);
      setSprintStatus(undefined);
    }
  }, []);

  const setSprint = useCallback((id: SprintId | undefined, label?: string, status?: SprintStatus) => {
    setSprintId(id);
    setSprintLabel(id === undefined ? undefined : label);
    setSprintStatus(id === undefined ? undefined : status);
    // Record the switch so Home's transient feedback line can flash. Clearing (passing
    // `undefined`) is NOT a switch — leaving `lastSwitch` untouched lets the prior record
    // age out naturally instead of replaying its toast.
    if (id !== undefined) {
      setLastSwitch({ sprintId: id, sprintLabel: label ?? String(id), at: Date.now() });
    }
  }, []);

  // Done-on-boot clear. Runs once per seeded sprint id: if `sprintRepo.findById` resolves to
  // a sprint with status `done`, drop both ids so the first paint of Home shows the empty-
  // sprint card. The hook is single-shot per (provider lifetime + seeded id) — re-running on
  // re-render would race against any user-initiated `setSprint` that just happened. The repo
  // lives in a ref so changing its identity doesn't re-trigger the probe.
  const sprintRepoRef = useRef(sprintRepo);
  sprintRepoRef.current = sprintRepo;
  const seedSprintId = seed?.sprintId;
  useEffect(() => {
    if (seedSprintId === undefined) return undefined;
    const repo = sprintRepoRef.current;
    if (repo === undefined) return undefined;
    let cancelled = false;
    void repo
      .findById(seedSprintId)
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.value.status === 'done') {
          setSprintId(undefined);
          setSprintLabel(undefined);
          setSprintStatus(undefined);
        }
      })
      .catch(() => {
        // Swallow — a probe failure must never break the TUI boot. The seeded sprint stays in
        // place; Home's own load may surface a fresh error if the entity is unreachable.
      });
    return (): void => {
      cancelled = true;
    };
  }, [seedSprintId]);

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
    []
  );

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
      setProjectAndSprint,
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
      setProjectAndSprint,
    ]
  );

  return <SelectionContext.Provider value={api}>{children}</SelectionContext.Provider>;
};

export const useSelection = (): SelectionApi => {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection: must be used inside <SelectionProvider>');
  return ctx;
};
