/**
 * SettingsView — router destination wrapper around `<SettingsPanel />`.
 *
 * The panel itself stays a plain component (still used by ExecuteView's
 * inline overlay until that view is migrated). This wrapper just bridges its
 * `onClose` callback to the router's `pop()`. The router also pops on Esc at
 * the global level — the duplicate call is a no-op because `pop()` is guarded
 * by `stack.length > 1`.
 */

import React from 'react';
import { useRouter } from './router-context.ts';
import { SettingsPanel } from './settings-panel.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';

export function SettingsView(): React.JSX.Element {
  const router = useRouter();
  return (
    <ViewShell title="Settings">
      <SettingsPanel
        onClose={() => {
          router.pop();
        }}
      />
    </ViewShell>
  );
}
