/**
 * `createSkillCatalog` — the concrete {@link SkillCatalogPort} implementation. Drives the TUI
 * skill catalog view: one row per bundled skill (`list()`), copy-on-{@link enable}, folder
 * removal on {@link disable}, and re-stamp-on-{@link update} / {@link updateAll}.
 *
 * The catalog's single unit of truth is the filesystem, exactly as the port's module doc
 * describes: a skill is "enabled for a flow" iff `<operatorSkillsRoot>/<flowDir>/<name>/` exists.
 * This module never touches the bundled skill folders directly — reads go through the injected
 * {@link BundledSkillRawReader} port so the raw bytes copied into a phase folder are byte-for-byte
 * identical to the bundled origin (required for the provenance hash to mean anything; see
 * `phase/provenance.ts`).
 *
 * Folders that exist under a phase dir but don't match any `BUNDLED_SKILLS` entry are surfaced as
 * `manual` catalog rows — the operator dropped them in by hand, and `list()` still reports them
 * (they load exactly like a catalog-managed skill) even though `enable` / `update` have no
 * bundled content to compare them against. `disable` still works on a manual row: it only ever
 * touches `<operatorSkillsRoot>/<flowDir>/<name>/`, never the provider-scoped operator skills at
 * `<operatorSkillsRoot>/<providerDir>/<name>/` (a completely different subtree — see
 * `operator/source.ts`), so removing a manual phase-folder entry stays within "the catalog's own
 * scope" even though the folder wasn't catalog-authored.
 *
 * Helper functions below take an explicit {@link CatalogCtx} rather than closing over `deps`
 * directly — keeps each one independently readable/testable-in-isolation and the top-level
 * factory a thin dispatch table.
 */

import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { removeDir } from '@src/integration/io/fs.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';
import { BUNDLED_SKILLS, type FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { errorCode, parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';
import type {
  SkillCatalogEntry,
  SkillCatalogInstall,
  SkillCatalogPort,
  SkillInstallStatus,
} from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import type { BundledSkillRawReader } from '@src/integration/ai/skills/_engine/bundled-skill-raw-reader.ts';
import { PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';
import {
  createProvenanceStore,
  deriveStatus,
  hashSkillContent,
  type ProvenanceStamp,
  type ProvenanceStore,
} from '@src/integration/ai/skills/phase/provenance.ts';

/** @public */
export interface SkillCatalogDeps {
  /** `<appRoot>/skills` — the same global root `createPhaseSkillSource` reads. */
  readonly operatorSkillsRoot: AbsolutePath;
  /** Atomic write seam — same instance the composition root threads through `AppDeps.writeFile`. */
  readonly writeFile: WriteFile;
  /** Raw-bytes reader over the bundled skill folders (see the port's module doc for why). */
  readonly bundledRawReader: BundledSkillRawReader;
  readonly logger: Logger;
}

/** Shared context threaded through the module-level helpers below. */
interface CatalogCtx {
  readonly operatorSkillsRoot: AbsolutePath;
  readonly writeFile: WriteFile;
  readonly provenanceStore: ProvenanceStore;
}

/** One install's resolved raw bytes + status, or `undefined` when the folder doesn't exist. */
interface ExistingInstall {
  readonly raw: string;
  readonly status: SkillInstallStatus;
}

/**
 * The installs found for one skill name, plus the raw bytes of the first one found (if any) —
 * the manual-entry path uses that raw content to derive a description since it has no bundled
 * counterpart.
 */
interface InstallsForName {
  readonly installs: readonly SkillCatalogInstall[];
  readonly firstRaw: string | undefined;
}

const skillDirPath = (ctx: CatalogCtx, flowId: FlowId, name: string): string =>
  join(String(ctx.operatorSkillsRoot), PHASE_FLOW_DIR[flowId], name);

/**
 * Read `<skillDir>/SKILL.md` + its provenance stamp and derive the install's status.
 * `currentBundledRaw === undefined` means "no bundled counterpart to compare against" (a manual
 * entry) — status collapses to `'manual'` regardless of any stamp found. Returns
 * `Result.ok(undefined)` when the folder simply doesn't exist (not an error — the common,
 * expected case for a not-yet-enabled flow).
 */
const readInstall = async (
  ctx: CatalogCtx,
  flowId: FlowId,
  name: string,
  currentBundledRaw: string | undefined
): Promise<Result<ExistingInstall | undefined, StorageError>> => {
  const dirStr = skillDirPath(ctx, flowId, name);
  const skillMdPath = join(dirStr, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(skillMdPath, 'utf-8');
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return Result.ok(undefined);
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `installed skill not readable: ${skillMdPath}`,
        path: skillMdPath,
        cause,
      })
    );
  }
  const dirAbs = AbsolutePath.parse(dirStr);
  if (!dirAbs.ok) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `install path not absolute: ${dirStr}`, path: dirStr })
    );
  }
  const stampR = await ctx.provenanceStore.readProvenance(dirAbs.value);
  if (!stampR.ok) return Result.error(stampR.error);
  const status: SkillInstallStatus =
    currentBundledRaw === undefined
      ? 'manual'
      : deriveStatus({ folderSkillMdRaw: raw, stamp: stampR.value, currentBundledRaw });
  return Result.ok({ raw, status });
};

