/**
 * Interactive directory browser — Ink component.
 *
 * Navigation: arrow keys move, Enter descends or selects, Backspace goes up,
 * `h` jumps home, `.` selects current dir, Escape cancels.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Box, Text, useInput } from 'ink';
import type { FileBrowserOptions } from '@src/business/ports/prompt.ts';
import { emoji } from '@src/integration/ui/theme/tokens.ts';

export interface FileBrowserPromptProps {
  options: FileBrowserOptions;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}

function listDirectories(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    return [];
  }
}

function isGitRepo(dirPath: string): boolean {
  try {
    return statSync(join(dirPath, '.git')).isDirectory();
  } catch {
    return false;
  }
}

const PAGE_SIZE = 12;

export function FileBrowserPrompt({ options, onSubmit, onCancel }: FileBrowserPromptProps): React.JSX.Element {
  const [currentPath, setCurrentPath] = useState<string>(() =>
    options.startPath ? resolve(options.startPath) : homedir()
  );
  const [dirs, setDirs] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setDirs(listDirectories(currentPath));
    setCursor(0);
    setOffset(0);
  }, [currentPath]);

  const message = options.message ?? 'Browse to directory:';
  const parent = dirname(currentPath);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(dirs.length - 1, c + 1));
      return;
    }
    if (key.return) {
      const name = dirs[cursor];
      if (name) setCurrentPath(join(currentPath, name));
      return;
    }
    if (input === '.') {
      if (options.mustBeGitRepo && !isGitRepo(currentPath)) {
        // Silent no-op — could flash an error but keep simple.
        return;
      }
      onSubmit(currentPath);
      return;
    }
    if (key.backspace || input === 'u') {
      if (parent !== currentPath) setCurrentPath(parent);
      return;
    }
    if (input === 'h') {
      setCurrentPath(homedir());
      return;
    }
  });

  // Keep cursor visible within the paged window.
  useEffect(() => {
    if (cursor < offset) setOffset(cursor);
    else if (cursor >= offset + PAGE_SIZE) setOffset(cursor - PAGE_SIZE + 1);
  }, [cursor, offset]);

  const visible = useMemo(() => dirs.slice(offset, offset + PAGE_SIZE), [dirs, offset]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box>
        <Text>
          {emoji.donut} {message}
        </Text>
      </Box>
      <Box>
        <Text dimColor>{currentPath}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {visible.length === 0 && <Text dimColor>(no subdirectories)</Text>}
        {visible.map((name, i) => {
          const absoluteIdx = offset + i;
          const isSelected = absoluteIdx === cursor;
          const full = join(currentPath, name);
          const repo = isGitRepo(full);
          const icon = repo ? '⚙ ' : '▸ ';
          return (
            <Text key={name} color={isSelected ? 'yellow' : undefined}>
              {isSelected ? '› ' : '  '}
              {icon}
              {name}
              {repo && <Text dimColor> (git repo)</Text>}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · Enter descend · Backspace up · h home · . select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
