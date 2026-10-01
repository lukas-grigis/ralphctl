/** Read-side render of the Settings view's section strip + active-section body. */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { PresetBar } from '@src/application/ui/tui/views/preset-bar.tsx';
import { AiRow, ImplementAiRow } from '@src/application/ui/tui/views/ai-row.tsx';
import { HarnessRow } from '@src/application/ui/tui/views/harness-row.tsx';
import type { SettingsSection } from '@src/application/ui/tui/views/settings-view-model.ts';

export interface SectionStripProps {
  readonly sections: readonly SettingsSection[];
  readonly activeIdx: number;
}

/** Cells one tab takes: the label plus its `[ ]` / padding pair. */
const tabWidth = (label: string): number => [...label].length + 2;

/** Cells for a `‹ ` / ` ›` overflow cue. */
const CUE_WIDTH = 2;

/**
 * Slice of the tab list that fits `width` cells and always holds the active tab: grows outward from the active tab,
 * alternating right and left, so the strip stays one line however many sections there are.
 */
export const fitSectionTabs = (
  labels: readonly string[],
  activeIdx: number,
  width: number
): { readonly start: number; readonly end: number } => {
  const gap = spacing.indent;
  const cost = (from: number, to: number): number => {
    let n = 0;
    for (let i = from; i < to; i++) n += tabWidth(labels[i] ?? '') + (i > from ? gap : 0);
    return n + (from > 0 ? CUE_WIDTH : 0) + (to < labels.length ? CUE_WIDTH : 0);
  };
  let start = Math.min(Math.max(activeIdx, 0), Math.max(0, labels.length - 1));
  let end = start + 1;
  let growRight = true;
  for (;;) {
    const canRight = end < labels.length && cost(start, end + 1) <= width;
    const canLeft = start > 0 && cost(start - 1, end) <= width;
    if (!canRight && !canLeft) break;
    if ((growRight && canRight) || !canLeft) end += 1;
    else start -= 1;
    growRight = !growRight;
  }
  return { start, end };
};

export const SectionStrip = ({ sections, activeIdx }: SectionStripProps): React.JSX.Element => {
  const { columns } = useTerminalSize();
  const { start, end } = fitSectionTabs(
    sections.map((s) => s.label),
    activeIdx,
    columns - 2 * spacing.indent
  );
  return (
    <Box paddingX={spacing.indent} flexWrap="nowrap">
      {start > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{glyphs.moreLeft} </Text>
        </Box>
      )}
      {sections.slice(start, end).map((sec, i) => {
        const isActive = start + i === activeIdx;
        return (
          <Box key={sec.id} flexShrink={0} marginRight={start + i < end - 1 ? spacing.indent : 0}>
            <Text {...(isActive ? { color: inkColors.primary } : { dimColor: true })} bold={isActive}>
              {isActive ? `[${sec.label}]` : ` ${sec.label} `}
            </Text>
          </Box>
        );
      })}
      {end < sections.length && (
        <Box flexShrink={0}>
          <Text dimColor> {glyphs.moreRight}</Text>
        </Box>
      )}
    </Box>
  );
};

export interface StoragePaths {
  readonly appRoot: string;
  readonly dataRoot: string;
  readonly configRoot: string;
}

export interface SectionBodyProps {
  readonly section: SettingsSection;
  readonly valueFor: (key: string) => React.ReactNode;
  /** Key of the focused field in the active section. */
  readonly focusedKey: string | undefined;
  readonly storage: StoragePaths;
  readonly presetWarnings: readonly PresetWarning[];
}

export const SectionBody = ({
  section,
  valueFor,
  focusedKey,
  storage,
  presetWarnings,
}: SectionBodyProps): React.JSX.Element => {
  switch (section.id) {
    case 'storage':
      return (
        <Card title={section.title} tone="rule">
          <FieldList
            fields={[
              { label: 'App root', value: <Text dimColor>{storage.appRoot}</Text> },
              { label: 'Data root', value: <Text dimColor>{storage.dataRoot}</Text> },
              { label: 'Config root', value: <Text dimColor>{storage.configRoot}</Text> },
            ]}
          />
        </Card>
      );
    case 'presets':
      return (
        <PresetBar title={section.title} fields={section.fields} focusedKey={focusedKey} warnings={presetWarnings} />
      );
    case 'implement':
      return <ImplementAiRow title={section.title} valueFor={valueFor} />;
    case 'harness':
      return <HarnessRow title={section.title} fields={section.fields} valueFor={valueFor} />;
    case 'global':
      return (
        <Card title={section.title} tone="primary">
          <FieldList fields={[{ label: 'Effort (default)', value: valueFor('ai.effort') }]} />
        </Card>
      );
    case 'other':
      return (
        <Card title={section.title} tone="primary">
          <FieldList
            fields={[
              { label: 'Log level', value: valueFor('logging.level') },
              { label: 'Concurrency', value: valueFor('concurrency.maxParallelTasks') },
            ]}
          />
        </Card>
      );
    case 'refine':
    case 'plan':
    case 'readiness':
    case 'ideate':
    case 'createPr':
      return <AiRow title={section.title} sectionId={section.id} valueFor={valueFor} />;
  }
};
