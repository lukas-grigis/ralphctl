/**
 * Pure row model for the System hub: which children exist, in what order, and the one-line summary each carries.
 */

import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import { housekeepingSummary } from '@src/application/ui/tui/views/housekeeping-rows.ts';
import type { HousekeepingScan } from '@src/business/housekeeping/scan-housekeeping.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import type { ViewId } from '@src/application/ui/tui/views/view-registry.tsx';

export type SummaryTone = 'ok' | 'warn' | 'fail' | 'dim';

export interface SystemRow {
  readonly id: string;
  readonly label: string;
  /** View pushed on `↵`. */
  readonly view: ViewId;
  readonly summary: string;
  readonly tone: SummaryTone;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Summary every row shows until its source answers. */
export const CHECKING = 'checking…';

/** The probe's actual problem (`gh not found on PATH`), falling back to its name when it carries no detail. */
const probeProblem = (probe: { readonly label: string; readonly detail?: string }): string => {
  const line = probe.detail?.split('\n')[0]?.trim();
  return line !== undefined && line.length > 0 ? line : probe.label;
};

export const doctorSummary = (
  report: DoctorReport | undefined,
  loading: boolean
): { readonly summary: string; readonly tone: SummaryTone } => {
  if (report === undefined || loading) return { summary: CHECKING, tone: 'dim' };
  const failing = report.probes.filter((p) => p.status === 'fail');
  const warning = report.probes.filter((p) => p.status === 'warn');
  const first = failing[0] ?? warning[0];
  if (failing.length > 0 && first !== undefined) {
    return {
      summary: `${glyphs.cross} ${String(failing.length)} failing ${glyphs.emDash} ${probeProblem(first)}`,
      tone: 'fail',
    };
  }
  if (warning.length > 0 && first !== undefined) {
    return {
      summary: `${glyphs.warningGlyph} ${String(warning.length)} ${plural(warning.length, 'warning', 'warnings')} ${glyphs.emDash} ${probeProblem(first)}`,
      tone: 'warn',
    };
  }
  return { summary: `${glyphs.check} all ${String(report.probes.length)} checks passed`, tone: 'ok' };
};

export const settingsSummary = (settings: Settings | undefined): string => {
  if (settings === undefined) return 'unavailable';
  const refine = primaryFlowRow(settings.ai, 'refine').model;
  const implement = primaryFlowRow(settings.ai, 'implement').model;
  return `${refine} ${glyphs.bullet} implement ${implement} ${glyphs.bullet} effort ${settings.ai.effort ?? 'default'}`;
};

export const skillsSummary = (entries: readonly SkillCatalogEntry[] | undefined): string => {
  if (entries === undefined) return 'unavailable';
  const enabled = entries.filter((e) => e.installs.length > 0).length;
  const updates = entries.reduce((n, e) => n + e.installs.filter((i) => i.status === 'update-available').length, 0);
  return `${String(entries.length)} bundled ${glyphs.bullet} ${String(enabled)} enabled ${glyphs.bullet} ${String(updates)} ${plural(updates, 'update', 'updates')} available`;
};

export interface SystemRowsInput {
  readonly report: DoctorReport | undefined;
  readonly doctorLoading: boolean;
  /** Settings, skills and housekeeping are still being read. */
  readonly summariesLoading: boolean;
  /** `undefined` while loading or when the read failed. */
  readonly settings: Settings | undefined;
  readonly skills: readonly SkillCatalogEntry[] | undefined;
  /** `undefined` while loading or when the scan failed. */
  readonly housekeeping: HousekeepingScan | undefined;
}

/**
 * The four hub rows — always all four, so a key pressed before the data lands still means the same row. Doctor leads
 * while the last report has a warning or failure; a re-run keeps that order until the new report arrives.
 */
export const buildSystemRows = (input: SystemRowsInput): readonly SystemRow[] => {
  const pending = (summary: () => string): string => (input.summariesLoading ? CHECKING : summary());
  const doctor = doctorSummary(input.report, input.doctorLoading);
  const rows: SystemRow[] = [
    {
      id: 'settings',
      label: 'Settings',
      view: 'settings',
      summary: pending(() => settingsSummary(input.settings)),
      tone: 'dim',
    },
    { id: 'skills', label: 'Skills', view: 'skills', summary: pending(() => skillsSummary(input.skills)), tone: 'dim' },
  ];
  const doctorRow: SystemRow = { id: 'doctor', label: 'Doctor', view: 'doctor', ...doctor };
  const housekeepingRow: SystemRow = {
    id: 'housekeeping',
    label: 'Housekeeping',
    view: 'housekeeping',
    summary: pending(() => housekeepingSummary(input.housekeeping)),
    tone: 'dim',
  };
  const needsAttention = input.report?.probes.some((p) => p.status === 'warn' || p.status === 'fail') ?? false;
  return needsAttention ? [doctorRow, ...rows, housekeepingRow] : [...rows, doctorRow, housekeepingRow];
};
