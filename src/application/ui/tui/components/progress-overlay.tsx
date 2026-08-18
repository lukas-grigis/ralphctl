/**
 * Read-only modal that surfaces `<sprintDir>/progress.md` — the artifact the next AI session
 * bootstraps from. Embodies the Anthropic principle: the TUI is a view onto the artifact, not
 * a parallel runtime. The harness's `progress.md` writer (progress-file-sink) keeps the file
 * fresh; this overlay just reflects what's on disk.
 *
 * Mounted at the {@link App} Layout when `ui.progressOpen` is true so every view inherits it
 * without per-view wiring; same dismiss contract as the help overlay (`esc` or `g` toggles).
 *
 * Scroll model (only while a file is loaded and overflow exists):
 *   ↑ / ↓                               → one line
 *   PageUp / PageDown / Ctrl+b / Ctrl+f → one viewport
 *   Ctrl+u / Ctrl+d                     → half viewport
 *
 * Empty / missing file: friendly message — no crash. Read errors surface as a short diag line
 * so the operator can see *why* (missing vs permission denied vs read failure).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import React, { useEffect, useMemo, useState } from 'react';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import {
  overlayBodyRows,
  useDocumentScroll,
} from '@src/application/ui/tui/components/overlay-internals/use-document-scroll.ts';
import {
  overlayBodyColumns,
  wrapRows,
} from '@src/application/ui/tui/components/overlay-internals/wrap-document-rows.ts';

interface ProgressFile {
  readonly kind: 'ok';
  readonly lines: readonly string[];
  readonly modifiedAtMs: number;
}
interface ProgressMissing {
  readonly kind: 'missing';
}
interface ProgressEmpty {
  readonly kind: 'empty';
  readonly modifiedAtMs: number;
}
interface ProgressFailed {
  readonly kind: 'failed';
  readonly message: string;
}

type ProgressState = ProgressFile | ProgressMissing | ProgressEmpty | ProgressFailed | { readonly kind: 'loading' };

const EMPTY_LINES: readonly string[] = [];

const formatAgo = (modifiedAtMs: number, now: number): string => {
  const elapsed = Math.max(0, now - modifiedAtMs);
  return `${fmtDuration(elapsed)} ago`;
};

/**
 * Loads `<sprintDir>/progress.md` on mount / whenever `sprintId` or `dataRoot` change. The sprint
 * dir is resolved via the tolerant id-prefix resolver so both the new `<id>--<slug>/` and legacy
 * bare `<id>/` names are found — building the bare path here would split-brain against a
 * slug-renamed dir. We don't tail the file; a re-open (close + `g` again) gets the latest snapshot.
 */
