/**
 * ViewShell — the standard frame every TUI view lives inside.
 *
 * Layout (top to bottom):
 *
 *   <Banner />                ← Home only (`bare`): full gradient wordmark
 *   <SlimWordmark />          ← every other view: 1-line `🍩 RALPHCTL` anchor
 *   <SectionStamp title />    ← omitted when `bare`
 *   {children}                ← view body
 *   <PromptHost />            ← inline prompts            (owned by the router)
 *   <KeyboardHints />         ← view-local hotkeys        (owned by the router)
 *   <StatusBar />             ← breadcrumb + globals      (owned by the router)
 *
 * Home gets the full block-letter Banner (~10 rows); every other view gets a
 * 1-row slim wordmark. The eye still has a constant anchor across navigation
 * — without burning the screen real estate on small terminals.
 *
 * `bare` — Home opt-in: full Banner instead of SlimWordmark, no SectionStamp.
 */

import React from 'react';
import { Box } from 'ink';
import { spacing } from '../../../integration/ui/theme/tokens.ts';
import { SectionStamp } from './section-stamp.tsx';
import { Banner } from './banner.tsx';
import { SlimWordmark } from './slim-wordmark.tsx';
import { useGlobalKeys } from '../views/use-global-keys.ts';

interface Props {
  /** Shown in SectionStamp. Required unless `bare` is set. */
  readonly title?: string;
  /** Skip the SectionStamp + show the full Banner instead of the SlimWordmark. */
  readonly bare?: boolean;
  readonly children: React.ReactNode;
}

export function ViewShell({ title, bare = false, children }: Props): React.JSX.Element {
  useGlobalKeys();
  return (
    <Box flexDirection="column">
      {bare ? <Banner /> : <SlimWordmark />}
      {!bare && title !== undefined ? <SectionStamp title={title} /> : null}
      <Box marginTop={bare ? 0 : spacing.section} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
