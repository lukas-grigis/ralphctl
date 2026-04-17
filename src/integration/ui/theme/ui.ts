/**
 * UI output facade — stdout formatters for plain-text command output.
 *
 * This module is the presentation layer for one-shot CLI commands (`ralphctl
 * ticket show`, `ralphctl sprint health`, etc.) — it writes directly to stdout
 * with ANSI colors and ASCII boxes. It is deliberately *separate* from the
 * `LoggerPort` pipeline, which is the structured/Ink path used by long-running
 * use cases and the Ink TUI.
 */

import {
  banner,
  type ColorFn,
  colors,
  emoji,
  getRandomQuote,
  getStatusEmoji,
  gradients,
  isColorSupported,
} from './theme.ts';

// ============================================================================
// RE-EXPORTS
// ============================================================================

export { emoji };
export { getRandomQuote } from './theme.ts';

// ============================================================================
// ICONS (data — used across ~20 commands for inline rendering)
// ============================================================================

export const icons = {
  sprint: '>',
  ticket: '#',
  task: '*',
  project: '@',
  edit: '>',
  success: '+',
  error: 'x',
  warning: '!',
  info: 'i',
  tip: '?',
  active: '*',
  inactive: 'o',
  bullet: '-',
} as const;

// ============================================================================
// STDOUT LOGGING
// ============================================================================

const INDENT = '  ';

/** Structured stdout helpers used by command output. */
export const log = {
  info(message: string): void {
    console.log(`${INDENT}${colors.info(icons.info)}  ${message}`);
  },
  success(message: string): void {
    console.log(`${INDENT}${colors.success(icons.success)}  ${message}`);
  },
  warn(message: string): void {
    console.log(`${INDENT}${colors.warning(icons.warning)}  ${message}`);
  },
  error(message: string): void {
    console.log(`${INDENT}${colors.error(icons.error)}  ${message}`);
  },
  dim(message: string): void {
    console.log(`${INDENT}${colors.muted(message)}`);
  },
  item(message: string): void {
    console.log(`${INDENT}${INDENT}${colors.muted(icons.bullet)}  ${message}`);
  },
  itemSuccess(message: string): void {
    console.log(`${INDENT}${INDENT}${colors.success(icons.success)}  ${message}`);
  },
  itemError(message: string, detail?: string): void {
    console.log(`${INDENT}${INDENT}${colors.error(icons.error)}  ${message}`);
    if (detail) console.log(`${INDENT}${INDENT}   ${colors.muted(detail)}`);
  },
  raw(message: string, indentLevel = 1): void {
    console.log(`${INDENT.repeat(indentLevel)}${message}`);
  },
  newline(): void {
    console.log('');
  },
};

export function printHeader(title: string, icon?: string): void {
  const displayIcon = icon ?? emoji.donut;
  console.log('');
  console.log(`  ${displayIcon}  ${colors.highlight(title)}`);
  console.log(colors.muted(`  ${'─'.repeat(40)}`));
  console.log('');
}

export function printSeparator(width = 40): void {
  console.log(`${INDENT}${colors.muted('─'.repeat(width))}`);
}

export function showSuccess(message: string, details?: [string, string][]): void {
  console.log('\n' + `${INDENT}${colors.success(icons.success)}  ${colors.success(message)}`);
  if (details) {
    console.log(details.map(([label, value]) => field(label, value)).join('\n'));
  }
}

export function showError(message: string): void {
  console.log('\n' + `${INDENT}${colors.error(icons.error)}  ${colors.error(message)}`);
}

export function showInfo(message: string): void {
  console.log(`${INDENT}${colors.info(icons.info)}  ${colors.info(message)}`);
}

export function showWarning(message: string): void {
  console.log(`${INDENT}${colors.warning(icons.warning)}  ${colors.warning(message)}`);
}

export function showTip(message: string): void {
  console.log(`${INDENT}${colors.muted(icons.tip + ' ' + message)}`);
}

