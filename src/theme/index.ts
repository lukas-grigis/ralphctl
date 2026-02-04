import { bold, cyan, dim, gray, green, magenta, red, yellow } from 'colorette';

// Re-export colorette functions for direct usage
export { cyan, green, red, yellow, blue, gray, bold, dim } from 'colorette';

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
