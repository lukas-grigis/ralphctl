/**
 * `renderFileHandoffWrapper` — render the thin wrapper the AI actually
 * receives on stdin / the `--prompt` argument when the harness is
 * handing off a fully-rendered prompt that was written to disk.
 *
 * The full instructions live in the file at `promptFilePath`; the
 * wrapper just tells the AI to read it. Length is intentionally kept
 * under ~10 lines so the wrapper doesn't dominate the chat history's
 * first turn — the file body owns the instruction.
 *
 * Centralised here so every use case + chain factory picks up the same
 * shape: a future change to the handoff contract is a single edit.
 *
 * Pure function, no IO — safe to call from any layer.
 */
export function renderFileHandoffWrapper(promptFilePath: string): string {
  return [
    'You are an agent under the ralphctl harness.',
    '',
    `Read the file \`${promptFilePath}\` carefully — it contains your complete instructions, including:`,
    'harness context, signal vocabulary, task / sprint data, schemas, and the success criteria.',
    '',
    'Follow the protocol in that file exactly.',
  ].join('\n');
}

/**
 * `renderFixHandoffWrapper` — critique-aware variant of the file-handoff
 * wrapper used when the harness resumes the generator on a fix round.
 *
 * The evaluator runs in a separate AI session, so its critique is NOT in
 * the generator's chat history; without an explicit pointer the resumed
 * generator never sees the verdict and the fix attempt is a blind retry.
 * This wrapper inlines the verdict body directly in the resume turn so
 * the generator reads it without a tool round-trip — the critique is
 * bounded (a few KB) and already lives in memory at the call site, so a
 * file-handoff buys nothing here and adds two failure modes (file
 * missing / unreadable). The on-disk copy at
 * `rounds/<N>/evaluator/evaluation.md` remains for archival, written by
 * the surrounding loop.
 *
 * **Delimiter safety.** The critique body is an AI emission and could
 * theoretically contain a literal `</evaluator-critique>` (the tag is
 * named in `dimensions.md` and the evaluator may quote it). We escape
 * any embedded closing tag in the inlined body so the resumed generator
 * can locate the wrapper boundary unambiguously even when the critique
 * mentions the tag verbatim.
 *
 * Pure string. No IO.
 */
export function renderFixHandoffWrapper(promptFilePath: string, critique: string): string {
  const safeCritique = critique.replace(/<\/evaluator-critique>/g, '<\\/evaluator-critique>');
  return [
    'You are an agent under the ralphctl harness — resuming on a fix round.',
    '',
    'The evaluator from the previous round flagged the work as not yet complete.',
    'Its critique follows verbatim — read it FIRST, before doing anything else:',
    '',
    '<evaluator-critique>',
    safeCritique,
    '</evaluator-critique>',
    '',
    `Then re-read the task spec at \`${promptFilePath}\` to refresh the success criteria.`,
    '',
    'Address every dimension flagged failed. Do not regress the dimensions that already passed.',
    'When the work is complete, emit `<task-complete>` per the spec.',
  ].join('\n');
}
