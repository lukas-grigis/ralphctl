import {
  aiRowKey,
  type ModelSubstitution,
  type UnavailableModel,
} from '@src/business/settings/adapt-to-available-models.ts';

/** One line per model swap or unservable row an apply-preset made — shared by the CLI and TUI. */
export const presetAdaptationLines = (notices: {
  readonly substitutions: readonly ModelSubstitution[];
  readonly unavailable: readonly UnavailableModel[];
}): readonly string[] => [
  ...notices.substitutions.map((s) => `${aiRowKey(s)}: ${s.from} isn't on your account — using ${s.to}`),
  ...notices.unavailable.map(
    (u) => `${aiRowKey(u)}: ${u.model} isn't on your account and has no stand-in — pick another model`
  ),
];
