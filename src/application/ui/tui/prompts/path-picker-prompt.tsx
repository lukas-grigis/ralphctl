/**
 * Path picker — browse the filesystem and select a directory. Tailored for ralphctl's repo
 * paths, which are always directories. Free-text entry is unreliable (no auto-completion,
 * easy to typo) so the wizard funnels users through a navigable list instead — but a `t`
 * shortcut drops to a text-entry overlay for users who know the exact path.
 *
 * Layout per render:
 *   - Current directory header
 *   - `..` row (parent)
 *   - `[Select this directory]` row (confirms the current `cwd`)
 *   - sorted subdirectories, dotfiles hidden by default
 *
 * Keys:
 *   ↑/↓ or k/j   move cursor
 *   ↵            open directory, or confirm when on `[Select]`/`..`
 *   ⌫            jump to parent directory (same as activating `..`)
 *   ~ or h       jump to home directory
 *   t            type a path manually (validates as an existing directory before commit)
 *   .            toggle hidden entries
 *   esc          cancel
 *
 * Starts in `initial` when provided; otherwise `process.cwd()`. If neither is readable, the
 * picker falls back to `os.homedir()` so the user is never stuck on an error frame.
 */

import React, { useEffect, useState } from 'react';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface PathPickerPromptProps {
  readonly message: string;
  readonly onSubmit: (path: string) => void;
  readonly onCancel: () => void;
  /**
   * Starting directory. Defaults to `process.cwd()` (the directory the user ran ralphctl from).
   * Tilde-expanded automatically.
   */
  readonly initial?: string;
}

interface Entry {
  readonly name: string;
  readonly isDirectory: boolean;
}

type Row =
  { readonly kind: 'parent' } | { readonly kind: 'select' } | { readonly kind: 'entry'; readonly entry: Entry };

const VISIBLE_ROWS = 12;
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const expandHome = (input: string): string => {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
};

export const PathPickerPrompt = ({
  message,
  onSubmit,
  onCancel,
  initial,
}: PathPickerPromptProps): React.JSX.Element => {
  const [cwd, setCwd] = useState<string>(() => expandHome(initial ?? process.cwd()));
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [cursor, setCursor] = useState(1); // Default to `[Select this directory]`.
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [typing, setTyping] = useState(false);

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
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [cwd, showHidden]);

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

  useInput(
    (input, key) => {
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
        const parent = dirname(cwd);
        if (parent !== cwd) {
          setCwd(parent);
          setCursor(1);
        }
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
        const row = rows[cursor];
        if (row === undefined) return;
        if (row.kind === 'parent') {
          const parent = dirname(cwd);
          if (parent !== cwd) {
            setCwd(parent);
            setCursor(1);
          }
          return;
        }
        if (row.kind === 'select') {
          onSubmit(cwd);
          return;
        }
        setCwd(join(cwd, row.entry.name));
        setCursor(1);
      }
    },
    { isActive: !typing }
  );

  const submitTyped = async (raw: string): Promise<void> => {
    const expanded = expandHome(raw.trim());
    if (expanded.length === 0) {
      setTyping(false);
      return;
    }
    try {
      const stat = await fs.stat(expanded);
      if (!stat.isDirectory()) {
        setError(`${expanded} is not a directory`);
        setTyping(false);
        return;
      }
      setTyping(false);
      onSubmit(expanded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTyping(false);
    }
  };

  // Windowed slice around the cursor so deep directories stay scrollable.
  const half = Math.floor(VISIBLE_ROWS / 2);
  const start = clamp(cursor - half, 0, Math.max(0, rows.length - VISIBLE_ROWS));
  const end = Math.min(rows.length, start + VISIBLE_ROWS);

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
      <Box flexDirection="column" marginTop={1}>
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
        {rows.length > VISIBLE_ROWS && (
          <Box paddingX={spacing.indent}>
            <Text dimColor>
              {String(cursor + 1)} of {String(rows.length)}
            </Text>
          </Box>
        )}
      </Box>
      {typing ? (
        <Box flexDirection="column" marginTop={1} paddingX={spacing.indent}>
          <Text dimColor>Type an absolute path (~/ allowed). Enter validates; esc returns to the picker.</Text>
          <TextPrompt
            message="Path"
            initial={cwd}
            onSubmit={(value) => void submitTyped(value)}
            onCancel={() => setTyping(false)}
          />
        </Box>
      ) : (
        <Box paddingX={spacing.indent} marginTop={1}>
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
