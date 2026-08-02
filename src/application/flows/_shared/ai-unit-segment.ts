/**
 * Shared six-leaf bracket every interactive-AI-authoring flow (refine, plan, ideate, create-pr)
 * hand-rolls around its own AI leaf:
 *
 *   build-<unit>-unit → render-prompt-to-file → install-skills → stamp-meta-<unit>
 *     → <the flow's own AI leaf> →
 *   uninstall-skills
 *
 * `aiUnitPrelude` returns the first four elements (materialise the per-run sandbox, render the
 * prompt into it, install skills, stamp `meta.json`); `aiUnitEpilogue` returns the trailing
 * `uninstall-skills`. Both return arrays (not a wrapping `sequential`) so a flow splices them
 * directly around its own AI leaf without introducing an extra named node in the trace — the
 * emitted element names match what each flow already produced before this bracket existed.
 *
 * Each flow builds ONE opts object and passes it to both calls — `aiUnitEpilogue` only reads
 * `cwdPicker` / `nameSuffix` off it, but sharing the object (rather than re-deriving the picker)
 * guarantees install and uninstall always target the same sandbox, which is the invariant
 * {@link uninstallSkillsLeaf} documents as a caller responsibility.
 */

import { join } from 'node:path';
import { type Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Element } from '@src/application/chain/element.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
import { buildUnitLeaf } from '@src/application/flows/_shared/build-unit.ts';
import { renderPromptToFileLeaf } from '@src/application/flows/_shared/render-prompt-to-file.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';
import { stampSessionMetaLeaf } from '@src/application/flows/_shared/stamp-session-meta.ts';
import { unitRootCwdPicker } from '@src/application/flows/_shared/unit-root-cwd-picker.ts';

/**
 * Narrow structural ctx shape every flow that runs this bracket already satisfies. `refine` /
 * `plan` / `ideate` declare all three fields on their concrete ctx; `create-pr` declares only
 * `currentUnitRoot` / `currentPromptFile` today — it is still structurally compatible because
 * `currentOutputFile` is optional, and after this bracket runs its ctx carries the field at
 * runtime even though `CreatePrCtx` does not name it yet.
 *
 * @public
 */
export interface AiUnitCtx {
  readonly currentUnitRoot?: AbsolutePath;
  readonly currentPromptFile?: AbsolutePath;
  readonly currentOutputFile?: AbsolutePath;
}

export interface AiUnitSegmentDeps {
  readonly writeFile: WriteFile;
  readonly skillsAdapter: SkillsAdapter;
  readonly skillSource: SkillSource;
  /** ISO timestamp source — stamped onto the `meta.json` sidecar. */
  readonly clock: () => IsoTimestamp;
}

export interface AiUnitSegmentOpts<TCtx extends AiUnitCtx> {
  /**
   * Bracket-naming stem — element names follow `build-<unitName>-unit` / `stamp-meta-<unitName>`,
   * matching each flow's pre-existing names (`refine`, `plan`, `ideate`, `create-pr`).
   */
  readonly unitName: string;
  /** Skills-registry flow id — `installSkillsLeaf` resolves the bundled skill set for it. */
  readonly flowId: FlowId;
  /**
   * Per-item suffix appended to every element name this bracket emits — e.g. `-${ticketId}` for
   * refine's per-ticket fan-out. Omit for single-shot flows (plan / ideate / create-pr).
   */
  readonly nameSuffix?: string;
  /** Resolve the unit's parent directory at execute time. Typically `<sprintDir>/<flow>/`. */
  readonly parent: (ctx: TCtx) => AbsolutePath;
  /** Resolve the unit's sub-folder name. URL-safe; the caller sanitises. */
  readonly slug: (ctx: TCtx) => string;
  /** Build the rendered prompt from ctx. Runs inside `render-prompt-to-file`. */
  readonly buildPrompt: (ctx: TCtx) => Promise<Result<Prompt, DomainError>>;
  /** Provider id attributed on the `meta.json` sidecar. */
  readonly providerId: string;
  /** Model attributed on the `meta.json` sidecar. */
  readonly model: string;
  /** Effort / reasoning level attributed on the `meta.json` sidecar — optional. */
  readonly effort?: string;
  /**
   * Override where install-skills / uninstall-skills run. Defaults to the unit-root sandbox
   * (`ctx.currentUnitRoot`, via {@link unitRootCwdPicker}) — ideate overrides this to the repo
   * cwd instead, since provider-native skill discovery only auto-loads from cwd.
   */
  readonly cwdPicker?: (ctx: TCtx) => AbsolutePath;
  /** Source ticket id, when the spawn is per-ticket (refine) — threaded onto `meta.json`. */
  readonly ticketId?: string;
}

