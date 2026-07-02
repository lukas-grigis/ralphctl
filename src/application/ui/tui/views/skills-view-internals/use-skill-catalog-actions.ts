/**
 * Action state + handlers for the Skills catalog view — enable / disable / update / update-all,
 * plus the enable/disable flow-picker and destructive-confirm state they drive. Extracted from
 * `skills-view.tsx` so the view stays a thin render + key-dispatch layer; the sequencing rules
 * (when a confirm is required, what "up to date" means) live here where they're one hook away
 * from a unit test.
 *
 * Handlers are module-level functions taking an explicit {@link ActionCtx} rather than closures
 * inside the hook — keeps `useSkillCatalogActions` itself a thin dispatch table and each rule
 * independently readable.
 */

import { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { BUNDLED_SKILLS } from '@src/integration/ai/skills/_engine/registry.ts';
import type {
  SkillCatalogEntry,
  SkillCatalogPort,
  SkillInstallStatus,
} from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { feedback, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';

const LOCALLY_MODIFIED: SkillInstallStatus = 'locally-modified';

export interface PickerState {
  readonly kind: 'enable' | 'disable';
  readonly entry: SkillCatalogEntry;
}

export interface ConfirmState {
  readonly kind: 'disable' | 'update';
  readonly entry: SkillCatalogEntry;
  readonly flows: readonly FlowId[];
}

/** `true` when disabling any of `flows` would discard operator-owned content. */
const isDestructiveDisable = (entry: SkillCatalogEntry, flows: readonly FlowId[]): boolean =>
  flows.some((f) => {
    const status = entry.installs.find((i) => i.flow === f)?.status;
    return status === LOCALLY_MODIFIED || status === 'manual';
  });

/** Flows worth updating for `entry`: already-stale copies, plus edited ones (confirm-gated). */
const updateTargets = (entry: SkillCatalogEntry): readonly FlowId[] =>
  entry.installs.filter((i) => i.status === 'update-available' || i.status === LOCALLY_MODIFIED).map((i) => i.flow);

/** Human title for the destructive-confirm card. */
export const confirmTitle = (cs: ConfirmState): string =>
  cs.kind === 'disable'
    ? `Remove "${cs.entry.name}" for ${String(cs.flows.length)} flow(s)?`
    : `Update "${cs.entry.name}" for ${String(cs.flows.length)} flow(s)?`;

/** Threaded through every module-level handler below — one bag, one signature per handler. */
interface ActionCtx {
  readonly skillCatalog: SkillCatalogPort;
  readonly mountedRef: RefObject<boolean>;
  readonly reload: () => void;
  readonly setBusy: (busy: boolean) => void;
  readonly setActionFeedback: (value: StructuredFeedback | undefined) => void;
  readonly setPicker: (value: PickerState | undefined) => void;
  readonly setConfirmState: (value: ConfirmState | undefined) => void;
}

/** Run one catalog mutation, translate the Result into feedback, and reload the list on success. */
const runCatalogOp = async <T>(
  ctx: ActionCtx,
  op: () => Promise<Result<T, StorageError>>,
  successLabel: (value: T) => string
): Promise<void> => {
  ctx.setBusy(true);
  const r = await op();
  if (!ctx.mountedRef.current) return;
  ctx.setBusy(false);
  if (!r.ok) {
    ctx.setActionFeedback(feedback('error', `${glyphs.cross} ${r.error.message}`));
    return;
  }
  // `r.value`'s static type is a deferred conditional (`typescript-result`'s `ValueOr`) that TS
  // can't collapse for a generic `T` bound only at the call site — same shape as the cast in
  // `integration/io/file-locker.ts`'s `withLock`.
  ctx.setActionFeedback(feedback('success', successLabel(r.value as T)));
  ctx.reload();
};

const doStartEnable = (ctx: ActionCtx, bundledNames: ReadonlySet<string>, entry: SkillCatalogEntry): void => {
  if (!bundledNames.has(entry.name)) {
    ctx.setActionFeedback(feedback('error', `${glyphs.cross} "${entry.name}" is a manual entry — nothing to enable`));
    return;
  }
  ctx.setPicker({ kind: 'enable', entry });
};

const doStartDisable = (ctx: ActionCtx, entry: SkillCatalogEntry): void => {
  if (entry.installs.length === 0) {
    ctx.setActionFeedback(feedback('info', `"${entry.name}" isn't enabled anywhere`));
    return;
  }
  ctx.setPicker({ kind: 'disable', entry });
};

const doSubmitPicker = (ctx: ActionCtx, picker: PickerState | undefined, flows: readonly FlowId[]): void => {
  ctx.setPicker(undefined);
  if (picker === undefined || flows.length === 0) return;
  const { kind, entry } = picker;
  if (kind === 'enable') {
    void runCatalogOp(
      ctx,
      () => ctx.skillCatalog.enable(entry.name, flows),
      () => `${glyphs.check} enabled "${entry.name}" for ${String(flows.length)} flow(s)`
    );
    return;
  }
  if (isDestructiveDisable(entry, flows)) {
    ctx.setConfirmState({ kind: 'disable', entry, flows });
    return;
  }
  void runCatalogOp(
    ctx,
    () => ctx.skillCatalog.disable(entry.name, flows),
    () => `${glyphs.check} disabled "${entry.name}" for ${String(flows.length)} flow(s)`
  );
};

const doRunUpdate = (ctx: ActionCtx, bundledNames: ReadonlySet<string>, entry: SkillCatalogEntry): void => {
  if (!bundledNames.has(entry.name)) {
    ctx.setActionFeedback(feedback('error', `${glyphs.cross} "${entry.name}" is a manual entry — nothing to update`));
    return;
  }
  const targets = updateTargets(entry);
  if (targets.length === 0) {
    ctx.setActionFeedback(feedback('info', `"${entry.name}" is already up to date`));
    return;
  }
  if (targets.some((f) => entry.installs.find((i) => i.flow === f)?.status === LOCALLY_MODIFIED)) {
    ctx.setConfirmState({ kind: 'update', entry, flows: targets });
    return;
  }
  void runCatalogOp(
    ctx,
    () => ctx.skillCatalog.update(entry.name, targets),
    () => `${glyphs.check} updated "${entry.name}" (${String(targets.length)} flow(s))`
  );
};

const doSubmitConfirm = (ctx: ActionCtx, confirmState: ConfirmState | undefined, confirmed: boolean): void => {
  ctx.setConfirmState(undefined);
  if (confirmState === undefined || !confirmed) return;
  const label = (n: number): string =>
    `${glyphs.check} ${confirmState.kind === 'disable' ? 'disabled' : 'updated'} "${confirmState.entry.name}" (${String(n)} flow(s))`;
  const op = confirmState.kind === 'disable' ? ctx.skillCatalog.disable : ctx.skillCatalog.update;
  void runCatalogOp(
    ctx,
    () => op(confirmState.entry.name, confirmState.flows),
    () => label(confirmState.flows.length)
  );
};

const doRunUpdateAll = (ctx: ActionCtx): void => {
  void runCatalogOp(
    ctx,
    () => ctx.skillCatalog.updateAll(),
    (v) =>
      v.updated.length === 0
        ? `${glyphs.refresh} everything is already up to date`
        : `${glyphs.check} updated ${String(v.updated.length)} skill(s): ${v.updated.join(', ')}`
  );
};

export interface UseSkillCatalogActionsResult {
  readonly picker: PickerState | undefined;
  readonly confirmState: ConfirmState | undefined;
  readonly actionFeedback: StructuredFeedback | undefined;
  readonly busy: boolean;
  /** Every `BUNDLED_SKILLS` name — an entry outside this set is a manual (non-bundled) row. */
  readonly bundledNames: ReadonlySet<string>;
  readonly startEnable: (entry: SkillCatalogEntry) => void;
  readonly startDisable: (entry: SkillCatalogEntry) => void;
  readonly runUpdate: (entry: SkillCatalogEntry) => void;
  readonly runUpdateAll: () => void;
  readonly cancelPicker: () => void;
  readonly submitPicker: (flows: readonly FlowId[]) => void;
  readonly submitConfirm: (confirmed: boolean) => void;
  readonly flashInfo: (text: string) => void;
}

export const useSkillCatalogActions = (
  skillCatalog: SkillCatalogPort,
  reload: () => void
): UseSkillCatalogActionsResult => {
  const mountedRef = useIsMounted();
  const bundledNames = useMemo(() => new Set(BUNDLED_SKILLS.map((e) => e.name)), []);

  const [picker, setPicker] = useState<PickerState | undefined>(undefined);
  const [confirmState, setConfirmState] = useState<ConfirmState | undefined>(undefined);
  const [actionFeedback, setActionFeedback] = useState<StructuredFeedback | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const ctx: ActionCtx = { skillCatalog, mountedRef, reload, setBusy, setActionFeedback, setPicker, setConfirmState };

  return {
    picker,
    confirmState,
    actionFeedback,
    busy,
    bundledNames,
    startEnable: (entry) => doStartEnable(ctx, bundledNames, entry),
    startDisable: (entry) => doStartDisable(ctx, entry),
    runUpdate: (entry) => doRunUpdate(ctx, bundledNames, entry),
    runUpdateAll: () => doRunUpdateAll(ctx),
    cancelPicker: () => setPicker(undefined),
    submitPicker: (flows) => doSubmitPicker(ctx, picker, flows),
    submitConfirm: (confirmed) => doSubmitConfirm(ctx, confirmState, confirmed),
    flashInfo: (text) => setActionFeedback(feedback('info', text)),
  };
};
