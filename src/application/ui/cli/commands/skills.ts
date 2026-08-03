import type { Command } from 'commander';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import { SKILL_MOUNTING_FLOW_IDS } from '@src/application/ui/shared/launcher.ts';
import { BUNDLED_SKILLS } from '@src/integration/ai/skills/_engine/registry.ts';
import type { SkillCatalogEntry, SkillInstallStatus } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import type { AiSkillsSettings } from '@src/domain/entity/settings.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';

/** Resolve a flow's saved opt-out set (`settings.ai.skills.<flow>.disabled`), `undefined`-safe. */
const savedDisabledFrom = (skills: AiSkillsSettings | undefined): ((flowId: FlowId) => ReadonlySet<string>) => {
  const byFlow = new Map<FlowId, ReadonlySet<string>>();
  for (const flowId of FLOW_IDS) byFlow.set(flowId, new Set(skills?.[flowId]?.disabled ?? []));
  return (flowId) => byFlow.get(flowId) ?? new Set();
};

/**
 * Flows where `entry` will actually load on the next run: `defaultFor` minus any saved
 * opt-out, plus any mounting flow carrying a live (non-`broken`) opt-in phase-folder copy.
 * Mirrors the decision tree in the TUI catalog's `flowChipVisual` (same module) without the
 * Ink chip rendering.
 */
const enabledFlowsFor = (
  entry: SkillCatalogEntry,
  savedDisabled: (flowId: FlowId) => ReadonlySet<string>
): readonly FlowId[] =>
  SKILL_MOUNTING_FLOW_IDS.filter((flowId) => {
    if (entry.defaultFor.includes(flowId)) return !savedDisabled(flowId).has(entry.name);
    const install = entry.installs.find((i) => i.flow === flowId);
    return install !== undefined && install.status !== 'broken';
  });

/**
 * Worst-first severity rank for one {@link SkillInstallStatus} — a `Record` over the full union
 * so adding a 6th status without a rank here fails typecheck instead of silently sorting it
 * last. `in-sync` outranks `manual` only to preserve the exact precedence the original
 * `Set.has` fallthrough used; the two never actually co-occur on one entry (a bundled entry's
 * installs are never `manual`, a hand-dropped entry's installs are always `manual`).
 */
const PROVENANCE_RANK: Record<SkillInstallStatus, number> = {
  'locally-modified': 5,
  broken: 4,
  'update-available': 3,
  'in-sync': 2,
  manual: 1,
};

/** One-line label for a single install's status — mirrors the TUI's `statusVisual` switch. */
const provenanceLabel = (status: SkillInstallStatus): string => {
  switch (status) {
    case 'locally-modified':
      return 'locally modified';
    case 'broken':
      return 'broken copy';
    case 'update-available':
      return 'update available';
    case 'in-sync':
      return 'in sync';
    case 'manual':
      return 'manual';
  }
};

/**
 * Provenance/staleness summary across every install of `entry`, worst-first so a
 * locally-modified or broken copy is never masked by a merely update-available sibling. `-` is
 * reserved for the no-install case — the common shape for a skill that only ever loads via
 * `defaultFor` (default loading never goes through the phase folder, so it has no install to
 * report on).
 */
const provenanceFor = (entry: SkillCatalogEntry): string => {
  if (entry.installs.length === 0) return '-';
  const worst = entry.installs.reduce((acc, i) => (PROVENANCE_RANK[i.status] > PROVENANCE_RANK[acc.status] ? i : acc));
  return provenanceLabel(worst.status);
};

const formatSkillLine = (
  entry: SkillCatalogEntry,
  bundledNames: ReadonlySet<string>,
  savedDisabled: (flowId: FlowId) => ReadonlySet<string>
): string => {
  const tier = bundledNames.has(entry.name) ? 'bundled' : 'manual';
  const flowsLabel = enabledFlowsFor(entry, savedDisabled).join(', ') || '-';
  const provenance = provenanceFor(entry);
  return `${entry.name.padEnd(38)}  ${tier.padEnd(8)}  flows: ${flowsLabel.padEnd(44)}  ${provenance.padEnd(18)}  ${entry.description}`;
};

const listSkillsAction = async (): Promise<void> => {
  const { deps } = await bootstrapCli();

  const catalogR = await deps.skillCatalog.list();
  if (!catalogR.ok) {
    fail(catalogR.error.message);
    return;
  }

  if (catalogR.value.length === 0) {
    process.stdout.write('(no skills bundled)\n');
    return;
  }

  // A settings read failure is non-fatal here, mirroring the TUI catalog's posture — the
  // listing still renders, opt-out nuance is just lost (every default reads as enabled).
  const settingsR = await deps.settingsRepo.load();
  const savedDisabled = savedDisabledFrom(settingsR.ok ? settingsR.value.ai.skills : undefined);
  const bundledNames = new Set(BUNDLED_SKILLS.map((e) => e.name));

  const sorted = [...catalogR.value].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    process.stdout.write(`${formatSkillLine(entry, bundledNames, savedDisabled)}\n`);
  }
};

/**
 * Register the `skills` command group.
 *
 *   ralphctl skills list
 *
 * Operator-facing catalog of the bundled skills available to opt in per flow, plus any
 * hand-dropped ("manual") phase-folder skill the operator installed directly. Mirrors
 * `ralphctl agents list` — the CLI-only inspection surface for a catalog the TUI otherwise
 * manages interactively (`Skills` view, hotkey `K`). "Enabled flows" already folds in saved
 * `settings.ai.skills` opt-outs so the column reflects what actually loads next, not just the
 * registry defaults.
 */
export const registerSkillsCommand = (program: Command): void => {
  const skills = program.command('skills').description('inspect the bundled skill catalog');

  skills
    .command('list')
    .description('list bundled + manually-dropped skills, their tier, enabled flows, and provenance')
    .action(listSkillsAction);
};