export function showEmpty(what: string, hint?: string): void {
  console.log('\n' + `${INDENT}${colors.muted(icons.inactive)}  ${colors.muted(`No ${what} yet.`)}`);
  if (hint) {
    console.log(`${INDENT}   ${colors.muted(icons.tip + ' ' + hint)}\n`);
  }
}

export function showNextStep(command: string, description?: string): void {
  const desc = description ? ` ${colors.muted('- ' + description)}` : '';
  console.log(`${INDENT}${colors.muted('→')} ${colors.highlight(command)}${desc}`);
}

export function showNextSteps(steps: [command: string, description?: string][]): void {
  for (const [command, description] of steps) showNextStep(command, description);
}

export function showRandomQuote(): void {
  console.log(colors.muted(`  "${getRandomQuote()}"`));
}

export function printSummary(items: [string, string | number][]): void {
  printSeparator();
  for (const [label, value] of items) {
    console.log(`${INDENT}${colors.muted(label)}  ${colors.highlight(String(value))}`);
  }
}

export function printCountSummary(label: string, done: number, total: number): void {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const color = percent === 100 ? colors.success : percent > 50 ? colors.warning : colors.muted;
  printSeparator();
  console.log(`${INDENT}${label}  ${color(`${String(done)}/${String(total)} (${String(percent)}%)`)}`);
}

// ============================================================================
// BANNER
// ============================================================================

/** Pure function — banner art + random quote as a string. */
export function getBannerText(): string {
  const art = isColorSupported ? gradients.donut.multiline(banner.art) : banner.art;
  const quote = getRandomQuote();
  return `${art}\n  ${colors.muted(`"${quote}"`)}\n`;
}

/** Print the banner to stdout (used by cli.ts before commander dispatch). */
export function printBanner(): void {
  console.log(getBannerText());
}

// ============================================================================
// TTY DETECTION + TERMINAL BELL
// ============================================================================

export function isTTY(): boolean {
  if (!process.stdout.isTTY || process.env['NO_COLOR']) return false;
  return true;
}

/** Ring the terminal bell (used by long-running AI commands to nudge the user). */
export function terminalBell(): void {
  if (isTTY()) process.stdout.write('\x07');
}

// ============================================================================
// SPINNER
// ============================================================================

/**
 * Minimal non-animating spinner — prints `• start`, `+ success`, `x fail`.
 * Used by plain-text command paths (ticket/add, task/import, project/add,
 * ticket/refine). Inside the Ink TUI, prefer `LoggerPort.spinner()` which
 * the `InkSink` renders as a live component.
 */
interface SpinnerShim {
  text: string;
  start(): SpinnerShim;
  stop(): SpinnerShim;
  succeed(message?: string): SpinnerShim;
  fail(message?: string): SpinnerShim;
}

export function createSpinner(text: string): SpinnerShim {
  let started = false;
  const shim: SpinnerShim = {
    text,
    start() {
      if (!started && isTTY()) {
        console.log(`${INDENT}${colors.muted('•')} ${shim.text}`);
      }
      started = true;
      return shim;
    },
    stop() {
      return shim;
    },
    succeed(msg?: string) {
      console.log(`${INDENT}${colors.success('+')} ${msg ?? shim.text}`);
      return shim;
    },
    fail(msg?: string) {
      console.error(`${INDENT}${colors.error('x')} ${msg ?? shim.text}`);
      return shim;
    },
  };
  return shim;
}

// ============================================================================
// FIELD FORMATTERS
// ============================================================================

export function field(label: string, value: string, labelWidth = 12): string {
  const paddedLabel = (label + ':').padEnd(labelWidth);
  return `${INDENT}${colors.muted(paddedLabel)} ${value}`;
}

export function fieldMultiline(label: string, value: string, labelWidth = 12): string {
  const lines = value.split('\n');
  const paddedLabel = (label + ':').padEnd(labelWidth);
  const indent = INDENT + ' '.repeat(labelWidth + 1);
  if (lines.length === 1) return `${INDENT}${colors.muted(paddedLabel)} ${value}`;
  const firstLine = lines[0] ?? '';
  const result: string[] = [`${INDENT}${colors.muted(paddedLabel)} ${firstLine}`];
  for (let i = 1; i < lines.length; i++) result.push(`${indent}${lines[i] ?? ''}`);
  return result.join('\n');
}

