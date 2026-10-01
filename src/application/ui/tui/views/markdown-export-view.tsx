/**
 * Presentation shell shared by the two per-sprint markdown export views (context.md /
 * requirements.md). It owns the run lifecycle via {@link useMarkdownExport} and renders the
 * one-shot idle/running/done/error states; the wrapping views supply only their copy (title,
 * subtitle, spinner label) and a `run` callback that executes their flow. This keeps the two
 * views as thin, declarative wrappers instead of near-identical ~90-line components.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { glyphs, inkColors, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';
import {
  type UseMarkdownExportConfig,
  useMarkdownExport,
} from '@src/application/ui/tui/runtime/use-markdown-export.ts';

export interface MarkdownExportViewProps extends UseMarkdownExportConfig {
  readonly title: string;
  readonly subtitle: string;
  /** Spinner copy while the export runs, e.g. `Writing context markdown…`. */
  readonly spinnerLabel: string;
}

export const MarkdownExportView = (props: MarkdownExportViewProps): React.JSX.Element => {
  const run = useMarkdownExport({ filename: props.filename, run: props.run, deps: props.deps });

  return (
    <ViewShell title={props.title} subtitle={props.subtitle}>
      <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
        {run.kind === 'idle' || run.kind === 'running' ? (
          <Spinner label={props.spinnerLabel} />
        ) : run.kind === 'done' ? (
          <Card title="Done" tone="success">
            <Text>
              <Text color={tones.success.color} bold>
                {tones.success.glyph}{' '}
              </Text>
              Wrote <Text bold>{run.path}</Text>
            </Text>
            <Text dimColor>
              {String(run.bytes)} bytes {glyphs.bullet} press r to re-render
            </Text>
          </Card>
        ) : (
          <Card title="Failed" tone="error">
            <Text color={inkColors.error}>
              {tones.error.glyph} {run.message}
            </Text>
            <Text dimColor>press r to retry</Text>
          </Card>
        )}
      </Box>
    </ViewShell>
  );
};
