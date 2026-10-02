/**
 * `LoadingRow` / `LoadErrorRow` — the indented one-line gates that every data-backed list /
 * detail view renders while a {@link useAsyncLoad} fetch is pending or has failed. Each view had
 * its own `<Box paddingX={spacing.indent}><Spinner label="…" /></Box>` and
 * `<Box paddingX={spacing.indent}><Text>Failed to load …</Text></Box>`; these centralise the
 * wrapper + spacing.
 *
 * `LoadingRow` takes the spinner `label` (views differ: "Loading sprints…", "Loading…", …).
 * `LoadErrorRow` takes the failure `message` and an optional `color` — the sprint picker tints
 * its failure line with `inkColors.error` while the other views leave it default-weight, so the
 * colour is passed through to keep each call site byte-identical.
 *
 * @public
 */

import React from 'react';
import { Box, Text } from 'ink';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';

export interface LoadingRowProps {
  /** Spinner label — imperative present-continuous, e.g. `Loading sprints…`. */
  readonly label: string;
}

export const LoadingRow = ({ label }: LoadingRowProps): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Spinner label={label} />
  </Box>
);

export interface LoadErrorRowProps {
  /** One-line failure copy, e.g. `Failed to load sprints.`. */
  readonly message: string;
  /** Optional text colour. Omit for default weight (matches most views); the sprint picker
   *  passes `inkColors.error`. */
  readonly color?: string;
}

export const LoadErrorRow = ({ message, color }: LoadErrorRowProps): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text {...(color !== undefined ? { color } : {})}>{message}</Text>
  </Box>
);
