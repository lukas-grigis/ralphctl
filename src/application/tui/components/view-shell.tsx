/**
 * ViewShell — the standard frame every TUI view lives inside.
 *
 * Layout (top to bottom):
 *
 *   <Banner />                ← full gradient wordmark + quote on every view
 *   <SectionStamp title />    ← omitted when `bare`
 *   {children}                ← view body — flexGrow=1 so it claims the
 *                                remaining vertical space
 *   <PromptHost />            ← inline prompts            (owned by the router)
 *   <KeyboardHints />         ← view-local hotkeys        (owned by the router)
 *   <StatusBar />             ← breadcrumb + globals      (owned by the router)
 *
 * The Banner is tight (no inner paddingY, quote one line below the art) so
 * it docks to the top without pushing content off-screen on small terminals.
 * The view body grows to fill what's left.
 *
 * `bare` — Home opt-in: skips the SectionStamp (Home owns its own header).
 */

import React from 'react';
import { Box } from 'ink';
import { spacing } from '@src/integration/ui/theme/tokens.ts';
import { SectionStamp } from './section-stamp.tsx';
import { Banner } from './banner.tsx';

interface Props {
  /** Shown in SectionStamp. Required unless `bare` is set. */
  readonly title?: string;
  /** Skip the SectionStamp — used by Home (Banner still renders). */
  readonly bare?: boolean;
  readonly children: React.ReactNode;
}

// Note: global hotkeys are owned by GlobalKeyHandler in view-router.tsx —
// installing them per-view here would fire each Esc / h / s / d / q
// dispatch multiple times.
export function ViewShell({ title, bare = false, children }: Props): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Banner />
      {!bare && title !== undefined ? <SectionStamp title={title} /> : null}
      <Box marginTop={bare ? 0 : spacing.section} flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