export function labelValue(label: string, value: string, labelWidth = DETAIL_LABEL_WIDTH): string {
  return field(label, value, labelWidth).trimStart();
}

// ============================================================================
// STATUS FORMATTERS
// ============================================================================

export function formatTaskStatus(status: 'todo' | 'in_progress' | 'done'): string {
  const e = getStatusEmoji(status);
  const labels: Record<string, string> = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
  const statusColors: Record<string, ColorFn> = {
    todo: colors.muted,
    in_progress: colors.warning,
    done: colors.success,
  };
  return (statusColors[status] ?? colors.muted)(`${e} ${labels[status] ?? status}`);
}

export function formatSprintStatus(status: 'draft' | 'active' | 'closed'): string {
  const e = getStatusEmoji(status);
  const labels: Record<string, string> = { draft: 'Draft', active: 'Active', closed: 'Closed' };
  const statusColors: Record<string, ColorFn> = {
    draft: colors.warning,
    active: colors.success,
    closed: colors.muted,
  };
  return (statusColors[status] ?? colors.muted)(`${e} ${labels[status] ?? status}`);
}

export function badge(text: string, type: 'success' | 'warning' | 'error' | 'muted' = 'muted'): string {
  return colors[type](`[${text}]`);
}

export function formatMuted(text: string): string {
  return colors.muted(text);
}

// ============================================================================
// BOX / CARD / TABLE / COLUMN RENDERERS (pure)
// ============================================================================

export const boxChars = {
  light: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
    teeRight: '├',
    teeLeft: '┤',
    teeDown: '┬',
    teeUp: '┴',
    cross: '┼',
  },
  rounded: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
    teeRight: '├',
    teeLeft: '┤',
    teeDown: '┬',
    teeUp: '┴',
    cross: '┼',
  },
  heavy: {
    topLeft: '┏',
    topRight: '┓',
    bottomLeft: '┗',
    bottomRight: '┛',
    horizontal: '━',
    vertical: '┃',
    teeRight: '┣',
    teeLeft: '┫',
    teeDown: '┳',
    teeUp: '┻',
    cross: '╋',
  },
} as const;

export type BoxStyle = keyof typeof boxChars;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\([A-Z])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

export function sanitizeForDisplay(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

export const MIN_BOX_WIDTH = 20;
const DEFAULT_TERMINAL_WIDTH = 80;
export const DETAIL_LABEL_WIDTH = 14;

function getTerminalWidth(): number {
  return process.stdout.columns || DEFAULT_TERMINAL_WIDTH;
}

function wrapLine(line: string, maxWidth: number): string[] {
  const visible = stripAnsi(line);
  if (visible.length <= maxWidth) return [line];
  const indentMatch = /^(\s*)/.exec(visible);
  const indent = indentMatch?.[1] ?? '';
  const indentLen = indent.length;
  const wrapWidth = maxWidth - indentLen;
  if (wrapWidth <= 0) return [line];
  const words = visible.trimStart().split(/(\s+)/);
  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length <= wrapWidth) {
      current += word;
    } else if (current.length === 0) {
      for (let i = 0; i < word.length; i += wrapWidth) wrapped.push(indent + word.slice(i, i + wrapWidth));
    } else {
      wrapped.push(indent + current.trimEnd());
      current = word.trimStart();
    }
  }
  if (current.trimEnd().length > 0) wrapped.push(indent + current.trimEnd());
  return wrapped.length > 0 ? wrapped : [line];
}

export function horizontalLine(width: number, style: BoxStyle = 'light'): string {
  return boxChars[style].horizontal.repeat(width);
}

export function verticalLine(style: BoxStyle = 'light'): string {
  return boxChars[style].vertical;
}

