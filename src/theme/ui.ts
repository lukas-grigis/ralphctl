import ora, { type Ora } from 'ora';
import {
  banner,
  type ColorFn,
  colors,
  getMessage,
  getRandomQuote,
  getStatusEmoji,
  gradients,
  isColorSupported,
} from './index.ts';

// ============================================================================
// ICONS
// ============================================================================

/** Emoji for interactive prompts (distinct from ASCII icons) */
export const emoji = {
  donut: '🍩',
} as const;

/** Icons for visual hierarchy (ASCII only for professional look) */
export const icons = {
  // Entities
  sprint: '>',
  ticket: '#',
  task: '*',
  project: '@',

  // Actions
  edit: '>',

  // Status indicators
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
// LOGGING UTILITIES (consistent formatting with 2-space indent)
// ============================================================================

const INDENT = '  ';

/**
 * Structured logging utilities for consistent output
 */
export const log = {
  /** Info message with icon */
  info(message: string): void {
    console.log(`${INDENT}${colors.info(icons.info)}  ${message}`);
  },

  /** Success message with icon */
  success(message: string): void {
    console.log(`${INDENT}${colors.success(icons.success)}  ${message}`);
  },

  /** Warning message with icon */
  warn(message: string): void {
    console.log(`${INDENT}${colors.warning(icons.warning)}  ${message}`);
  },

  /** Error message with icon */
  error(message: string): void {
    console.log(`${INDENT}${colors.error(icons.error)}  ${message}`);
  },

  /** Dimmed/muted message */
  dim(message: string): void {
    console.log(`${INDENT}${colors.muted(message)}`);
  },

  /** List item with bullet */
  item(message: string): void {
    console.log(`${INDENT}${INDENT}${colors.muted(icons.bullet)}  ${message}`);
  },

  /** Success list item */
  itemSuccess(message: string): void {
    console.log(`${INDENT}${INDENT}${colors.success(icons.success)}  ${message}`);
  },

  /** Error list item */
  itemError(message: string, detail?: string): void {
    console.log(`${INDENT}${INDENT}${colors.error(icons.error)}  ${message}`);
    if (detail) {
      console.log(`${INDENT}${INDENT}   ${colors.muted(detail)}`);
    }
  },

  /** Raw text with indent */
  raw(message: string, indentLevel = 1): void {
    const prefix = INDENT.repeat(indentLevel);
    console.log(`${prefix}${message}`);
  },

  /** Newline for spacing */
  newline(): void {
    console.log('');
  },
};

// ============================================================================
// BOX & HEADER DRAWING
// ============================================================================

/**
 * Print a simple header with icon and title
 */
export function printHeader(title: string, icon?: string): void {
  const displayIcon = icon ?? emoji.donut;
  console.log('');
  console.log(`  ${displayIcon}  ${colors.highlight(title)}`);
  console.log(colors.muted(`  ${'─'.repeat(40)}`));
  console.log('');
}

/**
 * Print a separator line
 */
export function printSeparator(width = 40): void {
  console.log(`${INDENT}${colors.muted('─'.repeat(width))}`);
}

/**
 * Print a centered box with content
 */
export function printBox(lines: string[]): void {
  const maxLen = Math.max(...lines.map((l) => l.length), 30);
  const width = maxLen + 4;

  console.log('');
  console.log(`${INDENT}${colors.muted('─'.repeat(width))}`);
  for (const line of lines) {
    console.log(`${INDENT}  ${line}`);
  }
  console.log(`${INDENT}${colors.muted('─'.repeat(width))}`);
  console.log('');
}

// ============================================================================
// BOX-DRAWING CHARACTERS & UTILITIES
// ============================================================================

/** Box-drawing character sets */
export const boxChars = {
  /** Light box-drawing (default) */
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
  /** Rounded corners */
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
  /** Heavy box-drawing */
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

// Comprehensive ANSI escape sequence regex (CSI, OSC, and character set sequences)
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\([A-Z])/g;

/** Strip ANSI escape codes from a string for width calculation */
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

/**
 * Sanitize a user-controlled string for safe terminal display.
 * Strips all ANSI escape sequences that could manipulate the terminal.
 */
export function sanitizeForDisplay(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

/** Minimum inner width for rendered boxes and cards */
export const MIN_BOX_WIDTH = 20;

/** Standard label width for detail views (accommodates labels like "External ID:") */
export const DETAIL_LABEL_WIDTH = 14;

/** Draw a horizontal line with optional label */
export function horizontalLine(width: number, style: BoxStyle = 'light'): string {
  return boxChars[style].horizontal.repeat(width);
}

/** Draw a vertical line character */
export function verticalLine(style: BoxStyle = 'light'): string {
  return boxChars[style].vertical;
}

/**
 * Render a box with border around content lines.
 * Strips ANSI codes for width calculation, preserves them in output.
 */
export function renderBox(
  lines: string[],
  options: { style?: BoxStyle; padding?: number; colorFn?: ColorFn } = {}
): string {
  const { style = 'rounded', padding = 1, colorFn = colors.muted } = options;
  const chars = boxChars[style];
  const pad = ' '.repeat(padding);

  const contentWidths = lines.map((l) => stripAnsi(l).length);
  const innerWidth = Math.max(...contentWidths, MIN_BOX_WIDTH) + padding * 2;

  const result: string[] = [];
  result.push(colorFn(chars.topLeft + chars.horizontal.repeat(innerWidth) + chars.topRight));

  for (const line of lines) {
    const visibleLen = stripAnsi(line).length;
    const rightPad = ' '.repeat(Math.max(0, innerWidth - padding * 2 - visibleLen));
    result.push(colorFn(chars.vertical) + pad + line + rightPad + pad + colorFn(chars.vertical));
  }

  result.push(colorFn(chars.bottomLeft + chars.horizontal.repeat(innerWidth) + chars.bottomRight));
  return result.join('\n');
}

/**
 * Render a card with title bar and content body.
 */
export function renderCard(
  title: string,
  lines: string[],
  options: { style?: BoxStyle; colorFn?: ColorFn } = {}
): string {
  const { style = 'rounded', colorFn = colors.muted } = options;
  const chars = boxChars[style];

  const safeTitle = sanitizeForDisplay(title);
  const contentWidths = lines.map((l) => stripAnsi(l).length);
  const titleWidth = safeTitle.length;
  const innerWidth = Math.max(...contentWidths, titleWidth, MIN_BOX_WIDTH) + 2;

  const result: string[] = [];
  // Top border
  result.push(colorFn(chars.topLeft + chars.horizontal.repeat(innerWidth) + chars.topRight));
  // Title line
  const titlePad = ' '.repeat(Math.max(0, innerWidth - titleWidth - 2));
  result.push(colorFn(chars.vertical) + ' ' + colors.highlight(safeTitle) + titlePad + ' ' + colorFn(chars.vertical));
  // Separator
  result.push(colorFn(chars.teeRight + chars.horizontal.repeat(innerWidth) + chars.teeLeft));
  // Content lines
  for (const line of lines) {
    const visibleLen = stripAnsi(line).length;
    const rightPad = ' '.repeat(Math.max(0, innerWidth - visibleLen - 2));
    result.push(colorFn(chars.vertical) + ' ' + line + rightPad + ' ' + colorFn(chars.vertical));
  }
  // Bottom border
  result.push(colorFn(chars.bottomLeft + chars.horizontal.repeat(innerWidth) + chars.bottomRight));
  return result.join('\n');
}

// ============================================================================
// BANNER & WELCOME
// ============================================================================

// Re-export getRandomQuote for external use
export { getRandomQuote } from './index.ts';

/**
 * Show the themed banner with gradient styling.
 * Falls back to flat color when colors are not supported.
 */
export function showBanner(): void {
  if (isColorSupported) {
    console.log(gradients.donut.multiline(banner.art));
  } else {
    console.log(banner.art);
  }
  const quote = getRandomQuote();
  console.log(colors.muted(`  "${quote}"\n`));
}

// ============================================================================
// SECTION HEADERS (simpler style)
// ============================================================================

/**
 * Format a section header with icon
 */
export function section(title: string, icon?: string): string {
  const prefix = icon ? `${icon} ` : '';
  return '\n' + colors.info(prefix + title) + '\n';
}

/**
 * Format a subsection header
 */
export function subsection(title: string): string {
  return colors.muted(`  ${title}`);
}

// ============================================================================
// FIELD FORMATTING (consistent alignment)
// ============================================================================

/**
 * Format a labeled field with consistent padding
 * @param label - Field label (e.g., "ID", "Name")
 * @param value - Field value
 * @param labelWidth - Width for label column (default 12)
 */
export function field(label: string, value: string, labelWidth = 12): string {
  const paddedLabel = (label + ':').padEnd(labelWidth);
  return `${INDENT}${colors.muted(paddedLabel)} ${value}`;
}

/**
 * Format multiple fields as aligned rows
 */
export function fields(items: [string, string][], labelWidth = 12): string {
  return items.map(([label, value]) => field(label, value, labelWidth)).join('\n');
}

/**
 * Format a multiline field with proper indentation
 * First line shows label, subsequent lines are indented to align
 */
export function fieldMultiline(label: string, value: string, labelWidth = 12): string {
  const lines = value.split('\n');
  const paddedLabel = (label + ':').padEnd(labelWidth);
  const indent = INDENT + ' '.repeat(labelWidth + 1);

  if (lines.length === 1) {
    return `${INDENT}${colors.muted(paddedLabel)} ${value}`;
  }

  const firstLine = lines[0] ?? '';
  const result: string[] = [];
  result.push(`${INDENT}${colors.muted(paddedLabel)} ${firstLine}`);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    result.push(`${indent}${line}`);
  }
  return result.join('\n');
}

// ============================================================================
// STATUS FORMATTING
// ============================================================================

/**
 * Format a status with emoji
 */
export function formatStatus(status: string): string {
  const emoji = getStatusEmoji(status);
  return `${emoji} ${status}`;
}

/**
 * Format task status for display
 */
export function formatTaskStatus(status: 'todo' | 'in_progress' | 'done'): string {
  const emoji = getStatusEmoji(status);
  const labels: Record<string, string> = {
    todo: 'To Do',
    in_progress: 'In Progress',
    done: 'Done',
  };
  const statusColors: Record<string, ColorFn> = {
    todo: colors.muted,
    in_progress: colors.warning,
    done: colors.success,
  };
  const colorFn = statusColors[status] ?? colors.muted;
  return colorFn(`${emoji} ${labels[status] ?? status}`);
}

/**
 * Format sprint status for display
 */
export function formatSprintStatus(status: 'draft' | 'active' | 'closed'): string {
  const emoji = getStatusEmoji(status);
  const labels: Record<string, string> = {
    draft: 'Draft',
    active: 'Active',
    closed: 'Closed',
  };
  const statusColors: Record<string, ColorFn> = {
    draft: colors.warning,
    active: colors.success,
    closed: colors.muted,
  };
  const colorFn = statusColors[status] ?? colors.muted;
  return colorFn(`${emoji} ${labels[status] ?? status}`);
}

/**
 * Format a badge (inline status indicator)
 */
export function badge(text: string, type: 'success' | 'warning' | 'error' | 'muted' = 'muted'): string {
  const colorFn = colors[type];
  return colorFn(`[${text}]`);
}

// ============================================================================
// SUMMARY & STATS
// ============================================================================

/**
 * Print a summary line with label and value
 */
export function printSummary(items: [string, string | number][]): void {
  printSeparator();
  for (const [label, value] of items) {
    console.log(`${INDENT}${colors.muted(label)}  ${colors.highlight(String(value))}`);
  }
}

/**
 * Print a count summary (e.g., "5/10 tasks done (50%)")
 */
export function printCountSummary(label: string, done: number, total: number): void {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const color = percent === 100 ? colors.success : percent > 50 ? colors.warning : colors.muted;
  printSeparator();
  console.log(`${INDENT}${label}  ${color(`${String(done)}/${String(total)} (${String(percent)}%)`)}`);
}

// ============================================================================
// MESSAGES
// ============================================================================

/**
 * Show a success message with optional details
 */
export function showSuccess(message: string, details?: [string, string][]): void {
  console.log('\n' + `${INDENT}${colors.success(icons.success)}  ${colors.success(message)}`);
  if (details) {
    console.log(fields(details));
  }
}

/**
 * Show an error message
 */
export function showError(message: string): void {
  console.log('\n' + `${INDENT}${colors.error(icons.error)}  ${colors.error(message)}`);
}

/**
 * Show an info message
 */
export function showInfo(message: string): void {
  console.log(colors.info(message));
}

/**
 * Show a warning message
 */
export function showWarning(message: string): void {
  console.log(`${INDENT}${colors.warning(icons.warning)}  ${colors.warning(message)}`);
}

/**
 * Show a tip/hint
 */
export function showTip(message: string): void {
  console.log(`${INDENT}${colors.muted(icons.tip + ' ' + message)}`);
}

/**
 * Show a themed message for a specific action
 */
export function showThemedMessage(key: keyof typeof import('./index.ts').messages): void {
  console.log(colors.success(getMessage(key)));
}

/**
 * Show an empty state with helpful next action
 */
export function showEmpty(what: string, hint?: string): void {
  console.log('\n' + `${INDENT}${colors.muted(icons.inactive)}  ${colors.muted(`No ${what} yet.`)}`);
  if (hint) {
    console.log(`${INDENT}   ${colors.muted(icons.tip + ' ' + hint)}\n`);
  }
}

// ============================================================================
// NEXT STEPS / HINTS
// ============================================================================

/**
 * Show next step suggestion (single)
 */
export function showNextStep(command: string, description?: string): void {
  const desc = description ? ` ${colors.muted('- ' + description)}` : '';
  console.log(`${INDENT}${colors.muted('→')} ${colors.highlight(command)}${desc}`);
}

/**
 * Show multiple next step suggestions compactly
 */
export function showNextSteps(steps: [command: string, description?: string][]): void {
  for (const [command, description] of steps) {
    showNextStep(command, description);
  }
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

/**
 * Format a header/section title
 */
export function formatHeader(text: string): string {
  return colors.info(text);
}

/**
 * Format muted/secondary text
 */
export function formatMuted(text: string): string {
  return colors.muted(text);
}

/**
 * Format highlighted text
 */
export function formatHighlight(text: string): string {
  return colors.highlight(text);
}

/**
 * Show a random Ralph quote
 */
export function showRandomQuote(): void {
  const quote = getRandomQuote();
  console.log(colors.muted(`  "${quote}"`));
}

// ============================================================================
// MENU ITEM FORMATTING
// ============================================================================

/**
 * Format a menu item with icon, label (padded), and description
 * @param icon - Icon character
 * @param label - Menu item label (will be padded)
 * @param description - Dimmed description
 * @param labelWidth - Width for label padding (default 14)
 */
export function menuItem(icon: string, label: string, description: string, labelWidth = 14): string {
  const paddedLabel = label.padEnd(labelWidth);
  return `${colors.highlight(icon)}  ${paddedLabel}  ${colors.muted(description)}`;
}

// ============================================================================
// SPINNER
// ============================================================================

/**
 * Create a spinner for async operations
 */
export function createSpinner(text: string): Ora {
  return ora({
    text,
    color: 'yellow',
    prefixText: INDENT,
    spinner: {
      interval: 80,
      frames: Array(8)
        .fill(emoji.donut)
        .map((d: string, i) => (i % 2 === 0 ? colors.highlight(d) : colors.muted(d))),
    },
  });
}

// ============================================================================
// ANIMATION HELPERS
// ============================================================================

/**
 * Check if the current output supports interactive features (TTY).
 * Returns false for piped output, CI environments, or when NO_COLOR is set.
 */
export function isTTY(): boolean {
  if (!process.stdout.isTTY || process.env['NO_COLOR']) return false;
  return true;
}

/**
 * Typewriter effect: prints text one character at a time.
 * Falls back to instant print when not a TTY.
 * @param text - Text to display
 * @param delayMs - Delay between characters (default 30ms)
 */
export async function typewriter(text: string, delayMs = 30): Promise<void> {
  if (!isTTY()) {
    console.log(text);
    return;
  }
  for (const char of text) {
    process.stdout.write(char);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  process.stdout.write('\n');
}

/**
 * Progressive reveal: prints lines one at a time with a delay.
 * Falls back to printing all lines at once when not a TTY.
 * @param lines - Lines to reveal progressively
 * @param delayMs - Delay between lines (default 50ms)
 */
export async function progressiveReveal(lines: string[], delayMs = 50): Promise<void> {
  if (!isTTY()) {
    for (const line of lines) {
      console.log(line);
    }
    return;
  }
  for (const line of lines) {
    console.log(line);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

// ============================================================================
// TERMINAL BELL
// ============================================================================

/**
 * Ring the terminal bell to notify the user.
 * No-op when not a TTY (piped output, CI, etc.).
 */
export function terminalBell(): void {
  if (isTTY()) {
    process.stdout.write('\x07');
  }
}

// ============================================================================
// ENHANCED SPINNERS
// ============================================================================

/** Spinner variant presets */
export type SpinnerVariant = 'donut' | 'sprinkle' | 'minimal';

/**
 * Create a themed spinner with a variant style.
 * @param text - Spinner message
 * @param variant - Visual style: 'donut' (default), 'sprinkle', 'minimal'
 */
export function createThemedSpinner(text: string, variant: SpinnerVariant = 'donut'): Ora {
  const spinnerConfig: Record<SpinnerVariant, { interval: number; frames: string[] }> = {
    donut: {
      interval: 80,
      frames: Array(8)
        .fill(emoji.donut)
        .map((d: string, i: number) => (i % 2 === 0 ? colors.highlight(d) : colors.muted(d))),
    },
    sprinkle: {
      interval: 120,
      frames: ['🍩', '🍪', '🧁', '🍰', '🎂', '🍰', '🧁', '🍪'],
    },
    minimal: {
      interval: 100,
      frames: ['·', '•', '●', '•'],
    },
  };

  return ora({
    text,
    color: 'yellow',
    prefixText: INDENT,
    spinner: spinnerConfig[variant],
  });
}

// ============================================================================
// CLEAR SCREEN
// ============================================================================

/**
 * Clear the terminal screen.
 * No-op when not a TTY (piped output, CI, etc.).
 */
export function clearScreen(): void {
  if (isTTY()) {
    process.stdout.write('\x1B[2J\x1B[0f');
  }
}

// ============================================================================
// PROGRESS BAR
// ============================================================================

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

// ============================================================================
// TABLE RENDERER
// ============================================================================

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
  const { style = 'light', indent = 2, colorFn = colors.muted } = options;
  const chars = boxChars[style];
  const pad = ' '.repeat(indent);

  // Calculate column widths (ANSI-safe)
  const colWidths = columns.map((col, i) => {
    const headerWidth = col.header.length;
    const dataWidth = Math.max(0, ...rows.map((row) => stripAnsi(row[i] ?? '').length));
    return Math.max(headerWidth, dataWidth, col.minWidth ?? 0);
  });

  const result: string[] = [];

  // Top border
  const topLine = colWidths.map((w) => chars.horizontal.repeat(w + 2)).join(chars.teeDown);
  result.push(pad + colorFn(chars.topLeft + topLine + chars.topRight));

  // Header row
  const headerCells = columns.map((col, i) => {
    const w = colWidths[i] ?? 0;
    return ' ' + colors.highlight(col.header.padEnd(w)) + ' ';
  });
  result.push(pad + colorFn(chars.vertical) + headerCells.join(colorFn(chars.vertical)) + colorFn(chars.vertical));

  // Header separator
  const sepLine = colWidths.map((w) => chars.horizontal.repeat(w + 2)).join(chars.cross);
  result.push(pad + colorFn(chars.teeRight + sepLine + chars.teeLeft));

  // Data rows
  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const w = colWidths[i] ?? 0;
      const cell = row[i] ?? '';
      const visibleLen = stripAnsi(cell).length;
      const padding = Math.max(0, w - visibleLen);
      const coloredCell = col.color ? col.color(cell) : cell;
      if (col.align === 'right') {
        return ' ' + ' '.repeat(padding) + coloredCell + ' ';
      }
      return ' ' + coloredCell + ' '.repeat(padding) + ' ';
    });
    result.push(pad + colorFn(chars.vertical) + cells.join(colorFn(chars.vertical)) + colorFn(chars.vertical));
  }

  // Bottom border
  const bottomLine = colWidths.map((w) => chars.horizontal.repeat(w + 2)).join(chars.teeUp);
  result.push(pad + colorFn(chars.bottomLeft + bottomLine + chars.bottomRight));

  return result.join('\n');
}

// ============================================================================
// COLUMN LAYOUT
// ============================================================================

export interface ColumnOptions {
  gap?: number;
  minWidth?: number;
}

export function renderColumns(blocks: string[][], options: ColumnOptions = {}): string {
  const { gap = 4, minWidth = 20 } = options;
  const colCount = blocks.length;
  if (colCount === 0) return '';
  if (colCount === 1) return (blocks[0] ?? []).join('\n');

  // Calculate width of each block
  const widths = blocks.map((lines) => Math.max(minWidth, ...lines.map((l) => stripAnsi(l).length)));

  // Find max line count
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

// ============================================================================
// PROGRESS SUMMARY
// ============================================================================

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
