import ora, { type Ora } from 'ora';
import { banner, type ColorFn, colors, getMessage, getRandomQuote, getStatusEmoji } from './index.ts';

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
// BANNER & WELCOME
// ============================================================================

// Re-export getRandomQuote for external use
export { getRandomQuote } from './index.ts';

/**
 * Show the themed banner - clean and simple
 */
export function showBanner(): void {
  console.log(colors.highlight(banner.art));
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
export function showNextSteps(steps: Array<[command: string, description?: string]>): void {
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
// CLEAR SCREEN
// ============================================================================

/**
 * Clear the terminal screen
 */
export function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[0f');
}
