/**
 * Read-only modal that surfaces an attempt's `<sprintDir>/implement/<task-id>/rounds/<N>/evaluator/
 * evaluation.md` — the operator-readable verdict the evaluator has always written and nothing has
 * ever opened. Same principle as {@link ProgressOverlay}: the TUI is a view onto the artifact, not
 * a parallel runtime.
 *
 * Mounted at the {@link App} Layout when `ui.evaluationTarget` is set, so both opening surfaces
 * (the Execute Tasks panel and sprint-detail) inherit it without per-view wiring. Opened with `v`
 * on the focused task; `esc` or `v` closes (handled globally, so it wins over the hidden view).
 *
 * Scroll model — identical to the progress overlay, via the shared {@link useDocumentScroll}:
 *   ↑ / ↓ line · PgUp/PgDn / Ctrl+b/f viewport · Ctrl+u/d half viewport
 *
 * HARD DEGRADE RULE. A `tasks.json` row may carry a stale, refused, or absent artifact path, and a
 * pruned workspace makes a valid one unreadable. Every such case renders today's one-line
 * `EvaluationLine` — the exact card the Tasks panel already shows — plus one dim explanatory row.
 * Never an error card: the operator asked to see a verdict, and the verdict itself is still known
 * even when its prose is not.
 */

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { EvaluationLine } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import {
  EvaluationLines,
  projectEvaluationLines,
  type EvaluationLineSpec,
} from '@src/application/ui/tui/components/evaluator-failure-panel.tsx';
import {
  overlayBodyRows,
  useDocumentScroll,
} from '@src/application/ui/tui/components/overlay-internals/use-document-scroll.ts';
import {
  useEvaluationFile,
  type EvaluationFileState,
} from '@src/application/ui/tui/components/evaluation-overlay-internals/use-evaluation-file.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';

/**
 * The rows the body scrolls, plus the dim notice shown above them. A degrade arm contributes a
 * notice and no rows; the loaded arm contributes rows and no notice.
 */
interface EvaluationBodyModel {
  readonly notice: string | undefined;
  readonly detail: string | undefined;
  readonly lines: readonly EvaluationLineSpec[];
}

const EMPTY_LINES: readonly EvaluationLineSpec[] = [];

/**
 * One arm per {@link EvaluationFileState}. The `ok` arm falls back to the raw file rows when the
 * parse recognised nothing at all (a truncated write, a future format) — showing the bytes on disk
 * beats showing a blank panel, and the verdict line above it is unaffected either way.
 */
const buildBodyModel = (state: EvaluationFileState): EvaluationBodyModel => {
  switch (state.kind) {
    case 'loading':
      return { notice: undefined, detail: undefined, lines: EMPTY_LINES };
    case 'unrecorded':
      return {
        notice: 'No evaluation artifact was recorded for this attempt.',
        detail: 'Attempts from earlier versions of the harness carry only the verdict.',
        lines: EMPTY_LINES,
      };
    case 'missing':
      return {
        notice: 'The evaluation file is no longer on disk.',
        detail: state.relativePath,
        lines: EMPTY_LINES,
      };
    case 'empty':
      return { notice: 'Evaluation file exists but is empty.', detail: state.relativePath, lines: EMPTY_LINES };
    case 'failed':
      return { notice: 'Could not read the evaluation file.', detail: state.message, lines: EMPTY_LINES };
    case 'ok': {
      const projected = projectEvaluationLines(state.parsed);
      if (projected.length > 0) return { notice: undefined, detail: undefined, lines: projected };
      return {
        notice: 'Evaluation file could not be parsed — showing the raw file.',
        detail: state.relativePath,
        lines: state.rawLines.map((text) => ({ text })),
      };
    }
  }
};

const formatAgo = (modifiedAtMs: number, now: number): string => `${fmtDuration(Math.max(0, now - modifiedAtMs))} ago`;

const modifiedAtOf = (state: EvaluationFileState): number | undefined =>
  state.kind === 'ok' || state.kind === 'empty' ? state.modifiedAtMs : undefined;