/** Copy `raw` verbatim into `<flowDir>/<name>/SKILL.md` and (re-)write its provenance stamp. */
const writeInstall = async (
  ctx: CatalogCtx,
  flowId: FlowId,
  name: string,
  raw: string
): Promise<Result<void, StorageError>> => {
  const dirStr = skillDirPath(ctx, flowId, name);
  const dirAbs = AbsolutePath.parse(dirStr);
  if (!dirAbs.ok) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `install path not absolute: ${dirStr}`, path: dirStr })
    );
  }
  const skillMdAbs = AbsolutePath.parse(join(dirStr, 'SKILL.md'));
  if (!skillMdAbs.ok) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `install SKILL.md path not absolute: ${dirStr}`, path: dirStr })
    );
  }
  const written = await ctx.writeFile(skillMdAbs.value, raw);
  if (!written.ok) return written;
  const stamp: ProvenanceStamp = {
    source: 'bundled',
    skill: name,
    contentHash: hashSkillContent(raw),
    ralphctlVersion: CLI_METADATA.currentVersion,
    copiedAt: new Date().toISOString(),
  };
  return ctx.provenanceStore.writeProvenance(dirAbs.value, stamp);
};

/** Enumerate the skill-folder names present under one flow's phase dir. Missing dir → `[]`. */
const listInstalledNames = async (
  ctx: CatalogCtx,
  flowId: FlowId
): Promise<Result<readonly string[], StorageError>> => {
  const flowRoot = join(String(ctx.operatorSkillsRoot), PHASE_FLOW_DIR[flowId]);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(flowRoot, { withFileTypes: true });
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return Result.ok([]);
    return Result.error(
      new StorageError({ subCode: 'io', message: `phase skills dir not readable: ${flowRoot}`, path: flowRoot, cause })
    );
  }
  return Result.ok(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name));
};

/** Snapshot every phase dir's installed folder names, keyed by flow. */
const readAllInstalledNames = async (
  ctx: CatalogCtx
): Promise<Result<ReadonlyMap<FlowId, readonly string[]>, StorageError>> => {
  const perFlowNames = new Map<FlowId, readonly string[]>();
  for (const flowId of FLOW_IDS) {
    const namesR = await listInstalledNames(ctx, flowId);
    if (!namesR.ok) return Result.error(namesR.error);
    perFlowNames.set(flowId, namesR.value);
  }
  return Result.ok(perFlowNames);
};

/**
 * Resolve every flow's install for `name` (skipping flows where no folder is present).
 * `currentBundledRaw` is `undefined` for a manual entry — see {@link readInstall}. Also returns
 * the raw bytes of the first install found so the manual-entry path can derive a description.
 */
const buildInstalls = async (
  ctx: CatalogCtx,
  perFlowNames: ReadonlyMap<FlowId, readonly string[]>,
  name: string,
  currentBundledRaw: string | undefined
): Promise<Result<InstallsForName, StorageError>> => {
  const installs: SkillCatalogInstall[] = [];
  let firstRaw: string | undefined;
  for (const flowId of FLOW_IDS) {
    if (!(perFlowNames.get(flowId) ?? []).includes(name)) continue;
    const installR = await readInstall(ctx, flowId, name, currentBundledRaw);
    if (!installR.ok) return Result.error(installR.error);
    if (installR.value === undefined) {
      // The folder was listed by readdir but holds no readable SKILL.md — an interrupted copy
      // (or a delete race). Surface it as `broken` instead of dropping it: invisible, it would
      // be an undeletable ghost that the phase source warns about on every launch.
      installs.push({ flow: flowId, status: 'broken' });
      continue;
    }
    installs.push({ flow: flowId, status: installR.value.status });
    if (firstRaw === undefined) firstRaw = installR.value.raw;
  }
  return Result.ok({ installs, firstRaw });
};