const suffixOf = <TCtx extends AiUnitCtx>(opts: Pick<AiUnitSegmentOpts<TCtx>, 'nameSuffix'>): string =>
  opts.nameSuffix ?? '';

const resolveCwdPicker = <TCtx extends AiUnitCtx>(
  opts: Pick<AiUnitSegmentOpts<TCtx>, 'cwdPicker'>,
  leafName: string
): ((ctx: TCtx) => AbsolutePath) => opts.cwdPicker ?? unitRootCwdPicker<TCtx>(leafName);

/**
 * `build-<unit>-unit` → `render-prompt-to-file` → `install-skills` → `stamp-meta-<unit>`.
 * Spread directly into the surrounding `sequential`'s children, immediately before the flow's
 * own AI leaf.
 */
export const aiUnitPrelude = <TCtx extends AiUnitCtx>(
  deps: AiUnitSegmentDeps,
  opts: AiUnitSegmentOpts<TCtx>
): ReadonlyArray<Element<TCtx>> => {
  const suffix = suffixOf(opts);
  const renderName = `render-prompt-to-file${suffix}`;
  const installName = `install-skills${suffix}`;
  const stampName = `stamp-meta-${opts.unitName}${suffix}`;

  return [
    buildUnitLeaf<TCtx>({
      name: `build-${opts.unitName}-unit${suffix}`,
      parent: opts.parent,
      slug: opts.slug,
      write: (ctx, root) => {
        const promptPath = AbsolutePath.parse(join(String(root), 'prompt.md'));
        // audit-[09]: the AI writes `signals.json` directly under the unit root; the flow's own
        // leaf validates that file via its output contract.
        const outputPath = AbsolutePath.parse(join(String(root), 'signals.json'));
        if (!promptPath.ok) throw promptPath.error;
        if (!outputPath.ok) throw outputPath.error;
        return {
          ...ctx,
          currentUnitRoot: root,
          currentPromptFile: promptPath.value,
          currentOutputFile: outputPath.value,
        } as TCtx;
      },
    }),
    renderPromptToFileLeaf<TCtx>(
      { writeFile: deps.writeFile },
      {
        name: renderName,
        path: (ctx) => assertCtxField(ctx, 'currentPromptFile', renderName, 'pre-render-prompt'),
        buildPrompt: opts.buildPrompt,
        write: (ctx, path) => ({ ...ctx, currentPromptFile: path }) as TCtx,
      }
    ),
    installSkillsLeaf<TCtx>(
      { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
      { name: installName, flowId: opts.flowId, cwdPicker: resolveCwdPicker(opts, installName) }
    ),
    stampSessionMetaLeaf<TCtx>(
      { writeFile: deps.writeFile, clock: deps.clock },
      {
        name: stampName,
        resolve: (ctx) => ({
          outputDir: assertCtxField(ctx, 'currentUnitRoot', stampName, 'pre-stamp-meta'),
          flow: opts.unitName,
          provider: opts.providerId,
          model: opts.model,
          effort: opts.effort ?? null,
          ...(opts.ticketId !== undefined ? { ticketId: opts.ticketId } : {}),
        }),
      }
    ),
  ];
};

/**
 * Trailing `uninstall-skills` — reads the SAME `cwdPicker` / `nameSuffix` an equivalent
 * {@link aiUnitPrelude} call was given so install and uninstall always target one sandbox.
 */
export const aiUnitEpilogue = <TCtx extends AiUnitCtx>(
  deps: Pick<AiUnitSegmentDeps, 'skillsAdapter'>,
  opts: AiUnitSegmentOpts<TCtx>
): ReadonlyArray<Element<TCtx>> => {
  const uninstallName = `uninstall-skills${suffixOf(opts)}`;
  return [
    uninstallSkillsLeaf<TCtx>(
      { skillsAdapter: deps.skillsAdapter },
      { name: uninstallName, cwdPicker: resolveCwdPicker(opts, uninstallName) }
    ),
  ];
};
