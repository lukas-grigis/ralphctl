import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';

/**
 * Module-level holder for the per-role implement overrides parsed from the bare-`ralphctl`
 * CLI flags. Mirrors the {@link RunInTerminal} pattern — the bootstrap swaps the ref once at
 * launch time, then `flows-view` (and any other implement-launching surface) reads through
 * {@link getImplementRoleOverrides} when assembling its {@link LaunchExtras}.
 *
 * The CLI parser is responsible for validation (rejecting half-supplied provider/model pairs)
 * before storing; this holder only carries already-validated overrides.
 */
type Overrides = NonNullable<LaunchExtras['implementRoleOverrides']>;

const ref: { current: Overrides | undefined } = { current: undefined };

export const setImplementRoleOverrides = (next: Overrides | undefined): void => {
  ref.current = next;
};

export const getImplementRoleOverrides = (): Overrides | undefined => ref.current;
