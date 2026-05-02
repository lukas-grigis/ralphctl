/**
 * Banner + gradient + quote pool for the persistent home banner.
 *
 * Ink colour tokens live in `tokens.ts`. This file is banner / gradient /
 * quote scaffolding — owned by the Ink banner component.
 */

import gradient from 'gradient-string';

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

const RALPH_QUOTES = [
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