export function renderBox(
  lines: string[],
  options: { style?: BoxStyle; padding?: number; colorFn?: ColorFn } = {}
): string {
  const { style = 'rounded', padding = 1, colorFn = colors.muted } = options;
  const chars = boxChars[style];
  const pad = ' '.repeat(padding);

  const termWidth = getTerminalWidth();
  const maxInnerWidth = Math.max(MIN_BOX_WIDTH, termWidth - 2);
  const maxContentWidth = maxInnerWidth - padding * 2;
  const wrappedLines = lines.flatMap((l) => wrapLine(l, maxContentWidth));
  const contentWidths = wrappedLines.map((l) => stripAnsi(l).length);
  const innerWidth = Math.min(Math.max(...contentWidths, MIN_BOX_WIDTH) + padding * 2, maxInnerWidth);

  const result: string[] = [];
  result.push(colorFn(chars.topLeft + chars.horizontal.repeat(innerWidth) + chars.topRight));
  for (const line of wrappedLines) {
    const visibleLen = stripAnsi(line).length;
    const rightPad = ' '.repeat(Math.max(0, innerWidth - padding * 2 - visibleLen));
    result.push(colorFn(chars.vertical) + pad + line + rightPad + pad + colorFn(chars.vertical));
  }
  result.push(colorFn(chars.bottomLeft + chars.horizontal.repeat(innerWidth) + chars.bottomRight));
  return result.join('\n');
}

export function renderCard(
  title: string,
  lines: string[],
  options: { style?: BoxStyle; colorFn?: ColorFn } = {}
): string {
  const { style = 'rounded', colorFn = colors.muted } = options;
  const chars = boxChars[style];

  const termWidth = getTerminalWidth();
  const maxInnerWidth = Math.max(MIN_BOX_WIDTH, termWidth - 4);
  const safeTitle = sanitizeForDisplay(title);
  const titleWidth = Math.min(safeTitle.length, maxInnerWidth - 2);
  const wrappedLines = lines.flatMap((l) => wrapLine(l, maxInnerWidth - 2));
  const contentWidths = wrappedLines.map((l) => stripAnsi(l).length);
  const innerWidth = Math.min(Math.max(...contentWidths, titleWidth, MIN_BOX_WIDTH) + 2, maxInnerWidth);

  const result: string[] = [];
  result.push(colorFn(chars.topLeft + chars.horizontal.repeat(innerWidth) + chars.topRight));
  const titlePad = ' '.repeat(Math.max(0, innerWidth - titleWidth - 2));
  result.push(colorFn(chars.vertical) + ' ' + colors.highlight(safeTitle) + titlePad + ' ' + colorFn(chars.vertical));
  result.push(colorFn(chars.teeRight + chars.horizontal.repeat(innerWidth) + chars.teeLeft));
  for (const line of wrappedLines) {
    const visibleLen = stripAnsi(line).length;
    const rightPad = ' '.repeat(Math.max(0, innerWidth - visibleLen - 2));
    result.push(colorFn(chars.vertical) + ' ' + line + rightPad + ' ' + colorFn(chars.vertical));
  }
  result.push(colorFn(chars.bottomLeft + chars.horizontal.repeat(innerWidth) + chars.bottomRight));
  return result.join('\n');
}

export interface ProgressBarOptions {
  width?: number;
  filled?: string;
  empty?: string;
  showPercent?: boolean;
}

export function progressBar(done: number, total: number, options: ProgressBarOptions = {}): string {
  const { width = 20, filled = '\u2588', empty = '\u2591', showPercent = true } = options;
  if (total === 0 || width <= 0) return colors.muted('\u2500'.repeat(Math.max(0, width)));
  const filledCount = Math.round((done / total) * width);
  const emptyCount = width - filledCount;
  const percent = Math.round((done / total) * 100);
  const bar = colors.success(filled.repeat(filledCount)) + colors.muted(empty.repeat(emptyCount));
  if (!showPercent) return bar;
  const label = percent === 100 ? colors.success(`${String(percent)}%`) : colors.muted(`${String(percent)}%`);
  return `${bar} ${label}`;
}