const useProgressFile = (sprintId: SprintId | undefined, dataRoot: AbsolutePath): ProgressState => {
  const [state, setState] = useState<ProgressState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (sprintId === undefined) {
      setState({ kind: 'missing' });
      return undefined;
    }
    const load = async (): Promise<void> => {
      try {
        const dir = await resolveSprintDir(dataRoot, sprintId);
        if (cancelled) return;
        if (dir === undefined) {
          setState({ kind: 'missing' });
          return;
        }
        const progressPath = join(dir, 'progress.md');
        const [stat, content] = await Promise.all([fs.stat(progressPath), fs.readFile(progressPath, 'utf8')]);
        if (cancelled) return;
        const modifiedAtMs = stat.mtimeMs;
        if (content.trim().length === 0) {
          setState({ kind: 'empty', modifiedAtMs });
          return;
        }
        // Strip a trailing newline so the last visible row isn't blank; preserve interior empties.
        const lines = content.replace(/\n+$/, '').split('\n');
        setState({ kind: 'ok', lines, modifiedAtMs });
      } catch (cause) {
        if (cancelled) return;
        const code = (cause as { code?: string } | undefined)?.code;
        if (code === 'ENOENT') {
          setState({ kind: 'missing' });
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        setState({ kind: 'failed', message });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sprintId, dataRoot]);

  return state;
};

interface ProgressBodyProps {
  readonly state: ProgressState;
  readonly visibleLines: readonly string[];
  readonly offset: number;
  readonly bodyRows: number;
  readonly lineCount: number;
  readonly modifiedAgo: string | undefined;
}

/** Renders the scrollable body (one branch per {@link ProgressState} kind) plus the paginated footer. */
const ProgressBody = ({
  state,
  visibleLines,
  offset,
  bodyRows,
  lineCount,
  modifiedAgo,
}: ProgressBodyProps): React.JSX.Element => {
  const maxOffset = Math.max(0, lineCount - bodyRows);
  return (
    <>
      <Box flexDirection="column" marginTop={spacing.section}>
        {state.kind === 'loading' && <Spinner label="Loading…" />}
        {state.kind === 'missing' && (
          <Box flexDirection="column">
            <Text>{glyphs.infoGlyph} No progress file yet.</Text>
            <Box marginTop={spacing.section}>
              <Text dimColor>
                The harness writes <Text>progress.md</Text> as the implementer reports signals. It will appear once a
                run starts.
              </Text>
            </Box>
          </Box>
        )}
        {state.kind === 'empty' && (
          <Box flexDirection="column">
            <Text>{glyphs.infoGlyph} Progress file exists but is empty.</Text>
            <Box marginTop={spacing.section}>
              <Text dimColor>Touched {modifiedAgo}; no signals have been recorded yet.</Text>
            </Box>
          </Box>
        )}
        {state.kind === 'failed' && (
          <Box flexDirection="column">
            <Text color={inkColors.error}>{glyphs.cross} Could not read progress file.</Text>
            <Box marginTop={spacing.section}>
              <Text dimColor>{state.message}</Text>
            </Box>
          </Box>
        )}
        {state.kind === 'ok' && (
          <Box flexDirection="column">
            {visibleLines.map((line, idx) => (
              // `truncate-end` is the backstop behind the pre-wrap: a row we mis-measured (tabs,
              // wide glyphs) is clipped rather than allowed to spill onto a second terminal row
              // and desync the row-count windowing above.
              <Text key={`row-${String(offset + idx)}`} wrap="truncate-end">
                {line.length === 0 ? ' ' : line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      {state.kind === 'ok' && maxOffset > 0 && (
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

export const ProgressOverlay = (): React.JSX.Element => {
  const selection = useSelection();
  const ui = useUiState();
  const storage = useStorage();
  const term = useTerminalSize();
  // Frozen "now" at mount so the "(Xs ago)" header doesn't tick mid-view; pressing `g` again
  // re-mounts the overlay and refreshes the file + the timestamp.
  const [now] = useState<number>(() => Date.now());

  // When an Execute view is focused, prefer its pinned sprint so `g` opens the run's own
  // progress file rather than whatever the global selection happens to be.
  const sprintId = ui.focusedRunSprintId ?? selection.sprintId;

  const state = useProgressFile(sprintId, storage.dataRoot);

  const bodyRows = overlayBodyRows(term.rows);
  // `progress.md` rows come off disk unwrapped — one note can be a whole paragraph. Wrap before
  // windowing so the row count the scroll model uses is the row count Ink paints.
  const bodyColumns = overlayBodyColumns(term.columns);
  const lines = useMemo<readonly string[]>(
    () => (state.kind === 'ok' ? wrapRows(state.lines, bodyColumns) : EMPTY_LINES),
    [state, bodyColumns]
  );
  const lineCount = lines.length;
  const { offset } = useDocumentScroll(lineCount, bodyRows);
  const visibleLines = lines.slice(offset, offset + bodyRows);

  const sprintLabel =
    ui.focusedRunSprintLabel ?? selection.sprintLabel ?? (sprintId !== undefined ? String(sprintId) : '(no sprint)');
  const modifiedAgo = state.kind === 'ok' || state.kind === 'empty' ? formatAgo(state.modifiedAtMs, now) : undefined;

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
              Progress
            </Text>
            <Text dimColor> {glyphs.bullet} </Text>
            <Text bold>{sprintLabel}</Text>
            {modifiedAgo !== undefined && (
              <Text dimColor>
                {'  '}({modifiedAgo})
              </Text>
            )}
          </Box>
          <Text dimColor>esc · g to close</Text>
        </Box>
        <ProgressBody
          state={state}
          visibleLines={visibleLines}
          offset={offset}
          bodyRows={bodyRows}
          lineCount={lineCount}
          modifiedAgo={modifiedAgo}
        />
      </Box>
    </Box>
  );
};
