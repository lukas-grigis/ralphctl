/**
 * Add-ticket view — interactive wizard that funnels through the `ticket-add` use case so the
 * TUI and CLI share one append path. Walks: link → (fetch + prefill, when an `IssueFetcher`
 * is wired and the URL is non-empty) → title → description → confirm. Mirrors the chain-side
 * `interactive-add-loop` ordering so the URL becomes the source of truth: enter a GitHub /
 * GitLab issue URL and we pre-fill title + description from the issue body, so the user
 * doesn't copy-paste them by hand. Empty URL skips the fetch and falls back to manual entry.
 *
 * The sprint must be in `draft` (the use case enforces this) — non-draft sprints surface as
 * an error step.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { TextAreaPrompt } from '@src/application/ui/tui/prompts/text-area-prompt.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useSuppressGlobalHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { spacing, inkColors, glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { createTicketAddFlow } from '@src/application/flows/ticket-add/flow.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';

interface AddTicketProps extends Readonly<Record<string, unknown>> {
  readonly sprintId: SprintId;
}

type Step =
  | { readonly kind: 'link' }
  | { readonly kind: 'fetching'; readonly link: string }
  | { readonly kind: 'fetch-failed'; readonly link: string; readonly reason: string }
  | {
      readonly kind: 'title';
      readonly link: string;
      readonly titleInitial: string;
      readonly descriptionInitial: string;
    }
  | {
      readonly kind: 'description';
      readonly link: string;
      readonly title: string;
      readonly descriptionInitial: string;
    }
  | {
      readonly kind: 'confirm';
      readonly link: string;
      readonly title: string;
      readonly description: string;
    }
  | { readonly kind: 'saving' }
  | { readonly kind: 'error'; readonly message: string };

const backStep = (step: Step): Step | undefined => {
  switch (step.kind) {
    case 'link':
      return undefined;
    case 'fetching':
      // Spinner is short-lived; treat Esc as a hard cancel of the view.
      return undefined;
    case 'fetch-failed':
      return { kind: 'link' };
    case 'title':
      return { kind: 'link' };
    case 'description':
      return {
        kind: 'title',
        link: step.link,
        titleInitial: step.title,
        descriptionInitial: step.descriptionInitial,
      };
    case 'confirm':
      return {
        kind: 'description',
        link: step.link,
        title: step.title,
        descriptionInitial: step.description,
      };
    case 'saving':
    case 'error':
      return undefined;
  }
};

export const AddTicketView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { sprintId } = useViewProps<AddTicketProps>();
  const [step, setStep] = useState<Step>({ kind: 'link' });

  const claimPrompt = ui.claimPrompt;
  useEffect(() => claimPrompt(), [claimPrompt]);

  const cancel = (): void => router.pop();

  // Run the fetch once we transition into the 'fetching' step. Result advances to either
  // 'title' (with prefill from the issue) or 'fetch-failed' (user acks then falls back to
  // manual entry with the URL preserved). When no IssueFetcher is wired, the link step
  // routes straight to 'title' and this effect never fires.
  useEffect(() => {
    if (step.kind !== 'fetching') return;
    const fetcher = deps.issueFetcher;
    if (fetcher === undefined) {
      setStep({ kind: 'title', link: step.link, titleInitial: '', descriptionInitial: '' });
      return;
    }
    let cancelled = false;
    void runFetch(fetcher, step.link).then((next) => {
      if (cancelled) return;
      setStep(next);
    });
    return () => {
      cancelled = true;
    };
  }, [step, deps.issueFetcher]);

  const submit = async (s: Extract<Step, { kind: 'confirm' }>): Promise<void> => {
    setStep({ kind: 'saving' });
    const description = s.description.trim();
    const link = s.link.trim();
    const flow = createTicketAddFlow({ sprintRepo: deps.sprintRepo });
    const result = await flow.execute({
      input: {
        sprintId,
        title: s.title.trim(),
        ...(description.length > 0 ? { description } : {}),
        ...(link.length > 0 ? { link } : {}),
      },
    });
    if (!result.ok) {
      setStep({ kind: 'error', message: result.error.error.message });
      return;
    }
    router.pop();
  };

  return (
    <ViewShell title="Add ticket" subtitle="Append a pending ticket to the current sprint.">
      <Box flexDirection="column">
        <HeaderCard step={step} />
        <Box marginTop={spacing.section} flexDirection="column">
          <StepView step={step} onChange={setStep} onCancel={cancel} onSubmit={submit} />
        </Box>
      </Box>
    </ViewShell>
  );
};

/**
 * Step-aware header.
 *  - `link` step (first): show the "What we'll collect" primer so a new user knows what's coming.
 *  - Mid-wizard steps (`fetching` → `title` → `description`): show a "Progress" card listing
 *    fields already entered. This is the fix for "old prompts vanish so I can't see what I
 *    typed" — the data persists in the header even after each prompt unmounts.
 *  - `confirm` / `saving` / `error`: handled by the step body itself (the confirm step renders
 *    its own "Review ticket" card containing all collected fields); header collapses so the
 *    Title doesn't appear twice on the same screen.
 */