export interface TableColumn {
  header: string;
  align?: 'left' | 'right';
  color?: ColorFn;
  minWidth?: number;
}

export interface TableOptions {
  style?: BoxStyle;
  indent?: number;
  colorFn?: ColorFn;
}

export function renderTable(columns: TableColumn[], rows: string[][], options: TableOptions = {}): string {
  const { style = 'rounded', indent = 2, colorFn = colors.muted } = options;
  const chars = boxChars[style];
  const pad = ' '.repeat(indent);

  const colWidths = columns.map((col, i) => {
    const headerWidth = col.header.length;
    const dataWidth = Math.max(0, ...rows.map((row) => stripAnsi(row[i] ?? '').length));
    return Math.max(headerWidth, dataWidth, col.minWidth ?? 0);
  });

  const result: string[] = [];
  const topLine = colWidths.map((w) => chars.horizontal.repeat(w + 2)).join(chars.teeDown);
  result.push(pad + colorFn(chars.topLeft + topLine + chars.topRight));

  const headerCells = columns.map((col, i) => {
    const w = colWidths[i] ?? 0;
    return ' ' + colors.highlight(col.header.padEnd(w)) + ' ';
  });
  result.push(pad + colorFn(chars.vertical) + headerCells.join(colorFn(chars.vertical)) + colorFn(chars.vertical));

  const sepLine = colWidths.map((w) => chars.horizontal.repeat(w + 2)).join(chars.cross);
  result.push(pad + colorFn(chars.teeRight + sepLine + chars.teeLeft));

  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const w = colWidths[i] ?? 0;
      const cell = row[i] ?? '';
      const visibleLen = stripAnsi(cell).length;
      const padding = Math.max(0, w - visibleLen);
      const coloredCell = col.color ? col.color(cell) : cell;
      if (col.align === 'right') return ' ' + ' '.repeat(padding) + coloredCell + ' ';
      return ' ' + coloredCell + ' '.repeat(padding) + ' ';
    });
    result.push(pad + colorFn(chars.vertical) + cells.join(colorFn(chars.vertical)) + colorFn(chars.vertical));
  }

  const bottomLine = colWidths.map((w) => chars.horizontal.repeat(w + 2)).join(chars.teeUp);
  result.push(pad + colorFn(chars.bottomLeft + bottomLine + chars.bottomRight));
  return result.join('\n');
}

export interface ColumnOptions {
  gap?: number;
  minWidth?: number;
}

export function renderColumns(blocks: string[][], options: ColumnOptions = {}): string {
  const { gap = 4, minWidth = 20 } = options;
  const colCount = blocks.length;
  if (colCount === 0) return '';
  if (colCount === 1) return (blocks[0] ?? []).join('\n');

  const widths = blocks.map((lines) => Math.max(minWidth, ...lines.map((l) => stripAnsi(l).length)));
  const maxLines = Math.max(...blocks.map((b) => b.length));
  const gapStr = ' '.repeat(gap);

  const result: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const parts = blocks.map((block, colIdx) => {
      const line = block[i] ?? '';
      const w = widths[colIdx] ?? minWidth;
      const visibleLen = stripAnsi(line).length;
      return line + ' '.repeat(Math.max(0, w - visibleLen));
    });
    result.push(parts.join(gapStr));
  }
  return result.join('\n');
}

export interface ProgressSummaryLabels {
  done?: string;
  remaining?: string;
  title?: string;
}

export function renderProgressSummary(done: number, total: number, labels: ProgressSummaryLabels = {}): string {
  const { done: doneLabel = 'done', remaining: remainingLabel = 'remaining', title } = labels;
  const remaining = total - done;
  const bar = progressBar(done, total);
  const summary = `${colors.success(String(done))} ${colors.muted(doneLabel)}, ${colors.muted(String(remaining))} ${colors.muted(remainingLabel)}`;
  const prefix = title ? `${colors.highlight(title)}  ` : '';
  return `${prefix}${bar}  ${summary}`;
}
