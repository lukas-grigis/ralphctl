/**
 * Per-step body for the add-ticket wizard. Owns the prompt renderers and the small fetch
 * shim that maps an `IssueFetcher` result onto the next step. The orchestrator passes the
 * active `Step`, the state-transition callback, and the cancel + submit handlers; everything
 * else (which prompt, which label) is decided here based on `step.kind`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { TextAreaPrompt } from '@src/application/ui/tui/prompts/text-area-prompt.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import { backStep, type Step } from '@src/application/ui/tui/views/add-ticket-internals/types.ts';
import { ReviewScrollableDescription } from '@src/application/ui/tui/views/add-ticket-internals/review-scrollable-description.tsx';

interface StepViewProps {
  readonly step: Step;
  readonly onChange: (next: Step) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (s: Extract<Step, { kind: 'confirm' }>) => Promise<void>;
}

export const StepView = ({ step, onChange, onCancel, onSubmit }: StepViewProps): React.JSX.Element => {
  // Per-step `key` so each TextPrompt is a fresh instance — otherwise React's reconciliation
  // preserves the previous step's buffer at the same tree position. Esc on a non-first step
  // steps back instead of exiting the wizard.
  const prev = backStep(step);
  const cancelOrBack = prev !== undefined ? (): void => onChange(prev) : onCancel;
  const escLabel = prev !== undefined ? 'back' : 'cancel';
  switch (step.kind) {
    case 'link':
      return (
        <TextPrompt
          key="link"
          message="Issue link (GitHub/GitLab URL — ↵ to skip)"
          escLabel={escLabel}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) {
              onChange({ kind: 'title', link: '', titleInitial: '', descriptionInitial: '' });
              return;
            }
            onChange({ kind: 'fetching', link: trimmed });
          }}
          onCancel={cancelOrBack}
        />
      );
    case 'fetching':
      return <Spinner label={`fetching ${step.link}…`} />;
    case 'fetch-failed':
      return (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text color={inkColors.warning}>! fetch failed: {step.reason}</Text>
          <Text dimColor>Falling back to manual entry — the URL is preserved on the link field.</Text>
          <Box marginTop={spacing.section}>
            <ConfirmPrompt
              message="Continue with manual entry?"
              onSubmit={(value) => {
                if (value) {
                  onChange({
                    kind: 'title',
                    link: step.link,
                    titleInitial: '',
                    descriptionInitial: '',
                  });
                } else {
                  cancelOrBack();
                }
              }}
              onCancel={cancelOrBack}
            />
          </Box>
        </Box>
      );
    case 'title':
      return (
        <TextPrompt
          key="title"
          message="Title"
          initial={step.titleInitial}
          escLabel={escLabel}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            onChange({
              kind: 'description',
              link: step.link,
              title: trimmed,
              descriptionInitial: step.descriptionInitial,
            });
          }}
          onCancel={cancelOrBack}
        />
      );
    case 'description':
      return (
        <TextAreaPrompt
          key="description"
          message="Description"
          initial={step.descriptionInitial}
          escLabel={escLabel}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            onChange({
              kind: 'confirm',
              link: step.link,
              title: step.title,
              description: value,
            });
          }}
          onCancel={cancelOrBack}
        />
      );
    case 'confirm': {
      const descTrim = step.description.trim();
      const linkTrim = step.link.trim();
      return (
        <Box flexDirection="column">
          <Card title="Review ticket" tone="info">
            <Box flexDirection="column" paddingX={spacing.indent}>
              <FieldList
                fields={[
                  { label: 'Title', value: <Text bold>{step.title}</Text> },
                  { label: 'Description', value: <ReviewScrollableDescription text={descTrim} /> },
                  {
                    label: 'Link',
                    value:
                      linkTrim.length > 0 ? (
                        <Text dimColor>{linkTrim}</Text>
                      ) : (
                        <Text dimColor italic>
                          (skipped)
                        </Text>
                      ),
                  },
                ]}
              />
            </Box>
          </Card>
          <Box marginTop={spacing.section}>
            <ConfirmPrompt
              message="Add this ticket?"
              onSubmit={(value) => {
                if (value) void onSubmit(step);
                else cancelOrBack();
              }}
              onCancel={cancelOrBack}
            />
          </Box>
        </Box>
      );
    }
    case 'saving':
      return <Spinner label="saving sprint…" />;
    case 'added': {
      const plural = step.count === 1 ? 'ticket' : 'tickets';
      return (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text color={inkColors.success}>
            {glyphs.check} added &quot;{step.title}&quot; — {step.count} {plural} added this session
          </Text>
          <Box marginTop={spacing.section}>
            <ConfirmPrompt
              message="Add another ticket?"
              onSubmit={(value) => {
                if (value) onChange({ kind: 'link' });
                else onCancel();
              }}
              onCancel={onCancel}
            />
          </Box>
        </Box>
      );
    }
    case 'error':
      return (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text color={inkColors.error}>✗ {step.message}</Text>
          <Text dimColor>Press esc to go back.</Text>
        </Box>
      );
  }
};

/**
 * Fetch the issue at `url` and map the result onto the next wizard step. Mirrors the chain-
 * side `fetchPrefill`: `ok(issue)` becomes a `title` step with prefill; `ok(null)` and
 * `Result.error` both become a `fetch-failed` ack screen with a short reason. The URL is
 * always preserved on the eventual `link` field so the user never loses what they typed.
 */
export const runFetch = async (fetcher: IssueFetcher, url: string): Promise<Step> => {
  const result = await fetcher(url);
  if (result.ok && result.value !== null) {
    return {
      kind: 'title',
      link: result.value.url.length > 0 ? result.value.url : url,
      titleInitial: result.value.title,
      descriptionInitial: result.value.body,
    };
  }
  const reason = !result.ok ? result.error.message : 'URL not recognised or issue not accessible.';
  return { kind: 'fetch-failed', link: url, reason };
};
