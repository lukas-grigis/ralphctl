/**
 * SettingsPanel — overlay that renders every key in the config schema as an
 * editable row. Saves run through `PersistencePort.saveConfig()` so any use
 * case reading config on its next tick picks up the change (REQ-12).
 *
 * Input model:
 * - ↑/↓ move the row cursor
 * - Enter opens a type-appropriate prompt (select for enum, confirm for
 *   boolean, input for number/string) via `getPrompt()` — so edits render
 *   through the same prompt host as everything else
 * - Esc closes the panel
 *
 * Validation uses `validateConfigValue()` from the schema provider. Failures
 * surface inline next to the row that caused them.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ConfigSchemaEntry } from '@src/domain/config-schema.ts';
import { getAllSchemaEntries } from '@src/domain/config-schema.ts';
import { validateConfigValue, parseConfigValue } from '@src/integration/config/schema-provider.ts';
import { getPrompt, getSharedDeps } from '@src/application/bootstrap.ts';
import type { Config } from '@src/domain/models.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface Props {
  onClose: () => void;
}

const SETTINGS_HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'edit' },
  { key: 'Esc', action: 'close' },
] as const;

type ConfigRecord = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(not set)';
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function SettingsPanel({ onClose }: Props): React.JSX.Element {
  const entries = getAllSchemaEntries();
  const [config, setConfig] = useState<ConfigRecord | null>(null);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useViewHints(SETTINGS_HINTS);

  // Reload config from disk on mount, and whenever reloadNonce bumps after
  // a successful save. Keeping this as the single source of display truth
  // avoids any stale-state edge case after an edit round-trip.
  useEffect(() => {
    const cancel = { current: false };
    const load = async (): Promise<void> => {
      try {
        const loaded = await getSharedDeps().persistence.getConfig();
        if (!cancel.current) setConfig(loaded as unknown as ConfigRecord);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancel.current = true;
    };
  }, [reloadNonce]);

  const saveValue = useCallback(async (entry: ConfigSchemaEntry, value: unknown): Promise<void> => {
    const validated = validateConfigValue(entry.key, value);
    if (!validated.ok) {
      setError(validated.error.message);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const persistence = getSharedDeps().persistence;
      const current = (await persistence.getConfig()) as unknown as ConfigRecord;
      const next: ConfigRecord = { ...current, [entry.key]: validated.value };
      await persistence.saveConfig(next as unknown as Config);
      const fresh = (await persistence.getConfig()) as unknown as ConfigRecord;
      const landed = fresh[entry.key];
      setConfig(fresh);
      setReloadNonce((n) => n + 1);
      setNotice(
        valuesEqual(landed, validated.value)
          ? `Saved ${entry.label}: ${formatValue(landed)}`
          : `Saved, but disk reports ${entry.label} = ${formatValue(landed)} (expected ${formatValue(validated.value)})`
      );
    } catch (err) {
      setError(`Failed to save ${entry.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const startEdit = useCallback(async (): Promise<void> => {
    const entry = entries[cursor];
    if (!entry) return;
    setEditing(true);
    setError(null);
    try {
      if (entry.key === 'currentSprint') {
        // Dynamic enum: every sprint on disk is a valid choice. Keeps the
        // operator from having to type a long YYYYMMDD-HHmmss-slug ID.
        const sprints = await getSharedDeps().persistence.listSprints();
        const choices: { label: string; value: unknown }[] = [
          { label: '(clear)', value: null },
          ...sprints.map((s) => ({ label: `${s.name} · ${s.id} [${s.status}]`, value: s.id })),
        ];
        const picked = await getPrompt().select<unknown>({
          message: 'Set current sprint',
          choices,
          default: config?.[entry.key],
        });
        await saveValue(entry, picked);
      } else if (entry.type === 'enum' && entry.enum) {
        const choices = entry.enum.map((v) => ({ label: String(v), value: v as unknown }));
        // Always offer an explicit "null" sentinel when the schema allows it
        // (default is null → clearable).
        if (entry.default === null) {
          choices.unshift({ label: '(clear)', value: null });
        }
        const picked = await getPrompt().select<unknown>({
          message: `Set ${entry.label}`,
          choices,
          default: config?.[entry.key],
        });
        await saveValue(entry, picked);
      } else if (entry.type === 'boolean') {
        const picked = await getPrompt().confirm({
          message: `${entry.key}?`,
          default: Boolean(config?.[entry.key] ?? entry.default),
        });
        await saveValue(entry, picked);
      } else {
        const raw = await getPrompt().input({
          message: `Set ${entry.key}`,
          default: formatValueForInput(config?.[entry.key]),
          validate: (val) => {
            const parsed = parseConfigValue(entry.key, val);
            return parsed.ok ? true : parsed.error.message;
          },
        });
        const parsed = parseConfigValue(entry.key, raw);
        if (!parsed.ok) {
          setError(parsed.error.message);
        } else {
          await saveValue(entry, parsed.value);
        }
      }
    } catch (err) {
      // Prompt cancelled or I/O failure — surface only real errors.
      if (err instanceof Error && err.name !== 'PromptCancelledError') {
        setError(err.message);
      }
    } finally {
      setEditing(false);
    }
  }, [cursor, entries, config, saveValue]);

  useInput((input, key) => {
    if (editing) return;
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(entries.length - 1, c + 1));
      return;
    }
    if (key.return) {
      void startEdit();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={inkColors.primary}
      paddingX={spacing.cardPadX}
      paddingY={0}
    >
      {config === null ? (
        <Text dimColor>Loading…</Text>
      ) : (
        entries.map((entry, i) => {
          const value = config[entry.key];
          const isDefault = valuesEqual(value, entry.default);
          const isCursor = i === cursor;
          const typeLabel = entry.type === 'enum' && entry.enum ? `enum: ${entry.enum.join(' | ')}` : entry.type;
          return (
            <Box flexDirection="column" key={entry.key} marginTop={spacing.section}>
              <Box>
                <Text color={isCursor ? inkColors.highlight : inkColors.primary} bold>
                  {isCursor ? `${glyphs.actionCursor} ` : '  '}
                  {entry.label}
                </Text>
                <Text dimColor>{`  (${typeLabel})`}</Text>
              </Box>
              <Box paddingLeft={spacing.indent}>
                <Text dimColor>{entry.description}</Text>
              </Box>
              <Box paddingLeft={spacing.indent}>
                <Text>{formatValue(value)}</Text>
                {isDefault ? <Text dimColor>{`  ${glyphs.inlineDot} default`}</Text> : null}
              </Box>
            </Box>
          );
        })
      )}

      {notice ? (
        <Box marginTop={spacing.section}>
          <Text color={inkColors.success}>
            {glyphs.check} {notice}
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginTop={spacing.section}>
          <Text color={inkColors.error}>
            {glyphs.cross} {error}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined && b === null) return true;
  if (a === null && b === undefined) return true;
  return false;
}

function formatValueForInput(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}
