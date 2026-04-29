/**
 * StickyNotification — generic toast surface that owns its own keyboard.
 *
 * Behaviour (the contract every sticky notification in the app obeys):
 *   - 10s auto-dismiss timer starts when the component mounts. Mounting is
 *     gated on the notification id (key prop in the parent), so a new
 *     notification replacing the previous one resets the timer cleanly.
 *   - Esc dismisses without firing the action.
 *   - When `action` is bound, pressing `action.key` calls `action.run()`. On
 *     `{ ok: true }` the notification clears via `onDismiss`. On
 *     `{ ok: false, error }` the error renders inline and the notification
 *     stays visible so the user can retry or Esc-dismiss.
 *   - Both the action hint (`press <key> for <label>`) and the dismiss hint
 *     (`esc to dismiss`) render simultaneously when an action is bound.
 *     Informational notifications (no action) render only the dismiss hint.
 *
 * The component installs `useInput` itself; the global hotkey handler in
 * `use-global-keys.ts` consults the notification bus and forwards Esc + the
 * bound action key to this component instead of consuming them.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import type { Notification, NotificationStatus } from '@src/integration/ui/tui/runtime/notification-bus.ts';

export const STICKY_NOTIFICATION_TIMEOUT_MS = 10_000;

interface Props {
  readonly notification: Notification;
  readonly onDismiss: (id: string) => void;
  /** Suspend keyboard handling — used by the host while a prompt owns input. */
  readonly isInputActive?: boolean;
}

function colorFor(status: NotificationStatus): string {
  switch (status) {
    case 'success':
      return inkColors.success;
    case 'error':
      return inkColors.error;
    case 'warning':
      return inkColors.warning;
    case 'info':
      return inkColors.info;
  }
}

function glyphFor(status: NotificationStatus): string {
  switch (status) {
    case 'success':
      return glyphs.check;
    case 'error':
      return glyphs.cross;
    case 'warning':
      return glyphs.warningGlyph;
    case 'info':
      return glyphs.infoGlyph;
  }
}

export function StickyNotification({ notification, onDismiss, isInputActive = true }: Props): React.JSX.Element {
  const { id, message, status, action } = notification;
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionRunning, setActionRunning] = useState(false);

  // Track unmount so an in-flight action.run() that resolves after dismissal
  // doesn't poke React state on a stale tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Auto-dismiss timer. Reset when the user interacts with the notification
  // (action attempt) — pressing the action key on a failure-and-retry path
  // rearms the timer so the user has another full window to act.
  const [interactionCount, setInteractionCount] = useState(0);
  useEffect(() => {
    // Pause the timer while an action is in flight; resume (and reset) when it
    // settles. Without this a long-running action could be cancelled out from
    // under itself by the timer firing mid-await.
    if (actionRunning) return;
    const timer = setTimeout(() => {
      onDismiss(id);
    }, STICKY_NOTIFICATION_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [id, onDismiss, actionRunning, interactionCount]);

  const handleAction = useCallback(async (): Promise<void> => {
    if (action === undefined) return;
    setActionRunning(true);
    setActionError(null);
    setInteractionCount((n) => n + 1);
    try {
      const result = await action.run();
      if (!mountedRef.current) return;
      setActionRunning(false);
      if (result.ok) {
        onDismiss(id);
      } else {
        setActionError(result.error);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setActionRunning(false);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [action, id, onDismiss]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onDismiss(id);
        return;
      }
      if (action?.key === input && !actionRunning) {
        void handleAction();
      }
    },
    { isActive: isInputActive }
  );

  const color = colorFor(status);
  const icon = glyphFor(status);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={spacing.cardPadX}
      marginBottom={spacing.section}
    >
      <Box>
        <Text color={color} bold>
          {icon}{' '}
        </Text>
        <Text bold>{message}</Text>
      </Box>
      <Box>
        {action !== undefined ? (
          <>
            <Text dimColor>press </Text>
            <Text bold>{action.key}</Text>
            <Text dimColor>{` for ${action.label} ${glyphs.inlineDot} esc to dismiss`}</Text>
          </>
        ) : (
          <Text dimColor>esc to dismiss</Text>
        )}
      </Box>
      {actionError !== null ? (
        <Box marginTop={spacing.section}>
          <Text color={inkColors.error}>
            {glyphs.cross} {actionError}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