/**
 * Pure: `SKILL.md` frontmatter description for `name`, or `''` when the body doesn't parse.
 * `onInvalid` (when supplied) receives the parse error message so the caller can log it — kept
 * out-of-band so this stays a plain value function.
 */
const descriptionFromRaw = (name: string, raw: string, onInvalid?: (message: string) => void): string => {
  const parsed = parseSkill('skill', name, name, raw);
  if (parsed.ok) return parsed.value.description;
  onInvalid?.(parsed.error.message);
  return '';
};

/** Pure: names present under any phase dir that aren't claimed by a registered bundled skill. */
const collectManualNames = (
  perFlowNames: ReadonlyMap<FlowId, readonly string[]>,
  claimedNames: ReadonlySet<string>
): readonly string[] => {
  const manual = new Set<string>();
  for (const flowId of FLOW_IDS) {
    for (const name of perFlowNames.get(flowId) ?? []) {
      if (!claimedNames.has(name)) manual.add(name);
    }
  }
  return [...manual].sort();
};

/** One `BUNDLED_SKILLS` row → its catalog entry, given the flow-name snapshot already read. */
const buildBundledEntry = async (
  ctx: CatalogCtx,
  log: Logger,
  perFlowNames: ReadonlyMap<FlowId, readonly string[]>,
  registryEntry: (typeof BUNDLED_SKILLS)[number],
  bundledRawReader: BundledSkillRawReader
): Promise<Result<SkillCatalogEntry, StorageError>> => {
  const bundledR = await bundledRawReader.readRaw(registryEntry.name);
  if (!bundledR.ok) return Result.error(bundledR.error);
  const installsR = await buildInstalls(ctx, perFlowNames, registryEntry.name, bundledR.value);
  if (!installsR.ok) return Result.error(installsR.error);
  const description = descriptionFromRaw(registryEntry.name, bundledR.value, (message) =>
    log.warn('bundled skill frontmatter invalid, showing without a description', {
      name: registryEntry.name,
      error: message,
    })
  );
  return Result.ok({
    name: registryEntry.name,
    description,
    defaultFor: registryEntry.defaultFor,
    recommendedFor: registryEntry.recommendedFor,
    installs: installsR.value.installs,
  });
};

/** One hand-dropped (non-bundled) phase-folder name → its `manual` catalog entry. */
const buildManualEntry = async (
  ctx: CatalogCtx,
  perFlowNames: ReadonlyMap<FlowId, readonly string[]>,
  name: string
): Promise<Result<SkillCatalogEntry, StorageError>> => {
  const installsR = await buildInstalls(ctx, perFlowNames, name, undefined);
  if (!installsR.ok) return Result.error(installsR.error);
  const description = installsR.value.firstRaw !== undefined ? descriptionFromRaw(name, installsR.value.firstRaw) : '';
  return Result.ok({ name, description, defaultFor: [], recommendedFor: [], installs: installsR.value.installs });
};

const buildCatalogList = async (
  ctx: CatalogCtx,
  log: Logger,
  bundledRawReader: BundledSkillRawReader
): Promise<Result<readonly SkillCatalogEntry[], StorageError>> => {
  const perFlowNamesR = await readAllInstalledNames(ctx);
  if (!perFlowNamesR.ok) return Result.error(perFlowNamesR.error);
  const perFlowNames = perFlowNamesR.value;

  const entries: SkillCatalogEntry[] = [];
  const claimedNames = new Set<string>();
  for (const registryEntry of BUNDLED_SKILLS) {
    claimedNames.add(registryEntry.name);
    const entryR = await buildBundledEntry(ctx, log, perFlowNames, registryEntry, bundledRawReader);
    if (!entryR.ok) return Result.error(entryR.error);
    entries.push(entryR.value);
  }
  for (const name of collectManualNames(perFlowNames, claimedNames)) {
    const entryR = await buildManualEntry(ctx, perFlowNames, name);
    if (!entryR.ok) return Result.error(entryR.error);
    entries.push(entryR.value);
  }
  return Result.ok(entries);
};

