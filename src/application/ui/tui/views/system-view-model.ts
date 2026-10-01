/**
 * Pure row model for the System hub: which children exist, in what order, and the one-line
 * summary each carries. No React, no I/O — the view loads settings / the skill catalog and hands
 * them in, so ordering and copy are unit-testable.
 *
 * Doctor sorts to the top whenever its report holds a warning or a failure: that is the child that
 * needs the operator, and the hub's `↵` should land on it without a hunt. Everything else keeps
 * the fixed order (Settings, Skills, Doctor, Housekeeping).
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

export const doctorSummary = (
  report: DoctorReport | undefined,
  loading: boolean
): { readonly summary: string; readonly tone: SummaryTone } => {
  if (report === undefined || loading) return { summary: 'running checks…', tone: 'dim' };
  const failing = report.probes.filter((p) => p.status === 'fail');
  const warning = report.probes.filter((p) => p.status === 'warn');
  const first = failing[0] ?? warning[0];
  if (failing.length > 0 && first !== undefined) {
    return {
      summary: `${glyphs.cross} ${String(failing.length)} failing ${glyphs.emDash} ${first.label}`,
      tone: 'fail',
    };
  }
  if (warning.length > 0 && first !== undefined) {
    return {
      summary: `${glyphs.warningGlyph} ${String(warning.length)} ${plural(warning.length, 'warning', 'warnings')} ${glyphs.emDash} ${first.label}`,
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
  /** `undefined` while loading or when the read failed. */
  readonly settings: Settings | undefined;
  readonly skills: readonly SkillCatalogEntry[] | undefined;
  /** `undefined` while loading or when the scan failed. */
  readonly housekeeping: HousekeepingScan | undefined;
}

export const buildSystemRows = (input: SystemRowsInput): readonly SystemRow[] => {
  const doctor = doctorSummary(input.report, input.doctorLoading);
  const rows: SystemRow[] = [
    { id: 'settings', label: 'Settings', view: 'settings', summary: settingsSummary(input.settings), tone: 'dim' },
    { id: 'skills', label: 'Skills', view: 'skills', summary: skillsSummary(input.skills), tone: 'dim' },
  ];
  const doctorRow: SystemRow = { id: 'doctor', label: 'Doctor', view: 'doctor', ...doctor };
  const housekeepingRow: SystemRow = {
    id: 'housekeeping',
    label: 'Housekeeping',
    view: 'housekeeping',
    summary: housekeepingSummary(input.housekeeping),
    tone: 'dim',
  };
  const needsAttention = doctor.tone === 'warn' || doctor.tone === 'fail';
  return needsAttention ? [doctorRow, ...rows, housekeepingRow] : [...rows, doctorRow, housekeepingRow];
};
