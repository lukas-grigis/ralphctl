/**
 * Theme tokens for Ink components.
 *
 * `src/theme/index.ts` holds the canonical design tokens (colors, gradients,
 * Ralph quotes, banner, emoji). This module translates them into the shape
 * Ink consumes — mostly `<Text color="...">` prop values.
 *
 * Keep this file small: business logic doesn't belong here. Component-level
 * styling that's specific to one view lives with that component.
 */

export { colors, emoji, gradients, getRandomQuote, getStatusEmoji } from '@src/integration/ui/theme/theme.ts';

/**
 * Ink's `color` prop accepts a limited palette (ANSI names or hex). These
 * match the semantic names used in `theme/index.ts` but map to Ink-friendly
 * values. Where a token uses `bold` or `dim`, the component should apply the
 * corresponding prop (`<Text bold>` / `<Text dimColor>`) rather than picking a
 * color here.
 */
export const inkColors = {
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
  muted: 'gray',
  highlight: 'yellow',
  primary: 'yellow',
  secondary: 'magenta',
} as const;

export type InkColorName = (typeof inkColors)[keyof typeof inkColors];
