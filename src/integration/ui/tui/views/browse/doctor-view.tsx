/**
 * DoctorView — native environment health dashboard.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import {
  checkAiProvider,
  checkConfigSchemaValidation,
  checkCurrentSprint,
  checkDataDirectory,
  checkEvaluationConfig,
  checkGitIdentity,
  checkGitInstalled,
  checkGlabInstalled,
  checkNodeVersion,
  checkProjectPaths,
  checkRepoOnboarding,
  type CheckResult,
} from '@src/integration/cli/commands/doctor/doctor.ts';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface NamedCheck {
  readonly name: string;
  readonly result: CheckResult;
}

type State = { kind: 'running' } | { kind: 'done'; checks: NamedCheck[] };

const TITLE = 'Doctor' as const;
const HINTS = [] as const;

async function runChecks(): Promise<NamedCheck[]> {
  const checks: [string, CheckResult | Promise<CheckResult>][] = [
    ['Node.js version', checkNodeVersion()],
    ['git installed', checkGitInstalled()],
    ['git identity', checkGitIdentity()],
    ['AI provider', await checkAiProvider()],
    ['glab (optional)', checkGlabInstalled()],
    ['Data directory', await checkDataDirectory()],
    ['Project paths', await checkProjectPaths()],
    ['Evaluation config', await checkEvaluationConfig()],
    ['Config schema', await checkConfigSchemaValidation()],
    ['Current sprint', await checkCurrentSprint()],
  ];
  const base = await Promise.all(
    checks.map(async ([name, r]) => ({
      name,
      result: r instanceof Promise ? await r : r,
    }))
  );
  // One row per (project, repo) — already carries its own "Onboarding — <project>/<repo>" name.
  const onboarding = await checkRepoOnboarding();
  return [...base, ...onboarding.map((result) => ({ name: result.name, result }))];
}

function glyph(status: CheckResult['status']): string {
  if (status === 'pass') return glyphs.check;
  if (status === 'warn') return '!';
  if (status === 'skip') return glyphs.inlineDot;
  return glyphs.cross;
}

function color(status: CheckResult['status']): string {
  if (status === 'pass') return inkColors.success;
  if (status === 'warn') return inkColors.warning;
  if (status === 'skip') return inkColors.muted;
  return inkColors.error;
}

export function DoctorView(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'running' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      const checks = await runChecks();
      if (!ctl.cancelled) setState({ kind: 'done', checks });
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, []);

  return (
    <ViewShell title={TITLE}>
      {state.kind === 'running' ? (
        <Spinner label="Running environment checks…" />
      ) : (
        state.checks.map((c) => (
          <Box key={c.name}>
            <Text color={color(c.result.status)} bold>
              {glyph(c.result.status)}
            </Text>
            <Text>{` `}</Text>
            <Text bold>{c.name.padEnd(20)}</Text>
            <Text dimColor>{c.result.detail ?? c.result.status.toUpperCase()}</Text>
          </Box>
        ))
      )}
    </ViewShell>
  );
}
