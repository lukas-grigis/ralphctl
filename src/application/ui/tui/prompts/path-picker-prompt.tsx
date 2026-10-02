/**
 * Path picker — browse the filesystem and select a directory. Tailored for ralphctl's repo paths, which are always
 * directories.
 */

import React, { useEffect, useState } from 'react';
import { promises as fs, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, type Key } from 'ink';
import { usePromptInput } from '@src/application/ui/tui/prompts/use-prompt-input.ts';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { usePromptHints, type PromptHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { computeListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { messageOf } from '@src/domain/value/error/error-message.ts';

export interface PathPickerPromptProps {
  readonly message: string;
  readonly onSubmit: (path: string) => void;
  readonly onCancel: () => void;
  /** Starting directory. Defaults to `process.cwd()` (the directory the user ran ralphctl from). */
  readonly initial?: string;
}

interface Entry {
  readonly name: string;
  readonly isDirectory: boolean;
}

type Row =
  { readonly kind: 'parent' } | { readonly kind: 'select' } | { readonly kind: 'entry'; readonly entry: Entry };

const MAX_VISIBLE_ROWS = 12;
const MIN_VISIBLE_ROWS = 4;
/** Rows the frame, wizard card, picker header, counter and hint line spend around the list. */
const AROUND_LIST_ROWS = 17;
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const expandHome = (input: string): string => {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
};

interface DirectoryEntriesState {
  readonly entries: readonly Entry[];
  readonly error: string | undefined;
  readonly setError: React.Dispatch<React.SetStateAction<string | undefined>>;
}

/** Loads and filters the subdirectories of `cwd`, re-running whenever `cwd` or `showHidden` change. */
const useDirectoryEntries = (cwd: string, showHidden: boolean): DirectoryEntriesState => {
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const items = await fs.readdir(cwd, { withFileTypes: true });
        if (cancelled) return;
        const filtered = items
          .filter((d) => showHidden || !d.name.startsWith('.'))
          .filter((d) => d.isDirectory())
          .map((d): Entry => ({ name: d.name, isDirectory: true }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setEntries(filtered);
        setError(undefined);
      } catch (err) {
        if (cancelled) return;
        setEntries([]);
        setError(messageOf(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [cwd, showHidden]);

  return { entries, error, setError };
};

/** Jumps `cwd` to its parent directory, resetting the cursor onto `[Select this directory]`. */
const goToParent = (
  cwd: string,
  setCwd: React.Dispatch<React.SetStateAction<string>>,
  setCursor: React.Dispatch<React.SetStateAction<number>>
): void => {
  const parent = dirname(cwd);
  if (parent !== cwd) {
    setCwd(parent);
    setCursor(1);
  }
};

/** Resolves the `↵` key against the currently focused row: parent / select / open-directory. */
const handleReturnKey = (
  rows: readonly Row[],
  cursor: number,
  cwd: string,
  onSubmit: (path: string) => void,
  setCwd: React.Dispatch<React.SetStateAction<string>>,
  setCursor: React.Dispatch<React.SetStateAction<number>>
): void => {
  const row = rows[cursor];
  if (row === undefined) return;
  if (row.kind === 'parent') {
    goToParent(cwd, setCwd, setCursor);
    return;
  }
  if (row.kind === 'select') {
    onSubmit(cwd);
    return;
  }
  setCwd(join(cwd, row.entry.name));
  setCursor(1);
};

interface PathPickerKeyDeps {
  readonly cwd: string;
  readonly rows: readonly Row[];
  readonly cursor: number;
  readonly onCancel: () => void;
  readonly onSubmit: (path: string) => void;
  readonly setCwd: React.Dispatch<React.SetStateAction<string>>;
  readonly setCursor: React.Dispatch<React.SetStateAction<number>>;
  readonly setShowHidden: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setError: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setTyping: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Dispatches a single keypress to the matching navigation/action handler. Flat guard sequence — no nesting. */
const handlePathPickerKey = (input: string, key: Key, deps: PathPickerKeyDeps): void => {
  const { cwd, rows, cursor, onCancel, onSubmit, setCwd, setCursor, setShowHidden, setError, setTyping } = deps;
  if (key.escape) {
    onCancel();
    return;
  }
  if (key.upArrow || input === 'k') {
    setCursor((c) => clamp(c - 1, 0, rows.length - 1));
    return;
  }
  if (key.downArrow || input === 'j') {
    setCursor((c) => clamp(c + 1, 0, rows.length - 1));
    return;
  }
  if (key.backspace || key.delete) {
    goToParent(cwd, setCwd, setCursor);
    return;
  }
  if (input === '~') {
    setCwd(homedir());
    setCursor(1);
    return;
  }
  if (input === '.') {
    setShowHidden((v) => !v);
    return;
  }
  if (input === 't') {
    setError(undefined);
    setTyping(true);
    return;
  }
  if (key.return) {
    handleReturnKey(rows, cursor, cwd, onSubmit, setCwd, setCursor);
  }
};

/** Inline check for the typed-path field: the path must be an existing directory. */
const checkTypedPath = (raw: string): string | undefined => {
  const expanded = expandHome(raw.trim());
  if (expanded.length === 0) return 'Path is required';
  try {
    return statSync(expanded).isDirectory() ? undefined : `${expanded} is not a directory`;
  } catch {
    return `${expanded} does not exist`;
  }
};

interface TypedPathFieldProps {
  readonly initial: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

const TypedPathField = ({ initial, onSubmit, onCancel }: TypedPathFieldProps): React.JSX.Element => (
  <Box flexDirection="column" marginTop={spacing.section} paddingX={spacing.indent}>
    <Text dimColor>Type a path (~/ ok). esc returns to the picker.</Text>
    <TextPrompt message="Path" initial={initial} validate={checkTypedPath} onSubmit={onSubmit} onCancel={onCancel} />
  </Box>
);

interface PathPickerRowsProps {
  readonly rows: readonly Row[];
  readonly start: number;
  readonly end: number;
  readonly cursor: number;
}

/** Renders the windowed slice of rows plus the "N of M" counter when the list overflows. */
const PathPickerRows = ({ rows, start, end, cursor }: PathPickerRowsProps): React.JSX.Element => (
  <>
    {rows.slice(start, end).map((row, localIdx) => {
      const idx = start + localIdx;
      const focused = idx === cursor;
      const label = labelFor(row);
      return (
        <Box key={`${row.kind}-${idx}`} paddingX={spacing.indent}>
          <Text {...(focused ? { color: inkColors.primary } : {})} bold={focused}>
            {focused ? glyphs.actionCursor : ' '} {label}
          </Text>
        </Box>
      );
    })}
    {rows.length > end - start && (
      <Box paddingX={spacing.indent}>
        <Text dimColor>
          {String(cursor + 1)} of {String(rows.length)}
        </Text>
      </Box>
    )}
  </>
);

const PICKER_HINTS = [
  { keys: '↵', label: 'open/select' },
  { keys: '⌫', label: 'up' },
  { keys: 't', label: 'type' },
  { keys: 'esc', label: 'cancel' },
];
const NO_HINTS: readonly PromptHint[] = [];

export const PathPickerPrompt = ({
  message,
  onSubmit,
  onCancel,
  initial,
}: PathPickerPromptProps): React.JSX.Element => {
  const [cwd, setCwd] = useState<string>(() => expandHome(initial ?? process.cwd()));
  const [showHidden, setShowHidden] = useState(false);
  const { entries, error, setError } = useDirectoryEntries(cwd, showHidden);
  const [cursor, setCursor] = useState(1); // Default to `[Select this directory]`.
  const [typing, setTyping] = useState(false);
  const { rows: termRows } = useTerminalSize();

  // The typed-path TextPrompt publishes its own keys.
  usePromptHints(typing ? NO_HINTS : PICKER_HINTS);

  // Synthetic rows: parent (..) → [Select this directory] → directory entries.
  const rows: readonly Row[] = [
    { kind: 'parent' },
    { kind: 'select' },
    ...entries.map((e): Row => ({ kind: 'entry', entry: e })),
  ];

  // Clamp cursor when the row count shrinks (e.g. after navigating into an empty dir).
  useEffect(() => {
    setCursor((c) => clamp(c, 0, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  usePromptInput(
    (input, key) =>
      handlePathPickerKey(input, key, {
        cwd,
        rows,
        cursor,
        onCancel,
        onSubmit,
        setCwd,
        setCursor,
        setShowHidden,
        setError,
        setTyping,
      }),
    { isActive: !typing }
  );

  // Windowed slice around the cursor so deep directories stay scrollable.
  const visibleRows = clamp(termRows - AROUND_LIST_ROWS, MIN_VISIBLE_ROWS, MAX_VISIBLE_ROWS);
  const { start, end } = computeListWindow(rows.length, cursor, visibleRows);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={inkColors.primary}>
          {glyphs.badge} {message}
        </Text>
      </Box>
      <Box paddingX={spacing.indent}>
        <Text dimColor>{cwd}</Text>
      </Box>
      {error !== undefined && (
        <Box paddingX={spacing.indent}>
          <Text color={inkColors.error}>{error}</Text>
        </Box>
      )}
      {!typing && (
        <Box flexDirection="column" marginTop={spacing.section}>
          <PathPickerRows rows={rows} start={start} end={end} cursor={cursor} />
        </Box>
      )}
      {typing ? (
        <TypedPathField
          initial={cwd}
          onSubmit={(value) => {
            setTyping(false);
            onSubmit(expandHome(value.trim()));
          }}
          onCancel={() => setTyping(false)}
        />
      ) : (
        <Box paddingX={spacing.indent} marginTop={spacing.section}>
          <Text dimColor>
            ↵ open/select · ⌫ up · esc cancel · ~ home · t type · . {showHidden ? 'hide' : 'show'} hidden
          </Text>
        </Box>
      )}
    </Box>
  );
};

const labelFor = (row: Row): string => {
  if (row.kind === 'parent') return '../';
  if (row.kind === 'select') return '[ Select this directory ]';
  return `${row.entry.name}/`;
};
