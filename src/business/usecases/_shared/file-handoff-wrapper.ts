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
