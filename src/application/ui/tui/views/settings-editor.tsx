/**
 * Field editor — mounts the right prompt component for an `EditableField` (text or select), with the provider-picker
 * availability gate layered on top of the bare `SelectPrompt`.
 */

import React, { useState } from 'react';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { primaryInstallCommand, PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import {
  annotateModelLabel,
  type EditableField,
  escalationModelOptions,
  escalationTargetsFor,
  isModelField,
  isProviderField,
} from '@src/application/ui/tui/views/settings-view-model.ts';

interface ProviderChoice {
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
}

interface ProviderOptions {
  readonly choices: readonly ProviderChoice[];
  readonly footer?: string;
}

/** Build the option list for a provider picker. */
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
  for (const m of missing) {
    const provider = m as AiProvider;
    footerParts.push(`install ${PROVIDER_BINARY[provider]}: ${primaryInstallCommand(provider)}`);
  }
  if (footerParts.length === 0) return { choices };
  return { choices, footer: footerParts.join(' · ') };
};

export interface SettingsEditorProps {
  readonly field: EditableField;
  readonly installedProviders: ReadonlySet<AiProvider> | undefined;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

/** Two-step from/to picker for a new escalation rung. */
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
    // Model selects annotate each option with its context-window size and (when applicable) the suspension note —
    // labels only.
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
