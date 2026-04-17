/**
 * TicketShowView — detail card for a ticket.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Ticket } from '@src/domain/models.ts';
import { getTicket } from '@src/integration/persistence/ticket.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { FieldList } from '@src/integration/ui/tui/components/field-list.tsx';
import { StatusChip } from '@src/integration/ui/tui/components/status-chip.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface Props {
  readonly ticketId?: string;
}

type State = { kind: 'loading' } | { kind: 'ready'; ticket: Ticket } | { kind: 'error'; message: string };

const TITLE = 'Ticket Details' as const;
const HINTS = [] as const;

export function TicketShowView({ ticketId }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      if (!ticketId) {
        setState({ kind: 'error', message: 'No ticket ID provided' });
        return;
      }
      try {
        const ticket = await getTicket(ticketId);
        if (!ctl.cancelled) setState({ kind: 'ready', ticket });
      } catch (err) {
        if (!ctl.cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [ticketId]);

  return <ViewShell title={TITLE}>{renderBody(state)}</ViewShell>;
}

function renderBody(state: State): React.JSX.Element {
  if (state.kind === 'loading') return <Spinner label="Loading ticket…" />;
  if (state.kind === 'error') return <ResultCard kind="error" title="Could not load ticket" lines={[state.message]} />;

  const { ticket } = state;
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{ticket.title}</Text>
        <Text>{'  '}</Text>
        <StatusChip
          label={ticket.requirementStatus}
          kind={ticket.requirementStatus === 'approved' ? 'success' : 'warning'}
        />
      </Box>
      <Box marginTop={spacing.section}>
        <FieldList
          fields={[
            ['ID', ticket.id],
            ['Project', ticket.projectName],
            ['Link', ticket.link ?? glyphs.emDash],
            ['Repos', ticket.affectedRepositories?.join(', ') ?? glyphs.emDash],
          ]}
        />
      </Box>
      {ticket.description ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text color={inkColors.muted} bold>
            Description
          </Text>
          <Box paddingLeft={spacing.indent}>
            <Text>{ticket.description}</Text>
          </Box>
        </Box>
      ) : null}
      {ticket.requirements ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text color={inkColors.muted} bold>
            Requirements
          </Text>
          <Box paddingLeft={spacing.indent}>
            <Text>{ticket.requirements}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