/** Enable path shared by `enable()`: copy unless the existing install is operator-owned. */
const enableForFlow = async (
  ctx: CatalogCtx,
  flowId: FlowId,
  name: string,
  bundledRaw: string
): Promise<Result<'copied' | 'skipped', StorageError>> => {
  const existingR = await readInstall(ctx, flowId, name, bundledRaw);
  if (!existingR.ok) return Result.error(existingR.error);
  // Never clobber operator-owned content: a hand-dropped folder (`manual`) or a copy the
  // operator has since edited (`locally-modified`) is left untouched and reported as skipped —
  // the caller routes through `update` (with confirmation) if it really means to overwrite.
  // Exception: an unstamped copy whose bytes EQUAL the current bundle is a stranded pristine
  // copy (interrupted stamp write), not operator content — re-writing it loses nothing and
  // repairs the missing sidecar, so a retried enable self-heals instead of no-oping forever.
  if (existingR.value?.status === 'manual' && existingR.value.raw === bundledRaw) {
    const repaired = await writeInstall(ctx, flowId, name, bundledRaw);
    return repaired.ok ? Result.ok('copied') : repaired;
  }
  if (existingR.value?.status === 'manual' || existingR.value?.status === 'locally-modified') {
    return Result.ok('skipped');
  }
  const written = await writeInstall(ctx, flowId, name, bundledRaw);
  return written.ok ? Result.ok('copied') : written;
};

export const createSkillCatalog = (deps: SkillCatalogDeps): SkillCatalogPort => {
  const ctx: CatalogCtx = {
    operatorSkillsRoot: deps.operatorSkillsRoot,
    writeFile: deps.writeFile,
    provenanceStore: createProvenanceStore({ writeFile: deps.writeFile }),
  };
  const log = deps.logger.named('skills.catalog');

  return {
    list: () => buildCatalogList(ctx, log, deps.bundledRawReader),

    async enable(
      name: string,
      flows: readonly FlowId[]
    ): Promise<Result<{ readonly copied: readonly FlowId[]; readonly skipped: readonly FlowId[] }, StorageError>> {
      const bundledR = await deps.bundledRawReader.readRaw(name);
      if (!bundledR.ok) return Result.error(bundledR.error);
      const copied: FlowId[] = [];
      const skipped: FlowId[] = [];
      for (const flowId of flows) {
        const r = await enableForFlow(ctx, flowId, name, bundledR.value);
        if (!r.ok) return Result.error(r.error);
        (r.value === 'copied' ? copied : skipped).push(flowId);
      }
      return Result.ok({ copied, skipped });
    },

    async disable(name: string, flows: readonly FlowId[]): Promise<Result<void, StorageError>> {
      for (const flowId of flows) {
        const removed = await removeDir(skillDirPath(ctx, flowId, name));
        // NotFoundError ("already absent") is the documented no-op case — fall through.
        if (!removed.ok && removed.error.code !== ErrorCode.NotFound) {
          return Result.error(removed.error);
        }
      }
      return Result.ok(undefined);
    },

    async update(name: string, flows: readonly FlowId[]): Promise<Result<void, StorageError>> {
      const bundledR = await deps.bundledRawReader.readRaw(name);
      if (!bundledR.ok) return Result.error(bundledR.error);
      for (const flowId of flows) {
        const written = await writeInstall(ctx, flowId, name, bundledR.value);
        if (!written.ok) return written;
      }
      return Result.ok(undefined);
    },

    async updateAll(): Promise<Result<{ readonly updated: readonly string[] }, StorageError>> {
      const updated = new Set<string>();
      for (const registryEntry of BUNDLED_SKILLS) {
        const bundledR = await deps.bundledRawReader.readRaw(registryEntry.name);
        if (!bundledR.ok) return Result.error(bundledR.error);
        for (const flowId of FLOW_IDS) {
          const existingR = await readInstall(ctx, flowId, registryEntry.name, bundledR.value);
          if (!existingR.ok) return Result.error(existingR.error);
          if (existingR.value === undefined || existingR.value.status !== 'update-available') continue;
          const written = await writeInstall(ctx, flowId, registryEntry.name, bundledR.value);
          if (!written.ok) return written;
          updated.add(registryEntry.name);
        }
      }
      return Result.ok({ updated: [...updated] });
    },
  };
};