const HeaderCard = ({ step }: { readonly step: Step }): React.JSX.Element | null => {
  if (step.kind === 'link') {
    return (
      <Card title="What we'll collect" tone="rule">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text dimColor>
            {glyphs.bullet} an external issue link e.g. GitHub URL (optional — when provided, we fetch the issue and
            pre-fill title + description){'\n'}
            {glyphs.bullet} a short title (required){'\n'}
            {glyphs.bullet} a longer description (required)
          </Text>
        </Box>
      </Card>
    );
  }
  const collected = collectedFields(step);
  if (collected.length === 0) return null;
  return (
    <Card title="Progress" tone="rule">
      <Box flexDirection="column" paddingX={spacing.indent}>
        <FieldList fields={collected} />
      </Box>
    </Card>
  );
};

/**
 * Fields the user has committed *prior to* the active step. The active step's own prompt owns
 * its (in-progress) buffer; once submitted, it joins this list on the next render. The
 * `confirm` step is excluded — its body renders the full summary inside a Review card, so
 * surfacing the same Title in the Progress header would duplicate it on the same screen.
 */
const collectedFields = (step: Step): ReadonlyArray<{ readonly label: string; readonly value: React.ReactNode }> => {
  if (step.kind === 'confirm') return [];
  const fields: Array<{ readonly label: string; readonly value: React.ReactNode }> = [];
  const linkFor = (s: Step): string | undefined => {
    if (s.kind === 'fetching' || s.kind === 'fetch-failed' || s.kind === 'title' || s.kind === 'description') {
      return s.link;
    }
    return undefined;
  };
  const link = linkFor(step);
  if (link !== undefined && link.length > 0) {
    fields.push({ label: 'Link', value: <Text dimColor>{link}</Text> });
  }
  if (step.kind === 'description') {
    fields.push({ label: 'Title', value: <Text bold>{step.title}</Text> });
  }
  return fields;
};

interface StepViewProps {
  readonly step: Step;
  readonly onChange: (next: Step) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (s: Extract<Step, { kind: 'confirm' }>) => Promise<void>;
}

const StepView = ({ step, onChange, onCancel, onSubmit }: StepViewProps): React.JSX.Element => {
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
 * Reserve rows for the chrome around the scrollable description body — banner + breadcrumb +
 * section stamp at the top, plus the Title row, the Link row, the spacing gutter, the
 * ConfirmPrompt (message + pills + hint), and the status bar at the bottom. The exact rows
 * vary with banner mode and terminal width; this constant is the worst-case estimate that
 * keeps the Link row and the confirm pills visible on a default 24-row terminal. Floor on the
 * viewport ensures a tiny terminal still shows something useful.
 */
const REVIEW_CHROME_ROWS = 14;
const REVIEW_MIN_VIEWPORT = 4;

/**
 * Bounded scrolling viewport for the Review-step description body. When the description fits,
 * renders a single `<Text>` so the static output matches the pre-fix rendering. When it
 * overflows, slices a window plus a position indicator and binds ↑/↓ + PgUp/PgDn (no wrap, no
 * line yank, no g/G). The ConfirmPrompt's y/n/↵/esc are unaffected — arrows are exclusively
 * ours, and ConfirmPrompt itself only listens for ←/→/h/l/y/n/↵/esc.
 *
 * When the body fits the viewport, the global `↑/↓ scroll` footer hint is suppressed so the
 * status bar never lies about what arrows do on this screen; when the body overflows, the
 * hint remains because arrows now legitimately scroll the description.
 */
interface ReviewScrollableDescriptionProps {
  readonly text: string;
}

const ReviewScrollableDescription = ({ text }: ReviewScrollableDescriptionProps): React.JSX.Element => {
  const term = useTerminalSize();
  const lines = useMemo<readonly string[]>(() => text.split('\n'), [text]);
  const viewport = Math.max(REVIEW_MIN_VIEWPORT, term.rows - REVIEW_CHROME_ROWS);
  const overflows = lines.length > viewport;
  const maxOffset = Math.max(0, lines.length - viewport);
  const [offset, setOffset] = useState(0);

  // Clamp on resize / line-count change so a window-shrink can't strand the offset past the
  // new bottom.
  useEffect(() => {
    setOffset((o) => Math.max(0, Math.min(o, maxOffset)));
  }, [maxOffset]);

  // Suppress the global ↑/↓ scroll hint while the description fits — arrows are inert and the
  // footer should not advertise them.
  useSuppressGlobalHints(overflows ? [] : ['↑/↓']);

  useInput((_input, key) => {
    if (!overflows) return;
    const clamp = (n: number): number => Math.max(0, Math.min(n, maxOffset));
    if (key.upArrow) setOffset((o) => clamp(o - 1));
    else if (key.downArrow) setOffset((o) => clamp(o + 1));
    else if (key.pageUp) setOffset((o) => clamp(o - viewport));
    else if (key.pageDown) setOffset((o) => clamp(o + viewport));
  });

  if (!overflows) {
    return <Text>{text}</Text>;
  }

  const visible = lines.slice(offset, offset + viewport);
  const lastVisible = Math.min(offset + viewport, lines.length);
  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Text key={`desc-${String(offset + i)}`}>{line.length === 0 ? ' ' : line}</Text>
      ))}
      <Text dimColor>
        lines {String(offset + 1)}–{String(lastVisible)} of {String(lines.length)}
      </Text>
    </Box>
  );
};

/**
 * Fetch the issue at `url` and map the result onto the next wizard step. Mirrors the chain-
 * side `fetchPrefill`: `ok(issue)` becomes a `title` step with prefill; `ok(null)` and
 * `Result.error` both become a `fetch-failed` ack screen with a short reason. The URL is
 * always preserved on the eventual `link` field so the user never loses what they typed.
 */
const runFetch = async (fetcher: IssueFetcher, url: string): Promise<Step> => {
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
