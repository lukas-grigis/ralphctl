import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import {
  type DoctorCtx,
  type DoctorInput,
  type DoctorReport,
  type ProbeResult,
} from '@src/application/flows/doctor/ctx.ts';
import type { DoctorDeps } from '@src/application/flows/doctor/deps.ts';
import {
  probeAiProvidersGroup,
  probeNodeVersion,
  probeRepositoriesAndIntegrityGroup,
  probeSettingsGroup,
  probeStorageGroup,
  probeVcsToolingGroup,
} from '@src/application/flows/doctor/probe-groups.ts';

/**
 * Run the standard sanity probes and report each one's outcome. Always resolves to ok — a
 * failed probe is data, not an error.
 *
 * Probe order is the rendering order. Probes are grouped (see `ProbeGroup`) so the doctor
 * view can stamp section headers without per-probe routing logic.
 */
export const createDoctorFlow = (deps: DoctorDeps): Element<DoctorCtx> =>
  leaf<DoctorCtx, DoctorInput, DoctorReport>('doctor', {
    useCase: {
      async execute(input) {
        // Groups are independent and mostly wait on child processes (`gh auth status`, provider
        // auth probes), so they run concurrently; `Promise.all` keeps the rendering order.
        const groups = await Promise.all([
          probeStorageGroup(input),
          [probeNodeVersion(deps.nodeVersion)],
          probeSettingsGroup(deps),
          probeVcsToolingGroup(deps),
          probeAiProvidersGroup(deps),
          probeRepositoriesAndIntegrityGroup(deps),
        ]);
        const probes: readonly ProbeResult[] = groups.flat();

        const hasFailures = probes.some((p) => p.status === 'fail');
        // 'unknown' rows (the environment can't answer, not a defect) don't count against
        // allPassed — only 'warn' and 'fail' do.
        const allPassed = probes.every((p) => p.status === 'pass' || p.status === 'unknown');
        return Result.ok({ probes, allPassed, hasFailures });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
    label: 'Run checks',
  });
