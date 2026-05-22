import type { AiSignal } from '@src/domain/signal.ts';
import type { SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

export interface RenderContractSectionParams {
  /** Current contract version — embedded in the rendered example's `schemaVersion` field. */
  readonly schemaVersion: number;
  /**
   * Sample signal array the prompt shows the AI. Embedded verbatim in a JSON code fence. The
   * caller hand-authors this (one per template) so the example is representative of the leaf's
   * accepted sub-union; prompt-template unit tests ([11]) round-trip the example through the
   * contract's `signalsSchema` to catch drift.
   */
  readonly exampleSignals: readonly AiSignal[];
  /**
   * Rules from the leaf's `AiOutputContract.sidecars`. Used to document which derived files
   * the harness will write so the AI knows it MUST NOT write them itself.
   */
  readonly sidecars: readonly SidecarRule[];
}

/**
 * Render the `{{OUTPUT_CONTRACT_SECTION}}` block embedded in every AI-spawning prompt
 * template. The block tells the AI:
 *
 *   1. Write exactly one file — `signals.json` — matching the documented shape;
 *   2. Don't write any other files (the harness derives sidecars from validated signals);
 *   3. The session is over when `signals.json` is on disk and validates.
 *
 * The output is markdown so the prompt's natural structure carries it. The signal example
 * is fenced as a JSON code block so the AI parses it correctly even when escapes appear in
 * a body string.
 */
export const renderContractSection = (params: RenderContractSectionParams): string => {
  const lines: string[] = [];
  lines.push('## Output contract');
  lines.push('');
  lines.push('Write **exactly one file** when you are done: `signals.json`. Do not write any other');
  lines.push('files — the harness renders every operator-readable sidecar from the validated signals.');
  lines.push('');
  if (params.sidecars.length > 0) {
    lines.push('Files the harness will render from your signals (you must NOT write these):');
    lines.push('');
    for (const rule of params.sidecars) {
      const mult =
        rule.multiplicity === 'one'
          ? 'required'
          : rule.multiplicity === 'optional'
            ? 'optional'
            : 'one per matching signal';
      lines.push(`- \`${rule.filename}\` — derived from a \`${rule.signalKind}\` signal (${mult}).`);
    }
    lines.push('');
  }
  lines.push('### `signals.json` shape');
  lines.push('');
  lines.push('```json');
  const wrapper = { schemaVersion: params.schemaVersion, signals: params.exampleSignals };
  lines.push(JSON.stringify(wrapper, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Stop conditions:');
  lines.push('');
  lines.push('- `signals.json` exists in the spawn output directory.');
  lines.push('- The file validates against the schema (the example above is one valid shape).');
  lines.push('');
  return lines.join('\n');
};
