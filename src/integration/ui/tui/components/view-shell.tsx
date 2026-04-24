/**
 * ViewShell — the standard frame every TUI view lives inside.
 *
 * Contract (see .claude/docs/REQUIREMENTS.md § UI Contract):
 *
 *   <ViewShell>               ← [SectionStamp title + body]
 *   <PromptHost />            ← [inline prompts]         owned by the router
 *   <KeyboardHints />         ← [view-local hotkeys]     owned by the router
 *   <StatusBar />             ← [breadcrumb + globals]   owned by the router
 *
 * ViewShell owns the *top half*: the section stamp header and the body's
 * internal spacing. Views pass their title + children; the router handles the
 * chrome below.
 *
 * `bare` — opt-out for Home (banner + pipeline map replaces the SectionStamp).
 */

import React from 'react';
import { Box } from 'ink';
import { spacing } from '@src/integration/ui/theme/tokens.ts';
import { SectionStamp } from '@src/integration/ui/tui/components/section-stamp.tsx';
import { useGlobalKeys } from '@src/integration/ui/tui/runtime/use-global-keys.ts';

interface Props {
  /** Shown in SectionStamp. Required unless `bare` is set. */
  readonly title?: string;
  /** Skip the SectionStamp — used by Home (has its own banner). */
  readonly bare?: boolean;
  readonly children: React.ReactNode;
}

export function ViewShell({ title, bare = false, children }: Props): React.JSX.Element {
  useGlobalKeys();
  return (
    <Box flexDirection="column">
      {!bare && title !== undefined ? <SectionStamp title={title} /> : null}
      <Box marginTop={bare ? 0 : spacing.section} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
