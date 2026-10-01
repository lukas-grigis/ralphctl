import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';

/** Module-level holder for the per-role implement overrides parsed from the bare-`ralphctl` CLI flags. */
type Overrides = NonNullable<LaunchExtras['implementRoleOverrides']>;

const ref: { current: Overrides | undefined } = { current: undefined };

export const setImplementRoleOverrides = (next: Overrides | undefined): void => {
  ref.current = next;
};

export const getImplementRoleOverrides = (): Overrides | undefined => ref.current;
