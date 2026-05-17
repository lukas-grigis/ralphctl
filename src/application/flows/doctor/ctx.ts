import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Minimum Node major version ralphctl supports. Kept in sync with `mise.toml` (node = "24")
 * so the doctor probe surfaces drift between the developer's runtime and what the CLI was
 * built for. Bumping `mise.toml` requires bumping this constant in the same commit.
 */
export const MIN_NODE_MAJOR = 24;

export interface DoctorInput {
  readonly dataRoot: AbsolutePath;
  readonly configRoot: AbsolutePath;
}

export type ProbeStatus = 'pass' | 'fail' | 'warn';

/**
 * Stable group ids used by UIs to render section headers. Renderer-side labels live with the
 * view; keeping ids here means the CLI and TUI both group the same way.
 */
export type ProbeGroup = 'storage' | 'settings' | 'runtime' | 'vcs' | 'ai' | 'repositories' | 'integrity';

export interface ProbeResult {
  readonly id: string;
  readonly label: string;
  readonly status: ProbeStatus;
  readonly detail?: string;
  /**
   * Optional remediation hint surfaced when `status !== 'pass'`. Drives the "suggest setup"
   * UX — e.g. "run welcome", "install <provider> CLI".
   */
  readonly hint?: string;
  /** Section to render the probe under. Probes without a group fall under a generic section. */
  readonly group?: ProbeGroup;
}

export interface DoctorReport {
  readonly probes: readonly ProbeResult[];
  readonly allPassed: boolean;
  /** True iff at least one probe is `'fail'` (warns don't count). */
  readonly hasFailures: boolean;
}

export interface DoctorCtx {
  readonly input: DoctorInput;
  readonly output?: DoctorReport;
}
