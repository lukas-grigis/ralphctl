/**
 * UI output facade — stdout formatters for plain-text command output.
 *
 * This module is the presentation layer for one-shot CLI commands. It writes
 * directly to stdout with ANSI colors and ASCII boxes. Separate from the
 * `LoggerPort` pipeline, which is the structured/Ink path.
 *
 * Ported from src/integration/ui/theme/ui.ts — no legacy src/ imports.
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

export { emoji };

// ── Icons ─────────────────────────────────────────────────────────────────────

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

// ── Stdout logging ────────────────────────────────────────────────────────────

const INDENT = '  ';

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

export function printCountSummary(label: string, done: number, total: number): void {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const color = percent === 100 ? colors.success : percent > 50 ? colors.warning : colors.muted;
  printSeparator();
  console.log(`${INDENT}${label}  ${color(`${String(done)}/${String(total)} (${String(percent)}%)`)}`);
}

// ── Banner ────────────────────────────────────────────────────────────────────

function getBannerText(): string {
  const art = isColorSupported ? gradients.donut.multiline(banner.art) : banner.art;
  const quote = getRandomQuote();
  return `${art}\n  ${colors.muted(`"${quote}"`)}\n`;
}

export function printBanner(): void {
  console.log(getBannerText());
}

// ── TTY detection ─────────────────────────────────────────────────────────────

export function isTTY(): boolean {
  if (!process.stdout.isTTY || process.env['NO_COLOR']) return false;
  return true;
}

export function terminalBell(): void {
  if (isTTY()) process.stdout.write('\x07');
}

// ── Spinner ───────────────────────────────────────────────────────────────────

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

// ── Field formatters ──────────────────────────────────────────────────────────

export const DETAIL_LABEL_WIDTH = 14;

export function field(label: string, value: string, labelWidth = 12): string {
  const paddedLabel = (label + ':').padEnd(labelWidth);
  return `${INDENT}${colors.muted(paddedLabel)} ${value}`;
}

export function fieldMultiline(label: string, value: string, labelWidth = 12): string {
  const lines = value.split('\n');
  const paddedLabel = (label + ':').padEnd(labelWidth);
  const indentStr = INDENT + ' '.repeat(labelWidth + 1);
  if (lines.length === 1) return `${INDENT}${colors.muted(paddedLabel)} ${value}`;
  const firstLine = lines[0] ?? '';
  const result: string[] = [`${INDENT}${colors.muted(paddedLabel)} ${firstLine}`];
  for (let i = 1; i < lines.length; i++) result.push(`${indentStr}${lines[i] ?? ''}`);
  return result.join('\n');
}

export function labelValue(label: string, value: string, labelWidth = DETAIL_LABEL_WIDTH): string {
  return field(label, value, labelWidth).trimStart();
}

// ── Status formatters ─────────────────────────────────────────────────────────

export function formatTaskStatus(status: 'todo' | 'in_progress' | 'done' | 'cancelled' | 'skipped'): string {
  const e = getStatusEmoji(status);
  const labels: Record<string, string> = {
    todo: 'To Do',
    in_progress: 'In Progress',
    done: 'Done',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
  };
  const statusColors: Record<string, ColorFn> = {
    todo: colors.muted,
    in_progress: colors.warning,
    done: colors.success,
    cancelled: colors.muted,
    skipped: colors.warning,
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

// ── Box / Card / Table renderers (pure) ───────────────────────────────────────

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

const MIN_BOX_WIDTH = 20;
const DEFAULT_TERMINAL_WIDTH = 80;

function getTerminalWidth(): number {
  return process.stdout.columns || DEFAULT_TERMINAL_WIDTH;
}

function wrapLine(line: string, maxWidth: number): string[] {
  const visible = stripAnsi(line);
  if (visible.length <= maxWidth) return [line];
  const indentMatch = /^(\s*)/.exec(visible);
  const indentStr = indentMatch?.[1] ?? '';
  const indentLen = indentStr.length;
  const wrapWidth = maxWidth - indentLen;
  if (wrapWidth <= 0) return [line];
  const words = visible.trimStart().split(/(\s+)/);
  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length <= wrapWidth) {
      current += word;
    } else if (current.length === 0) {
      for (let i = 0; i < word.length; i += wrapWidth) wrapped.push(indentStr + word.slice(i, i + wrapWidth));
    } else {
      wrapped.push(indentStr + current.trimEnd());
      current = word.trimStart();
    }
  }
  if (current.trimEnd().length > 0) wrapped.push(indentStr + current.trimEnd());
  return wrapped.length > 0 ? wrapped : [line];
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
  const safeTitle = stripAnsi(title);
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

export function progressBar(
  done: number,
  total: number,
  options: { width?: number; showPercent?: boolean } = {}
): string {
  const { width = 20, showPercent = true } = options;
  if (total === 0 || width <= 0) return colors.muted('─'.repeat(Math.max(0, width)));
  const filledCount = Math.round((done / total) * width);
  const emptyCount = width - filledCount;
  const percent = Math.round((done / total) * 100);
  const bar = colors.success('█'.repeat(filledCount)) + colors.muted('░'.repeat(emptyCount));
  if (!showPercent) return bar;
  const label = percent === 100 ? colors.success(`${String(percent)}%`) : colors.muted(`${String(percent)}%`);
  return `${bar} ${label}`;
}

interface TableColumn {
  header: string;
  align?: 'left' | 'right';
  color?: ColorFn;
  minWidth?: number;
}

interface TableOptions {
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
    const dataMax = rows.reduce((w, row) => Math.max(w, (row[i] ?? '').length), 0);
    return Math.max(col.minWidth ?? 0, headerWidth, dataMax);
  });
  const totalWidth = colWidths.reduce((sum, w) => sum + w + 2, 0) + indent * 2;
  const result: string[] = [];
  result.push(colorFn(chars.topLeft + chars.horizontal.repeat(totalWidth) + chars.topRight));
  const headerCells = columns.map((col, i) => {
    const w = colWidths[i] ?? col.header.length;
    const h = col.header.padEnd(w);
    return colors.highlight(h);
  });
  result.push(colorFn(chars.vertical) + pad + headerCells.join(colorFn('  ')) + pad + colorFn(chars.vertical));
  result.push(colorFn(chars.teeRight + chars.horizontal.repeat(totalWidth) + chars.teeLeft));
  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const w = colWidths[i] ?? col.header.length;
      const v = row[i] ?? '';
      const aligned = col.align === 'right' ? v.padStart(w) : v.padEnd(w);
      return col.color ? col.color(aligned) : aligned;
    });
    result.push(colorFn(chars.vertical) + pad + cells.join('  ') + pad + colorFn(chars.vertical));
  }
  result.push(colorFn(chars.bottomLeft + chars.horizontal.repeat(totalWidth) + chars.bottomRight));
  return result.join('\n');
}
