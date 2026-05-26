/**
 * Field editor — mounts the right prompt component for an `EditableField` (text or select),
 * with the provider-picker availability gate layered on top of the bare `SelectPrompt`.
 * Provider rows surface dimmed `(not installed)` options + an install-command footer; every
 * other select stays plain.
 */

import React from 'react';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { primaryInstallCommand } from '@src/integration/system/detect-cli.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { isProviderField, type EditableField } from '@src/application/ui/tui/views/settings-view-model.ts';

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

export const SettingsEditor = ({
  field,
  installedProviders,
  onSubmit,
  onCancel,
}: SettingsEditorProps): React.JSX.Element => {
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
    return (
      <SelectPrompt
        message={`${field.label} (current: ${field.current})`}
        options={field.options.map((value) => ({ label: value, value }))}
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
