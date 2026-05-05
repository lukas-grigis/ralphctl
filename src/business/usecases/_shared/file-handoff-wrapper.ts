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
 * This wrapper hands the generator the on-disk path of the prior round's
 * evaluation.md and instructs it to read the verdict FIRST, then
 * re-read the spec, then address every flagged dimension without
 * regressing the passed ones — the read-critique-first contract.
 *
 * Pure string. No IO. The chain layer is responsible for ensuring the
 * file at `critiqueFilePath` exists before the generator spawns.
 */
export function renderFixHandoffWrapper(promptFilePath: string, critiqueFilePath: string): string {
  return [
    'You are an agent under the ralphctl harness — resuming on a fix round.',
    '',
    `Read the evaluator critique at \`${critiqueFilePath}\` FIRST.`,
    'It lists which evaluation dimensions failed in the previous round and why.',
    '',
    `Then re-read the task spec at \`${promptFilePath}\` to refresh the success criteria.`,
    '',
    'Address every dimension flagged failed. Do not regress the dimensions that already passed.',
    'When the work is complete, emit `<task-complete>` per the spec.',
  ].join('\n');
}
