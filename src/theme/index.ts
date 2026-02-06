import { bold, cyan, dim, gray, green, isColorSupported, magenta, red, yellow, yellowBright } from 'colorette';

// Re-export colorette functions for direct usage
export { cyan, green, red, yellow, blue, gray, bold, dim, isColorSupported } from 'colorette';

// ============================================================================
// COLOR FUNCTIONS
// ============================================================================

/**
 * Color function type (matches colorette signature)
 */
export type ColorFn = (text: string | number) => string;

/**
 * Theme color mappings
 */
export const colors = {
  // Semantic colors
  success: green,
  error: red,
  warning: yellow,
  info: cyan,
  muted: gray,
  highlight: yellow,
  accent: bold,
  subtle: dim,
  // Ralph-specific
  primary: yellow,
  secondary: magenta,
} as const;

// Semantic color shortcuts (replaces utils/colors.ts)
export const success = (text: string): string => colors.success(text);
export const error = (text: string): string => colors.error(text);
export const warning = (text: string): string => colors.warning(text);
export const info = (text: string): string => colors.info(text);
export const muted = (text: string): string => colors.muted(text);
export const highlight = (text: string): string => colors.highlight(text);
export const accent = (text: string): string => colors.accent(text);
export const subtle = (text: string): string => colors.subtle(text);
export const primary = (text: string): string => colors.primary(text);
export const secondary = (text: string): string => colors.secondary(text);

// ============================================================================
// GRADIENT RENDERING
// ============================================================================

/**
 * Gradient color stop: a colorette color function applied at a position (0-1)
 */
export interface GradientStop {
  position: number;
  color: ColorFn;
}

/**
 * Built-in gradient presets for banner/header styling.
 * Each preset is an array of color stops from left to right.
 */
export const gradients = {
  /** Yellow → Magenta (Ralph's signature donut warmth) */
  donut: [
    { position: 0, color: yellow },
    { position: 0.5, color: yellowBright },
    { position: 1, color: magenta },
  ],
  /** Green → Cyan (success/completion) */
  success: [
    { position: 0, color: green },
    { position: 1, color: cyan },
  ],
  /** Red → Yellow (warning/attention) */
  warning: [
    { position: 0, color: red },
    { position: 1, color: yellow },
  ],
} as const;

/**
 * Apply a gradient across a text string by coloring each character
 * according to its position within the gradient stops.
 * Falls back to plain text when colors are not supported.
 */
export function applyGradient(text: string, stops: readonly GradientStop[]): string {
  if (!isColorSupported || stops.length === 0 || text.length === 0) {
    return text;
  }

  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return text;

  if (sorted.length === 1) {
    return first.color(text);
  }

  const chars = text.split('');

  return chars
    .map((char, i) => {
      if (char === ' ' || char === '\n') return char;
      const t = chars.length === 1 ? 0 : i / (chars.length - 1);
      // Find the two stops surrounding position t
      let lower = first;
      let upper = last;
      for (let s = 0; s < sorted.length - 1; s++) {
        const current = sorted[s];
        const next = sorted[s + 1];
        if (current && next && t >= current.position && t <= next.position) {
          lower = current;
          upper = next;
          break;
        }
      }
      // Pick the closer stop's color (discrete color stepping)
      const mid = (lower.position + upper.position) / 2;
      const colorFn = t <= mid ? lower.color : upper.color;
      return colorFn(char);
    })
    .join('');
}

/**
 * Apply a gradient to each line of a multi-line string independently.
 * Useful for banner art where each line should have its own gradient.
 */
export function applyGradientLines(text: string, stops: readonly GradientStop[]): string {
  return text
    .split('\n')
    .map((line) => applyGradient(line, stops))
    .join('\n');
}

// ============================================================================
// BANNER
// ============================================================================

const BANNER = `
  🍩 ██████╗  █████╗ ██╗     ██████╗ ██╗  ██╗ ██████╗████████╗██╗     🍩
     ██╔══██╗██╔══██╗██║     ██╔══██╗██║  ██║██╔════╝╚══██╔══╝██║
     ██████╔╝███████║██║     ██████╔╝███████║██║        ██║   ██║
     ██╔══██╗██╔══██║██║     ██╔═══╝ ██╔══██║██║        ██║   ██║
     ██║  ██║██║  ██║███████╗██║     ██║  ██║╚██████╗   ██║   ███████╗
     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚══════╝
`;

export const banner = {
  art: BANNER,
  tagline: "I'm helping with your sprints!",
} as const;

