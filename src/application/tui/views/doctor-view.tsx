/**
 * DoctorView — environment health check.
 *
 * Runs `runDoctor(deps)` on mount, shows a spinner while loading, then
 * renders one row per check with a status glyph + name + optional message,
 * followed by an aggregate ResultCard.
 *
 * Keyboard: Enter → pop view.
 */

import React, { useEffect, useState } from 'react';
import { useViewInput } from './use-view-input.ts';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { useViewHints } from './view-hints-context.tsx';
import { useRouter } from './router-context.ts';
import { getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { runDoctor } from '@src/application/doctor/run-doctor.ts';
import type { DoctorReport, DoctorCheckResult, DoctorCheckStatus } from '@src/application/doctor/run-doctor.ts';
import type { ResultKind } from '@src/application/tui/components/result-card.tsx';

const HINTS = [{ key: 'Enter', action: 'back' }] as const;

const STATUS_GLYPH: Record<DoctorCheckStatus, string> = {
  pass: glyphs.check,
  warn: glyphs.warningGlyph,
  fail: glyphs.cross,
  skip: glyphs.inlineDot,
};

const STATUS_COLOR: Record<DoctorCheckStatus, string> = {
  pass: inkColors.success,
  warn: inkColors.warning,
  fail: inkColors.error,
  skip: inkColors.muted,
};

function overallKind(status: DoctorReport['status']): ResultKind {
  switch (status) {
    case 'ok':
      return 'success';
    case 'warn':
      return 'warning';
    case 'fail':
      return 'error';
  }
}

function overallTitle(status: DoctorReport['status']): string {
  switch (status) {
    case 'ok':
      return 'All checks passed';
    case 'warn':
      return 'Some checks need attention';
    case 'fail':
      return 'One or more checks failed';
  }
}

function CheckRow({ check }: { readonly check: DoctorCheckResult }): React.JSX.Element {
  const color = STATUS_COLOR[check.status];
  const glyph = STATUS_GLYPH[check.status];
  const details = check.details ?? [];
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text>{'  '}</Text>
        <Text bold={check.status === 'fail'}>{check.name}</Text>
        {check.message ? <Text dimColor>{`  ${glyphs.emDash} ${check.message}`}</Text> : null}
      </Box>
      {details.length > 0 ? (
        <Box flexDirection="column" paddingLeft={spacing.indent + 2}>
          {details.map((detail, i) => (
            <Box key={i}>
              <Text color={inkColors.muted}>{`${glyphs.inlineDot} `}</Text>
              <Text color={inkColors.muted}>{detail}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function DoctorView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      try {
        const deps = await getSharedDeps();
        const result = await runDoctor(deps);
        if (!cancel.current) setReport(result);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, []);

  useViewInput((_input, key) => {
    if ((report !== null || error !== null) && key.return) {
      router.pop();
    }
  });

  if (report === null && error === null) {
    return (
      <ViewShell title="DOCTOR">
        <Spinner label="Running doctor checks…" />
      </ViewShell>
    );
  }

  if (error !== null) {
    return (
      <ViewShell title="DOCTOR">
        <ResultCard
          kind="error"
          title="Doctor failed"
          lines={[error]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      </ViewShell>
    );
  }

  if (report === null) {
    return (
      <ViewShell title="DOCTOR">
        <Box />
      </ViewShell>
    );
  }

  const kind = overallKind(report.status);
  const title = overallTitle(report.status);

  return (
    <ViewShell title="DOCTOR">
      <Box flexDirection="column">
        <Box flexDirection="column">
          {report.checks.map((check, i) => (
            <Box key={i} marginTop={i === 0 ? 0 : 1}>
              <CheckRow check={check} />
            </Box>
          ))}
        </Box>
        <Box marginTop={spacing.section}>
          <ResultCard kind={kind} title={title} nextSteps={[{ action: 'Press Enter to go back' }]} />
        </Box>
      </Box>
    </ViewShell>
  );
}
