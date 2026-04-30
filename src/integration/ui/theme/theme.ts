/**
 * Plain-text CLI theme helpers for src.
 *
 * Ported from src/integration/ui/theme/theme.ts — no legacy src/ imports.
 * Uses colorette for semantic color functions and gradient-string for banner
 * gradients. This module is the plain-text surface; Ink views use tokens.ts.
 */

import { bold, cyan, gray, green, red, yellow } from 'colorette';
import gradient from 'gradient-string';

export { isColorSupported } from 'colorette';

/**
 * Emoji set shared by Ink prompt components and plain-text output.
 * Distinct from the ASCII icons set in ui.ts, which is rendered verbatim
 * in environments that can't show emoji reliably.
 */
export const emoji = {
  donut: '🍩',
} as const;

// ── Color functions ───────────────────────────────────────────────────────────

export type ColorFn = (text: string | number) => string;

export const colors = {
  success: green,
  error: red,
  warning: yellow,
  info: cyan,
  muted: gray,
  highlight: yellow,
  accent: bold,
} as const;

export const success = (text: string): string => colors.success(text);
export const error = (text: string): string => colors.error(text);
export const muted = (text: string): string => colors.muted(text);

// ── Gradient rendering (powered by gradient-string) ───────────────────────────

export const gradients = {
  /** Gold → Orange → Hot Pink → Orchid → Violet (Ralph's signature donut warmth) */
  donut: gradient(['#FFD700', '#FFA500', '#FF69B4', '#DA70D6', '#9400D3'], {
    interpolation: 'hsv',
    hsvSpin: 'short',
  }),
  /** Green → Dark Cyan (success/completion) */
  success: gradient(['#00FF00', '#00CED1']),
  /** Orange Red → Gold (warning/attention) */
  warning: gradient(['#FF4500', '#FFD700']),
} as const;

// ── Banner ────────────────────────────────────────────────────────────────────

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

// ── Quotes ────────────────────────────────────────────────────────────────────

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

export type QuoteCategory = 'error' | 'success' | 'farewell' | 'idle';

export const QUOTES_BY_CATEGORY: Record<QuoteCategory, readonly string[]> = {
  error: [
    'My tummy hurts!',
    'Tastes like burning!',
    'I ate the purple berries...',
    "The doctor said I wouldn't have so many nose bleeds if I kept my finger outta there.",
    "My parents won't let me use scissors.",
    'Principal Skinner, I got carsick in your office.',
  ],
  success: [
    "I'm helping!",
    'Go banana!',
    "I'm learnding!",
    "I'm a unitard!",
    'I dress myself!',
    'I picked the red one!',
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
  ],
} as const;

export function getQuoteForContext(category: QuoteCategory): string {
  const quotes = QUOTES_BY_CATEGORY[category];
  const index = Math.floor(Math.random() * quotes.length);
  return quotes[index] ?? '';
}

export const statusEmoji = {
  todo: '📝',
  in_progress: '🏃',
  done: '✅',
  blocked: '🚫',
  cancelled: '🛑',
  skipped: '⏭️',
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
