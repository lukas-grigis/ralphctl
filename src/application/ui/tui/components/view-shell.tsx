/**
 * Frame every view shares — four explicit zones modelled after a standard webpage layout:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ HEADER  (fixed, never scrolls, never shrinks)│   ← banner + rule + breadcrumb
 *   ├─────────────────────────────────────────────┤
 *   │ CONTENT (scrolls when it overflows the      │   ← section stamp + page body
 *   │          viewport; clipped at the edges)    │     inside a ScrollRegion
 *   ├─────────────────────────────────────────────┤
 *   │ PROMPT  (fixed; collapses when no prompt)   │   ← modal Question card from PromptHost
 *   ├─────────────────────────────────────────────┤
 *   │ FOOTER  (fixed, never scrolls, never shrinks)│   ← rule + status bar
 *   └─────────────────────────────────────────────┘
 *
 * The fixed zones are wrapped in their own `flexShrink={0}` boxes — without that, Yoga is
 * free to compress them when the inner content is taller than the terminal, which is exactly
 * what we want to avoid (a "fixed footer" that disappears when content overflows isn't fixed).
 *
 * The prompt slot pins the queued Question card above the footer so the keyboard hints stay
 * visible while the user answers. The PromptHost returns null when the queue is empty so this
 * row collapses to zero height between prompts.
 *
 * The section stamp lives INSIDE the scroll region rather than the header — it's per-view
 * metadata that scrolls with the page body. The banner + breadcrumb are global anchors that
 * stay put across navigation.
 *
 * The wordmark `'full'` banner is reserved for the home view; every other view defaults to a
 * single-line compact strip so the viewport stays content-first.
 */

import React from 'react';
import { Box } from 'ink';
import { Banner } from '@src/application/ui/tui/components/banner.tsx';
import { Breadcrumb } from '@src/application/ui/tui/components/breadcrumb.tsx';
import { SectionStamp } from '@src/application/ui/tui/components/section-stamp.tsx';
import { StatusBar } from '@src/application/ui/tui/components/status-bar.tsx';
import { ScrollRegion } from '@src/application/ui/tui/components/scroll-region.tsx';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export interface ViewShellProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly right?: React.ReactNode;
  /**
   * View-level banner preference:
   *   - `true` → render the compact two-row strip (long-running flows pass this so the wordmark
   *     doesn't eat vertical real estate from the task stream).
   *   - `undefined` (default) → let the {@link Banner} auto-switch on terminal width (full above
   *     `MIN_FULL_WIDTH`, compact below).
   *
   * Precedence: a user `b`-toggle (`UiState.bannerCompact`) always wins; this prop is the
   * fallback the view declares; absent both, Banner's width-based auto-switch applies.
   */
  readonly compactBanner?: boolean;
  readonly children: React.ReactNode;
}

export const ViewShell = ({ title, subtitle, right, compactBanner, children }: ViewShellProps): React.JSX.Element => {
  const ui = useUiState();
  const queue = usePromptQueue();
  // Precedence: user toggle (`bannerCompact`) wins over the view's `compactBanner` prop, which
  // wins over `Banner`'s internal width-based auto-switch. When neither is set we pass
  // `undefined` so the auto-switch fires.
  const banner = ui.bannerCompact ? true : compactBanner;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* ── HEADER ─────────────────────────────────────────────────────────────────────── */}
      <Box flexDirection="column" flexShrink={0}>
        <Banner {...(banner !== undefined ? { compact: banner } : {})} />
        <Breadcrumb />
      </Box>

      {/* ── CONTENT ────────────────────────────────────────────────────────────────────── */}
      <ScrollRegion disabled={ui.promptActive || ui.helpOpen}>
        <SectionStamp title={title} subtitle={subtitle} right={right} />
        {children}
      </ScrollRegion>

      {/* ── PROMPT ─────────────────────────────────────────────────────────────────────── */}
      {/* Sits above the footer so the modal isn't pushed off the bottom of the screen.
          The host renders null when the queue is empty, so this slot collapses. */}
      <Box flexDirection="column" flexShrink={0}>
        <PromptHost queue={queue} />
      </Box>

      {/* ── FOOTER ─────────────────────────────────────────────────────────────────────── */}
      <Box flexDirection="column" flexShrink={0}>
        <StatusBar />
      </Box>
    </Box>
  );
};
