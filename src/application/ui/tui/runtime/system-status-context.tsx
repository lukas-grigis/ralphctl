/**
 * Shared system-status context — surfaces the doctor probe and the npm version check to any
 * component that wants to render them (currently the StatusBar's footer info row).
 *
 * Both fetches kick off once on app mount and live for the whole session: doctor is cheap but
 * not instant, and the version check hits the network. Re-running them on every view mount
 * would mean a spinner flash + stale-frame rewrites every time the user navigates. The TUI
 * surfaces a manual reload via the `!` doctor view when freshness matters.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { createDoctorFlow } from '@src/application/flows/doctor/flow.ts';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';
import { commandExists } from '@src/integration/io/command-exists.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import type { VersionCheck } from '@src/business/version/version-check.ts';

export interface SystemStatus {
  /** `undefined` while the probes are running; resolved value once they finish. */
  readonly doctor: DoctorReport | undefined;
  readonly doctorLoading: boolean;
  /** `null` while pending or when no update is available; the check otherwise. */
  readonly version: VersionCheck | null;
}

const SystemStatusContext = createContext<SystemStatus | undefined>(undefined);

export const useSystemStatus = (): SystemStatus => {
  const ctx = useContext(SystemStatusContext);
  if (!ctx) throw new Error('useSystemStatus: must be used inside <SystemStatusProvider>');
  return ctx;
};

/** Detect we're running under a test harness so we skip the async probes entirely. */
const isTestEnvironment = (): boolean =>
  process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !process.stdout.isTTY;

export const SystemStatusProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const testEnv = isTestEnvironment();
  const [doctorReport, setDoctorReport] = useState<DoctorReport | undefined>(undefined);
  // Tests render the provider too — start in the resolved state so the status-bar doesn't show
  // a spinner forever and we don't trigger an extra re-render from `setDoctorLoading(false)`.
  const [doctorLoading, setDoctorLoading] = useState<boolean>(!testEnv);
  const [version, setVersion] = useState<VersionCheck | null>(null);

  // Doctor + version probes can't be hard-aborted: the `DoctorFlow` leaf and `VersionChecker`
  // port don't accept an `AbortSignal`. The `cancelled` flag is therefore a state-write gate,
  // not a true cancellation — in-flight async work completes but its result is dropped. This
  // is acceptable because the provider mounts once per app lifecycle and only unmounts at app
  // exit (process is dying anyway). If/when those ports gain signal support, plumb an
  // AbortController through here.
  useEffect(() => {
    if (testEnv) return undefined;
    let cancelled = false;
    setDoctorLoading(true);
    void (async (): Promise<void> => {
      try {
        const flow = createDoctorFlow({
          projectRepo: deps.projectRepo,
          sprintRepo: deps.sprintRepo,
          sprintExecutionRepo: deps.sprintExecutionRepo,
          settingsRepo: deps.settingsRepo,
          commandExists,
          runCommand,
          nodeVersion: process.version,
        });
        const report = await flow.execute({
          input: { dataRoot: storage.dataRoot, configRoot: storage.configRoot },
        });
        if (cancelled) return;
        if (report.ok) setDoctorReport(report.value.ctx.output!);
      } catch {
        // Doctor is best-effort decoration on the status bar. Tests with partial deps stubs
        // can throw inside the probe; swallow so the rest of the UI keeps rendering.
      } finally {
        if (!cancelled) setDoctorLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [deps, storage, testEnv]);

  useEffect(() => {
    if (testEnv) return undefined;
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const result = await deps.versionChecker?.();
        if (!cancelled && result !== undefined) setVersion(result);
      } catch {
        // Version check is best-effort decoration; ignore failures.
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [deps, testEnv]);

  return (
    <SystemStatusContext.Provider value={{ doctor: doctorReport, doctorLoading, version }}>
      {children}
    </SystemStatusContext.Provider>
  );
};
