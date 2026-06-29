/**
 * Field editor — mounts the right prompt component for an `EditableField` (text or select),
 * with the provider-picker availability gate layered on top of the bare `SelectPrompt`.
 * Provider rows surface dimmed `(not installed)` options + an install-command footer; every
 * other select stays plain.
 *
 * Escalation-map fields get dedicated treatment:
 *  - `map-entry` mounts a target picker scoped to catalogs containing the rung's from-model,
 *    plus a `(remove this override)` choice that submits the empty string (the apply-key
 *    grammar's delete semantic).
 *  - `map-add` walks a two-step picker — FROM model, then TO model — and submits the pair as
 *    `from=to`. Esc on the second step returns to the first instead of abandoning the add.
 */

import React, { useState } from 'react';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { primaryInstallCommand } from '@src/integration/system/detect-cli.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import {
  type EditableField,
  escalationModelOptions,
  escalationTargetsFor,
  isModelField,
  isProviderField,
} from '@src/application/ui/tui/views/settings-view-model.ts';
import { isSuspendedModel, SUSPENSION_NOTE } from '@src/domain/value/settings-models/suspended-models.ts';
import { contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';

/**
 * Build the display label for a model picker option. Appends the context-window size and (when
 * applicable) the suspension note — both are additive so the bare model id is always visible.
 *
 *   'claude-sonnet-4-6'    →  'claude-sonnet-4-6  ·  200K'
 *   'claude-opus-4-8[1m]' →  'claude-opus-4-8[1m]  ·  1M'
 *   'claude-fable-5[1m]'  →  'claude-fable-5[1m]  ·  1M  (suspended)'
 *   'claude-fable-5'      →  'claude-fable-5  ·  (suspended)'
 *   'gpt-5.5'             →  'gpt-5.5'   (no window known — no annotation)
 */
const annotateModelLabel = (model: string): string => {
  const windowPart = contextWindowLabel(model);
  const suspendedPart = isSuspendedModel(model) ? `(${SUSPENSION_NOTE})` : undefined;
  const annotations = [windowPart, suspendedPart].filter((s): s is string => s !== undefined);
  if (annotations.length === 0) return model;
  return `${model}  ${glyphs.bullet}  ${annotations.join('  ')}`;
};

interface ProviderChoice {
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
}

interface ProviderOptions {
  readonly choices: readonly ProviderChoice[];
  readonly footer?: string;
}

/**
 * Build the option list for a provider picker. Unavailable providers render `'(not installed)'`
 * suffixed and are marked `disabled` so SelectPrompt skips them on keyboard navigation and
 * refuses submission. When the availability probe has not completed yet, every option stays
 * enabled — the gate still fires server-side via the settings-set-provider flow.
 */
const buildProviderOptions = (
  options: readonly string[],
  installed: ReadonlySet<AiProvider> | undefined
): ProviderOptions => {
  const choices: readonly ProviderChoice[] = options.map((value) => {
    const provider = value as AiProvider;
    const available = installed === undefined || installed.has(provider);
    const label = available ? value : `${value} (not installed)`;
    return available ? { label, value } : { label, value, disabled: true };
  });
  const anyEnabled = choices.some((o) => o.disabled !== true);
  const missing = options.filter((v) => installed !== undefined && !installed.has(v as AiProvider));
  const footerParts: string[] = [];
  if (!anyEnabled) footerParts.push('No AI provider CLI is installed.');
  for (const m of missing) footerParts.push(`install ${m}: ${primaryInstallCommand(m as AiProvider)}`);
  if (footerParts.length === 0) return { choices };
  return { choices, footer: footerParts.join(' · ') };
};

export interface SettingsEditorProps {
  readonly field: EditableField;
  readonly installedProviders: ReadonlySet<AiProvider> | undefined;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

/**
 * Two-step from/to picker for a new escalation rung. Local state holds the chosen FROM model
 * while the TO picker is mounted; the component is remounted per edit (the orchestrator keys
 * the editor on the active field) so the state never leaks across edits.
 */
const EscalationAddEditor = ({
  onSubmit,
  onCancel,
}: {
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element => {
  const [fromModel, setFromModel] = useState<string | undefined>(undefined);
  if (fromModel === undefined) {
    return (
      <SelectPrompt
        message="Escalate FROM which model? (step 1/2)"
        options={escalationModelOptions().map((value) => ({ label: annotateModelLabel(value), value }))}
        onSubmit={(value) => setFromModel(String(value))}
        onCancel={onCancel}
      />
    );
  }
  return (
    <SelectPrompt
      message={`${fromModel} ${glyphs.arrowRight} which model? (step 2/2)`}
      options={escalationTargetsFor(fromModel).map((value) => ({ label: annotateModelLabel(value), value }))}
      footer="esc goes back to the from-model pick"
      onSubmit={(value) => onSubmit(`${fromModel}=${String(value)}`)}
      onCancel={() => setFromModel(undefined)}
    />
  );
};

export const SettingsEditor = ({
  field,
  installedProviders,
  onSubmit,
  onCancel,
}: SettingsEditorProps): React.JSX.Element => {
  if (field.kind === 'map-add') {
    return <EscalationAddEditor onSubmit={onSubmit} onCancel={onCancel} />;
  }
  if (field.kind === 'map-entry') {
    return (
      <SelectPrompt
        message={`${field.from} escalates to (current: ${field.to})`}
        options={[
          ...escalationTargetsFor(field.from).map((value) => ({ label: annotateModelLabel(value), value })),
          { label: '(remove this override)', value: '' },
        ]}
        onSubmit={(value) => onSubmit(String(value))}
        onCancel={onCancel}
      />
    );
  }
  if (field.kind === 'select') {
    if (isProviderField(field)) {
      const { choices, footer } = buildProviderOptions(field.options, installedProviders);
      return (
        <SelectPrompt
          message={`${field.label} (current: ${field.current})`}
          options={choices}
          {...(footer !== undefined ? { footer } : {})}
          onSubmit={(value) => onSubmit(String(value))}
          onCancel={onCancel}
        />
      );
    }
    // Model selects annotate each option with its context-window size and (when applicable) the
    // suspension note — labels only; the value stays the bare id so a pre-pinned choice
    // round-trips and the adapter guard remains the single rejection point.
    // Every other select (log level, booleans, …) renders plain.
    const annotate = isModelField(field);
    return (
      <SelectPrompt
        message={`${field.label} (current: ${field.current})`}
        options={field.options.map((value) => ({
          label: annotate ? annotateModelLabel(value) : value,
          value,
        }))}
        onSubmit={(value) => onSubmit(String(value))}
        onCancel={onCancel}
      />
    );
  }
  return (
    <TextPrompt
      message={`${field.label} (current: ${field.current})`}
      initial={field.current}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
};