// ============================================================================
// QUOTES
// ============================================================================

export const RALPH_QUOTES = [
  "I'm helping!",
  "Me fail English? That's unpossible!",
  'Go banana!',
  'Hi, Super Nintendo Chalmers!',
  'I bent my wookie.',
  "My cat's breath smells like cat food.",
  "I'm learnding!",
  "The doctor said I wouldn't have so many nose bleeds if I kept my finger outta there.",
  'I found a moonrock in my nose!',
  "That's where I saw the leprechaun. He told me to burn things.",
  "My daddy's gonna put you in jail!",
  "I'm a unitard!",
  'I ate the purple berries...',
  'Tastes like burning!',
  "My parents won't let me use scissors.",
  'I dress myself!',
  'Principal Skinner, I got carsick in your office.',
  "I'm Idaho!",
  'Mrs. Krabappel and Principal Skinner were in the closet making babies!',
  'Even my boogers are spicy!',
  'It smells like hot dogs.',
  'I sleep in a drawer!',
  'I picked the red one!',
  'The pointy kitty took it!',
  'When I grow up, I want to be a principal or a caterpillar.',
] as const;

export function getRandomQuote(): string {
  const index = Math.floor(Math.random() * RALPH_QUOTES.length);
  return RALPH_QUOTES[index] ?? '';
}

// ============================================================================
// CONTEXT-SENSITIVE QUOTES
// ============================================================================

export type QuoteCategory = 'error' | 'success' | 'farewell' | 'idle';

export const QUOTES_BY_CATEGORY: Record<QuoteCategory, readonly string[]> = {
  error: [
    'My tummy hurts!',
    'Tastes like burning!',
    'I ate the purple berries...',
    "The doctor said I wouldn't have so many nose bleeds if I kept my finger outta there.",
    "My parents won't let me use scissors.",
    'Principal Skinner, I got carsick in your office.',
    'I eated the purple berries. They taste like... burning.',
  ],
  success: [
    "I'm helping!",
    'Go banana!',
    "I'm learnding!",
    "I'm a unitard!",
    'I dress myself!',
    'I picked the red one!',
    'I found a moonrock in my nose!',
    "Yay! I'm a helper!",
  ],
  farewell: [
    "Bye bye! My cat's breath smells like cat food!",
    'When I grow up, I want to be a principal or a caterpillar.',
    'I sleep in a drawer!',
    "I'm Idaho!",
    'The pointy kitty took it!',
  ],
  idle: [
    'Hi, Super Nintendo Chalmers!',
    'I bent my wookie.',
    "My cat's breath smells like cat food.",
    'It smells like hot dogs.',
    "That's where I saw the leprechaun. He told me to burn things.",
    "Me fail English? That's unpossible!",
    'Even my boogers are spicy!',
    'Mrs. Krabappel and Principal Skinner were in the closet making babies!',
  ],
} as const;

/**
 * Get a random quote appropriate for the given context category.
 */
export function getQuoteForContext(category: QuoteCategory): string {
  const quotes = QUOTES_BY_CATEGORY[category];
  const index = Math.floor(Math.random() * quotes.length);
  return quotes[index] ?? '';
}

// ============================================================================
// STATUS EMOJI
// ============================================================================

export const statusEmoji = {
  todo: '📝',
  in_progress: '🏃',
  done: '✅',
  blocked: '🚫',
  draft: '📋',
  active: '🎯',
  closed: '🎉',
} as const;

export function getStatusEmoji(status: string): string {
  if (status in statusEmoji) {
    return statusEmoji[status as keyof typeof statusEmoji];
  }
  return status;
}

// ============================================================================
// MESSAGES
// ============================================================================

export const messages = {
  welcome: "Hi, Super Nintendo Chalmers! I'm ready to help!",
  goodbye: "Bye bye! My cat's breath smells like cat food!",
  taskComplete: "Yay! I did a task! I'm a unitard!",
  sprintCreated: 'I made a sprint! Go banana!',
  sprintActivated: "The sprint is awake now! It's unpossible to fail!",
  sprintClosed: "We finished! That's where I saw the leprechaun!",
  ticketAdded: "I added a ticket! I'm learnding!",
  projectAdded: 'I found a project! It smells like hot dogs!',
  error: 'My tummy hurts:',
  confirm: 'Do you want to? I picked the red one!',
} as const;

export function getMessage(key: keyof typeof messages): string {
  return messages[key];
}
