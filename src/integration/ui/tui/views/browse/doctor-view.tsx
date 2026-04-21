/**
 * DoctorView — native environment health dashboard.
 *
 * Two sections — Environment (fixed-size row set) and Onboarding (one row
 * per project/repo). Each section aligns its label column to the widest
 * label inside the section so rows stay tabular and the detail column
 * never collides with the label.
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
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface NamedCheck {
  readonly name: string;
  readonly result: CheckResult;
}

interface Section {
  readonly title: string;
  readonly rows: NamedCheck[];
}

type State = { kind: 'running' } | { kind: 'done'; sections: Section[] };

const TITLE = 'Doctor' as const;
const HINTS = [] as const;

/** Minimum padding for short-label sections so short rows still line up. */
const MIN_LABEL_WIDTH = 20;

async function runChecks(): Promise<Section[]> {
  const environment: [string, CheckResult | Promise<CheckResult>][] = [
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
  const envRows = await Promise.all(
    environment.map(async ([name, r]) => ({
      name,
      result: r instanceof Promise ? await r : r,
    }))
  );

  // One row per (project, repo). Strip the "Onboarding — " prefix so the
  // section heading carries the category and rows show the repo identity.
  const onboardingResults = await checkRepoOnboarding();
  const onboardingRows: NamedCheck[] = onboardingResults.map((result) => ({
    name: result.name.replace(/^Onboarding\s+—\s+/u, ''),
    result,
  }));

  const sections: Section[] = [{ title: 'Environment', rows: envRows }];
  if (onboardingRows.length > 0) {
    sections.push({ title: 'Onboarding', rows: onboardingRows });
  }
  return sections;
}

function glyph(status: CheckResult['status']): string {
  if (status === 'pass') return glyphs.check;
  if (status === 'warn') return glyphs.warningGlyph;
  if (status === 'skip') return glyphs.inlineDot;
  return glyphs.cross;
}

function color(status: CheckResult['status']): string {
  if (status === 'pass') return inkColors.success;
  if (status === 'warn') return inkColors.warning;
  if (status === 'skip') return inkColors.muted;
  return inkColors.error;
}

function labelWidth(rows: NamedCheck[]): number {
  return Math.max(MIN_LABEL_WIDTH, ...rows.map((r) => r.name.length));
}

function Row({ row, width }: { row: NamedCheck; width: number }): React.JSX.Element {
  const dim = row.result.status === 'skip';
  return (
    <Box>
      <Text color={color(row.result.status)} bold>
        {glyph(row.result.status)}
      </Text>
      <Text>{` `}</Text>
      <Text bold dimColor={dim}>
        {row.name.padEnd(width + 2)}
      </Text>
      <Text dimColor>{row.result.detail ?? row.result.status.toUpperCase()}</Text>
    </Box>
  );
}

export function DoctorView(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'running' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      const sections = await runChecks();
      if (!ctl.cancelled) setState({ kind: 'done', sections });
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, []);

  if (state.kind === 'running') {
    return (
      <ViewShell title={TITLE}>
        <Spinner label="Running environment checks…" />
      </ViewShell>
    );
  }

  return (
    <ViewShell title={TITLE}>
      {state.sections.map((section, i) => {
        const width = labelWidth(section.rows);
        const passed = section.rows.filter((r) => r.result.status === 'pass').length;
        const warned = section.rows.filter((r) => r.result.status === 'warn').length;
        const failed = section.rows.filter((r) => r.result.status === 'fail').length;
        const total = section.rows.filter((r) => r.result.status !== 'skip').length;
        const summary = `${String(passed)}/${String(total)} pass${warned > 0 ? ` · ${String(warned)} warn` : ''}${failed > 0 ? ` · ${String(failed)} fail` : ''}`;
        return (
          <Box key={section.title} flexDirection="column">
            {i === 0 ? null : <Box marginTop={spacing.section} />}
            <Box>
              <Text color={inkColors.primary} bold>
                {section.title.toUpperCase()}
              </Text>
              <Text color={inkColors.muted}>{`  ${glyphs.emDash}  `}</Text>
              <Text color={inkColors.muted}>{summary}</Text>
            </Box>
            <Box marginTop={spacing.section} flexDirection="column">
              {section.rows.map((row) => (
                <Row key={row.name} row={row} width={width} />
              ))}
            </Box>
          </Box>
        );
      })}
    </ViewShell>
  );
}