/**
 * The always-present verdict line. Identical to the Tasks-panel card's rendering, which is what
 * makes every degrade arm a strict superset of today's behaviour rather than a replacement for it.
 */
const VerdictHeadline = ({ target }: { readonly target: EvaluationTarget }): React.JSX.Element => (
  <EvaluationLine
    evaluation={{
      status: target.status,
      attemptN: target.attemptN,
      ...(target.finishedAt !== undefined ? { finishedAt: target.finishedAt } : {}),
    }}
  />
);

const EvaluationBody = ({
  state,
  model,
  target,
  offset,
  bodyRows,
}: {
  readonly state: EvaluationFileState;
  readonly model: EvaluationBodyModel;
  readonly target: EvaluationTarget;
  readonly offset: number;
  readonly bodyRows: number;
}): React.JSX.Element => {
  const lineCount = model.lines.length;
  const maxOffset = Math.max(0, lineCount - bodyRows);
  return (
    <>
      <Box flexDirection="column" marginTop={spacing.section}>
        {state.kind === 'loading' ? (
          <Spinner label="Loading…" />
        ) : (
          <>
            {model.notice !== undefined && (
              <Box flexDirection="column" marginBottom={spacing.section}>
                <VerdictHeadline target={target} />
                <Text>
                  {glyphs.infoGlyph} {model.notice}
                </Text>
                {model.detail !== undefined && <Text dimColor>{model.detail}</Text>}
              </Box>
            )}
            <EvaluationLines lines={model.lines.slice(offset, offset + bodyRows)} keyOffset={offset} />
          </>
        )}
      </Box>
      {maxOffset > 0 && (
        <Box marginTop={spacing.section} justifyContent="space-between">
          <Text dimColor>
            lines {String(offset + 1)}–{String(Math.min(lineCount, offset + bodyRows))} of {String(lineCount)}
          </Text>
          <Text dimColor>
            {glyphs.bullet} ↑/↓ scroll {glyphs.bullet} PgUp/PgDn page
          </Text>
        </Box>
      )}
    </>
  );
};

export const EvaluationOverlay = (): React.JSX.Element | null => {
  const ui = useUiState();
  const storage = useStorage();
  const term = useTerminalSize();
  // Frozen "now" at mount so the "(Xs ago)" header doesn't tick mid-view; re-pressing `v`
  // re-mounts the overlay and refreshes both the file and the timestamp.
  const [now] = useState<number>(() => Date.now());

  const target = ui.evaluationTarget;
  const state = useEvaluationFile(target, storage.dataRoot);
  const model = buildBodyModel(state);
  const bodyRows = overlayBodyRows(term.rows);
  const { offset } = useDocumentScroll(model.lines.length, bodyRows);

  // Every Hook above runs unconditionally; the null guard sits below them so Hook order is stable
  // whether or not App keeps the overlay mounted between opens.
  if (target === undefined) return null;

  const modifiedAtMs = modifiedAtOf(state);

  return (
    <Box flexDirection="column" paddingX={spacing.indent} paddingY={spacing.section}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={inkColors.primary}
        paddingX={spacing.indent}
        paddingY={0}
      >
        <Box justifyContent="space-between">
          <Box>
            <Text dimColor>{glyphs.bullet} </Text>
            <Text color={inkColors.primary} bold>
              Evaluation
            </Text>
            <Text dimColor> {glyphs.bullet} </Text>
            <Text bold>{target.taskLabel}</Text>
            <Text dimColor>
              {' '}
              {glyphs.bullet} attempt {String(target.attemptN)}
            </Text>
            {modifiedAtMs !== undefined && (
              <Text dimColor>
                {'  '}({formatAgo(modifiedAtMs, now)})
              </Text>
            )}
          </Box>
          <Text dimColor>esc · v to close</Text>
        </Box>
        <EvaluationBody state={state} model={model} target={target} offset={offset} bodyRows={bodyRows} />
      </Box>
    </Box>
  );
};
