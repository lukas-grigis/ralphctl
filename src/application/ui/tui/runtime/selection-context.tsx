/**
 * The user's "current selection" — which project and sprint the next flow targets. Labels are cached
 * with the ids so the status bar renders without reloading aggregates.
 *
 * Done-on-boot clear: if the persisted seed's sprint is `done` (per the optional `resolveSprintStatus`
 * lookup), both id and label are cleared asynchronously after first paint — pre-selecting a closed
 * sprint helps nobody — and Home's empty-sprint card takes over.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Sprint, SprintStatus } from '@src/domain/entity/sprint.ts';
import type { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Most-recent "I just switched to this sprint" record, set by every setter that lands on a new sprint
 * id. Home renders a transient "✓ now on <name>" from it (the freshness window lives in Home). Not
 * persisted across boots.
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
  /** Last sprint-switch record; clearing the sprint (`undefined`) does NOT count as a switch. */
  readonly lastSwitch: LastSprintSwitch | undefined;
  setProject(id: ProjectId | undefined, label?: string): void;
  setSprint(id: SprintId | undefined, label?: string, status?: SprintStatus): void;
  /**
   * Toast-free status refresh for the CURRENT sprint: flows transition its status on disk but the
   * cached `sprintStatus` only updates on manual picks, so the breadcrumb chip would go stale. A
   * no-op unless `id` still matches (checked against a live ref, so a stale closure cannot clobber a
   * newer pick); does NOT touch `lastSwitch`, so a chip refresh never replays the "✓ now on …" toast.
   */
  syncSprintStatus(id: SprintId, status: SprintStatus): void;
  /**
   * Atomic project + sprint switch for the cross-project picker: `setProject` then `setSprint` would
   * zero the sprint mid-flight and fire `onChange` twice; this fires it once.
   */
  setProjectAndSprint(
    projectId: ProjectId,
    projectLabel: string,
    sprintId: SprintId,
    sprintLabel: string,
    sprintStatus?: SprintStatus
  ): void;
  /**
   * Converge the selection onto a focused Execute run's pinned project/sprint (Tab / Ctrl+1..9 /
   * Sessions-open) so `n → Flows` targets what is on screen. NOT persisted: it fires from a passive
   * focus effect, and a Tab-cycle through old sessions must never overwrite the next boot's default.
   * `lastSwitch` IS recorded — the switch changes what the next launch targets, so it is not silent.
   */
  followFocusedRun(projectId: ProjectId, projectLabel: string, sprintId: SprintId, sprintLabel: string): void;
}

const SelectionContext = createContext<SelectionApi | undefined>(undefined);

export interface SelectionSeed {
  readonly projectId?: ProjectId;
  readonly projectLabel?: string;
  readonly sprintId?: SprintId;
  readonly sprintLabel?: string;
}

/** Slim port for the done-on-boot clear (production: the full sprint repository; tests: a stub). */
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
  /** Best-effort lookup for the seeded sprint's status (see the module doc); a failed lookup never clears. */
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
 * Persist-on-change effect wiring, extracted from {@link SelectionProvider} so the provider
 * itself reads as state + the returned API object. Fires `onChange` whenever the canonical
 * selection changes, skipping the initial render (the launch router may seed an auto-default
 * project/sprint when nothing was persisted; persisting that on mount would freeze the
 * auto-default as if it were a real user choice — a restored real selection is already on disk,
 * so skipping the first write is a harmless no-op there too).
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
  const persist = useEffectEvent((next: SelectionSeed) => onChange?.(next));

  // Set by `followFocusedRun` to the EXACT tuple it is about to write; the effect skips a transition
  // whose current values still match, then clears it. Value-keyed rather than a one-shot flag
  // because the reconciler can coalesce updates into extra/reordered effect passes, letting an
  // unrelated persist "spend" a boolean before the guarded write became visible (an intermittent
  // flake where the converged tuple still reached `onChange`).
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
    persist({
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
 * Done-on-boot clear, extracted from {@link SelectionProvider}. Runs once per seeded sprint id:
 * if `sprintRepo.findById` resolves to a sprint with status `done`, drop both ids so the first
 * paint of Home shows the empty-sprint card. Single-shot per (provider lifetime + seeded id) —
 * re-running on re-render would race against any user-initiated `setSprint` that just happened.
 * The repo lives in a ref so changing its identity doesn't re-trigger the probe.
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
  const readSprintRepo = useEffectEvent(() => sprintRepo);

  useEffect(() => {
    if (seedSprintId === undefined) return undefined;
    const repo = readSprintRepo();
    if (repo === undefined) return undefined;
    let cancelled = false;
    void repo
      .findById(seedSprintId)
      .then((r) => {
        if (cancelled) return;
        // The probe races user input: if a pick landed on a different sprint while findById
        // was in flight, the seed is no longer what's selected — clearing (or restamping)
        // now would clobber the fresh pick AND persist the clobber. Bail via the live ref.
        if (sprintIdRef.current !== seedSprintId) return;
        if (!r.ok) return;
        if (r.value.status === 'done') {
          setSprintId(undefined);
          setSprintLabel(undefined);
          setSprintStatus(undefined);
          return;
        }
        // Live sprint: the seed carries only ids + labels (status is never persisted), so
        // without this the breadcrumb chip is missing after every restart until a manual
        // re-pick. The probe already fetched the entity — keep its status.
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

/** Raw state + setters {@link useSelectionSetters} needs — the `useState` setters are passed
 * directly (stable by construction) rather than re-wrapped. */
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

/**
 * The five selection setters, extracted from {@link SelectionProvider} so the provider itself
 * reads as state + effect-wiring + the final API assembly only.
 */
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
      // Only clear the sprint cursor when the project actually changes. Re-opening the same
      // project (e.g. browsing its detail view, which calls setProject on mount) must not drop
      // a sprint the user picked earlier — they'd lose their place every time they navigated
      // back through the projects list.
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
      // Record the switch so Home's transient feedback line can flash. Clearing (passing
      // `undefined`) is NOT a switch — leaving `lastSwitch` untouched lets the prior record
      // age out naturally instead of replaying its toast.
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
      // Record the exact tuple being written before the state writes below — the persist effect
      // matches on these values (not a one-shot flag) so it reliably skips THIS transition
      // regardless of how many renders land in between.
      skipNextPersist({ projectId: pId, projectLabel: pLabel, sprintId: sId, sprintLabel: sLabel });
      setProjectId(pId);
      setProjectLabel(pLabel);
      setSprintId(sId);
      setSprintLabel(sLabel);
      // Status is unknown at focus time (the descriptor only carries ids/labels) — leave it for
      // the existing Home/Flows `syncSprintStatus` effects to backfill from the next snapshot
      // load, exactly as a fresh manual pick behaves before its first load.
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
