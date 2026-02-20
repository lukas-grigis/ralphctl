import { muted } from '@src/theme/index.ts';
import { icons } from '@src/theme/ui.ts';

export interface InlineEditorOptions {
  /** Message/prompt to display */
  message: string;
  /** Default value (pre-populated in buffer) */
  default?: string;
}

interface CursorPos {
  row: number;
  col: number;
}

/**
 * Inline multiline text editor for the terminal.
 *
 * Supports arrow key navigation, Home/End, paste, Backspace/Delete.
 * Ctrl+D to submit, Ctrl+C to cancel (returns empty string).
 *
 * Drop-in replacement for `multilineInput` (same signature).
 *
 * @returns The edited text, or empty string on cancel
 */
export async function inlineEditor(options: InlineEditorOptions): Promise<string> {
  const { message, default: defaultValue } = options;

  // Non-TTY fallback: delegate to readline-based multilineInput
  if (!process.stdin.isTTY) {
    const { multilineInput } = await import('@src/utils/multiline.ts');
    return multilineInput({ message, default: defaultValue });
  }

  return new Promise<string>((resolve) => {
    const lines: string[] = defaultValue ? defaultValue.split('\n') : [''];
    const cursor: CursorPos = { row: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0 };

    // Count how many terminal rows we've drawn so we can clear them
    let renderedRows = 0;

    const stdin = process.stdin;
    const stdout = process.stdout;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    function getTermWidth(): number {
      return stdout.columns || 80;
    }

    // Calculate how many terminal rows a line of text occupies (accounting for wrapping)
    function termRowsForLine(line: string): number {
      const width = getTermWidth();
      if (line.length === 0) return 1;
      return Math.ceil(line.length / width) || 1;
    }

    function render(): void {
      // Move cursor up to start of our rendered region
      if (renderedRows > 0) {
        stdout.write(`\x1b[${String(renderedRows)}A`);
      }
      // Clear from cursor to end of screen
      stdout.write('\x1b[0J');

      // Draw each line
      for (let i = 0; i < lines.length; i++) {
        const lineNum = muted(String(i + 1).padStart(2) + ' ');
        stdout.write(lineNum + (lines[i] ?? '') + '\n');
      }

      // Draw status bar
      const statusBar = muted('  Ctrl+D to submit | Ctrl+C to cancel');
      stdout.write(statusBar + '\n');

      // Calculate total rendered terminal rows
      renderedRows = 1; // status bar
      for (const line of lines) {
        renderedRows += termRowsForLine(line);
      }

      // Position cursor: move up from bottom, then set column
      const rowsFromBottom = renderedRows - termRowsForLine_upTo(cursor.row, cursor.col);
      if (rowsFromBottom > 0) {
        stdout.write(`\x1b[${String(rowsFromBottom)}A`);
      }
      // Column = line number prefix (4 chars: "NN ") + cursor.col
      const prefix = 4;
      const col = prefix + cursor.col + 1;
      stdout.write(`\x1b[${String(col)}G`);
    }

    // Calculate how many terminal rows from top of editor to the cursor position
    function termRowsForLine_upTo(row: number, col: number): number {
      let total = 0;
      for (let i = 0; i < row; i++) {
        total += termRowsForLine(lines[i] ?? '');
      }
      // Add rows for current line up to cursor column
      const width = getTermWidth();
      const currentLine = lines[row] ?? '';
      if (currentLine.length === 0 || col === 0) {
        total += 1;
      } else {
        total += Math.ceil(Math.min(col, currentLine.length) / width) || 1;
      }
      return total;
    }

    function cleanup(): void {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);

      // Move cursor to after our rendered content
      const rowsFromBottom = renderedRows - termRowsForLine_upTo(cursor.row, cursor.col);
      if (rowsFromBottom > 0) {
        stdout.write(`\x1b[${String(rowsFromBottom)}B`);
      }
      stdout.write('\x1b[0G\n');
    }

    function submit(): void {
      cleanup();
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
        lines.pop();
      }
      resolve(lines.join('\n'));
    }

    function cancel(): void {
      cleanup();
      resolve('');
    }

    function clampCursor(): void {
      if (cursor.row < 0) cursor.row = 0;
      if (cursor.row >= lines.length) cursor.row = lines.length - 1;
      const lineLen = lines[cursor.row]?.length ?? 0;
      if (cursor.col < 0) cursor.col = 0;
      if (cursor.col > lineLen) cursor.col = lineLen;
    }

    function insertText(text: string): void {
      // Handle pasted text that may contain newlines
      const parts = text.split(/\r\n|\r|\n/);
      const currentLine = lines[cursor.row] ?? '';
      const before = currentLine.slice(0, cursor.col);
      const after = currentLine.slice(cursor.col);

      if (parts.length === 1) {
        // Single line insert
        lines[cursor.row] = before + (parts[0] ?? '') + after;
        cursor.col += (parts[0] ?? '').length;
      } else {
        // Multi-line paste
        const firstPart = parts[0] ?? '';
        const lastPart = parts[parts.length - 1] ?? '';
        lines[cursor.row] = before + firstPart;

        // Insert middle lines
        const middleLines = parts.slice(1, -1);
        for (let i = 0; i < middleLines.length; i++) {
          lines.splice(cursor.row + 1 + i, 0, middleLines[i] ?? '');
        }

        // Insert last part + remainder
        const lastLineIdx = cursor.row + parts.length - 1;
        lines.splice(lastLineIdx, 0, lastPart + after);

        cursor.row = lastLineIdx;
        cursor.col = lastPart.length;
      }
    }

    function onData(data: string): void {
      // Parse input character by character, handling escape sequences
      let i = 0;
      while (i < data.length) {
        const ch = data[i] ?? '';
        const code = ch.charCodeAt(0);

        // Ctrl+D (EOT) - submit
        if (code === 4) {
          submit();
          return;
        }

        // Ctrl+C (ETX) - cancel
        if (code === 3) {
          cancel();
          return;
        }

        // Enter / Carriage Return
        if (code === 13 || code === 10) {
          const currentLine = lines[cursor.row] ?? '';
          const before = currentLine.slice(0, cursor.col);
          const after = currentLine.slice(cursor.col);
          lines[cursor.row] = before;
          lines.splice(cursor.row + 1, 0, after);
          cursor.row++;
          cursor.col = 0;
          i++;
          continue;
        }

        // Backspace
        if (code === 127 || code === 8) {
          if (cursor.col > 0) {
            const currentLine = lines[cursor.row] ?? '';
            lines[cursor.row] = currentLine.slice(0, cursor.col - 1) + currentLine.slice(cursor.col);
            cursor.col--;
          } else if (cursor.row > 0) {
            // Merge with previous line
            const prevLine = lines[cursor.row - 1] ?? '';
            const currentLine = lines[cursor.row] ?? '';
            cursor.col = prevLine.length;
            lines[cursor.row - 1] = prevLine + currentLine;
            lines.splice(cursor.row, 1);
            cursor.row--;
          }
          i++;
          continue;
        }

        // Escape sequences
        if (code === 27) {
          if (i + 1 < data.length && data[i + 1] === '[') {
            const seq = data[i + 2];

            // Arrow keys
            if (seq === 'A') {
              // Up
              if (cursor.row > 0) {
                cursor.row--;
                clampCursor();
              }
              i += 3;
              continue;
            }
            if (seq === 'B') {
              // Down
              if (cursor.row < lines.length - 1) {
                cursor.row++;
                clampCursor();
              }
              i += 3;
              continue;
            }
            if (seq === 'C') {
              // Right
              const lineLen = lines[cursor.row]?.length ?? 0;
              if (cursor.col < lineLen) {
                cursor.col++;
              } else if (cursor.row < lines.length - 1) {
                cursor.row++;
                cursor.col = 0;
              }
              i += 3;
              continue;
            }
            if (seq === 'D') {
              // Left
              if (cursor.col > 0) {
                cursor.col--;
              } else if (cursor.row > 0) {
                cursor.row--;
                cursor.col = lines[cursor.row]?.length ?? 0;
              }
              i += 3;
              continue;
            }

            // Home key: \x1b[H or \x1b[1~
            if (seq === 'H') {
              cursor.col = 0;
              i += 3;
              continue;
            }

            // End key: \x1b[F or \x1b[4~
            if (seq === 'F') {
              cursor.col = lines[cursor.row]?.length ?? 0;
              i += 3;
              continue;
            }

            // Delete key: \x1b[3~
            if (seq === '3' && i + 3 < data.length && data[i + 3] === '~') {
              const currentLine = lines[cursor.row] ?? '';
              if (cursor.col < currentLine.length) {
                lines[cursor.row] = currentLine.slice(0, cursor.col) + currentLine.slice(cursor.col + 1);
              } else if (cursor.row < lines.length - 1) {
                // Merge with next line
                const nextLine = lines[cursor.row + 1] ?? '';
                lines[cursor.row] = currentLine + nextLine;
                lines.splice(cursor.row + 1, 1);
              }
              i += 4;
              continue;
            }

            // Home: \x1b[1~ (alternate)
            if (seq === '1' && i + 3 < data.length && data[i + 3] === '~') {
              cursor.col = 0;
              i += 4;
              continue;
            }

            // End: \x1b[4~ (alternate)
            if (seq === '4' && i + 3 < data.length && data[i + 3] === '~') {
              cursor.col = lines[cursor.row]?.length ?? 0;
              i += 4;
              continue;
            }

            // Unknown escape sequence - skip
            i += 3;
            continue;
          }

          // Bare ESC or ESC + unknown - skip
          i++;
          continue;
        }

        // Ctrl+A - Home
        if (code === 1) {
          cursor.col = 0;
          i++;
          continue;
        }

        // Ctrl+E - End
        if (code === 5) {
          cursor.col = lines[cursor.row]?.length ?? 0;
          i++;
          continue;
        }

        // Ctrl+K - Kill line (delete from cursor to end of line)
        if (code === 11) {
          const currentLine = lines[cursor.row] ?? '';
          lines[cursor.row] = currentLine.slice(0, cursor.col);
          i++;
          continue;
        }

        // Tab - insert 2 spaces
        if (code === 9) {
          insertText('  ');
          i++;
          continue;
        }

        // Regular printable characters (or multi-byte paste)
        if (code >= 32) {
          // Collect all remaining printable characters for efficient paste handling
          let text = ch;
          i++;
          while (i < data.length) {
            const nextCode = data.charCodeAt(i);
            // Stop at control characters and escape sequences
            if (nextCode < 32 && nextCode !== 10 && nextCode !== 13) break;
            if (nextCode === 27) break; // ESC
            text += data[i] ?? '';
            i++;
          }
          insertText(text);
          continue;
        }

        // Unknown control character - skip
        i++;
      }

      render();
    }

    // Print prompt
    console.log(`${icons.edit} ${message} ${muted('(Ctrl+D to submit)')}`);

    // Initial render
    render();

    stdin.on('data', onData);
  });
}
