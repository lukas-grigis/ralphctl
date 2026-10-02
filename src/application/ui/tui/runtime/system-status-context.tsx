/**
 * Shared system-status context — surfaces the doctor probe and the npm version check to any
 * component that wants to render them (currently the StatusBar's footer info row and the
 * Doctor view).
 *
 * Doctor + version probes are run lazily on first mount of the provider so the rest of the UI
 * doesn't pay the cost on every view change. The doctor probe can be re-run on demand via
 * `refreshDoctor()` — both the Doctor view's `r` keybind and any future "rerun health checks"
 * affordance call the same callback so the StatusBar footer and the Doctor view always reflect
 * the same single source of truth.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
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
  /**
   * Re-runs the doctor probes and updates {@link doctor} / {@link doctorLoading} in place.
   * Both the StatusBar footer and the Doctor view subscribe to the same state, so calling
   * this from one surface reflects in every other surface automatically.
   */
  readonly refreshDoctor: () => Promise<void>;
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

  // The doctor flow + `VersionChecker` port don't accept an `AbortSignal`, so we can't
  // hard-cancel in-flight work — the no-op callback below is a state-write gate, not a true
  // cancellation. Acceptable: probes are short and the provider only unmounts at app exit.
  //
  // `refreshDoctor` itself always runs — the test-env gate only suppresses the *initial*
  // auto-fire so unrelated view tests don't pay for the doctor flow on every harness mount.
  // The Doctor view explicitly calls `refreshDoctor()` on mount, so opening it (even in tests)
  // runs the probes deterministically.
  const refreshDoctor = useCallback(async (): Promise<void> => {
    setDoctorLoading(true);
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
      if (report.ok) setDoctorReport(report.value.ctx.output!);
    } catch {
      // Doctor is best-effort decoration on the status bar. Tests with partial deps stubs
      // can throw inside the probe; swallow so the rest of the UI keeps rendering.
    } finally {
      setDoctorLoading(false);
    }
  }, [deps, storage]);

  useEffect(() => {
    if (testEnv) return;
    void refreshDoctor();
  }, [refreshDoctor, testEnv]);

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
    <SystemStatusContext.Provider value={{ doctor: doctorReport, doctorLoading, version, refreshDoctor }}>
      {children}
    </SystemStatusContext.Provider>
  );
};
