/**
 * ViewShell — the standard frame every TUI view lives inside.
 *
 * Layout (top to bottom):
 *
 *   <Banner />                ← persistent gradient wordmark (stable per-process)
 *   <SectionStamp title />    ← omitted on Home (`bare`) — Home owns its own
 *                                summary line + pipeline map below the banner
 *   {children}                ← view body
 *   <PromptHost />            ← inline prompts            (owned by the router)
 *   <KeyboardHints />         ← view-local hotkeys        (owned by the router)
 *   <StatusBar />             ← breadcrumb + globals      (owned by the router)
 *
 * The banner now lives here — not just on Home — so the eye has a constant
 * anchor when navigating. Without it, screen heights differ between views
 * and the layout jitters.
 *
 * `bare` — Home opt-in: skips the SectionStamp. Banner still renders.
 */

import React from 'react';
import { Box } from 'ink';
import { spacing } from '../../../integration/ui/theme/tokens.ts';
import { SectionStamp } from './section-stamp.tsx';
import { Banner } from './banner.tsx';
import { useGlobalKeys } from '../views/use-global-keys.ts';

interface Props {
  /** Shown in SectionStamp. Required unless `bare` is set. */
  readonly title?: string;
  /** Skip the SectionStamp — used by Home. The banner still renders. */
  readonly bare?: boolean;
  readonly children: React.ReactNode;
}

export function ViewShell({ title, bare = false, children }: Props): React.JSX.Element {
  useGlobalKeys();
  return (
    <Box flexDirection="column">
      <Banner />
      {!bare && title !== undefined ? <SectionStamp title={title} /> : null}
      <Box marginTop={bare ? 0 : spacing.section} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
