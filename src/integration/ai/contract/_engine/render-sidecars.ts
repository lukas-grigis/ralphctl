import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbsolutePath as AbsolutePathFactory } from '@src/domain/value/absolute-path.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Walk the leaf contract's sidecar rules and write each derivable file via the injected
 * `WriteFile` port. The function is the harness's only path from validated signals to disk
 * sidecars; the AI itself never writes anything other than `signals.json`.
 *
 * Failure model (audit [09]): sidecars are operator UX only. Downstream leaves read signals
 * from ctx, never from sidecar files. A write failure logs warn and continues — the leaf
 * always returns `Result.ok` from this helper. The caller propagates real failures from
 * `validateSignalsFile` separately.
 *
 * Multiplicity semantics:
 *
 *   - `'one'`      — Zod schema enforces exactly one signal of this kind; rendered.
 *   - `'optional'` — At most one; render only if present.
 *
 * Returns the absolute paths of every sidecar successfully written, for the leaf's audit /
 * test surface.
 */
export const renderSidecars = async <TSig extends AiSignal>(
  writeFile: WriteFile,
  outputDir: AbsolutePath,
  signals: readonly TSig[],
  rules: ReadonlyArray<SidecarRule<TSig['type']>>,
  logger: Logger
): Promise<Result<readonly AbsolutePath[], never>> => {
  const writtenPaths: AbsolutePath[] = [];

  for (const rule of rules) {
    const first = signals.find((s) => s.type === rule.signalKind);
    if (first === undefined) {
      warnIfRequiredSignalMissing(rule, logger);
      continue;
    }
    const written = await renderFirstMatch(writeFile, outputDir, first, rule, logger);
    if (written !== undefined) writtenPaths.push(written);
  }

  return Result.ok(writtenPaths);
};

/**
 * `'one'` sidecars are Zod-enforced to have exactly one matching signal upstream; if none
 * slipped through anyway, fail soft with a warning rather than aborting the whole render —
 * the operator can still inspect `signals.json` directly. `'optional'` rules are
 * silently skipped when nothing matches; that's expected, not an anomaly.
 */
const warnIfRequiredSignalMissing = <TKind extends AiSignal['type']>(
  rule: SidecarRule<TKind>,
  logger: Logger
): void => {
  if (rule.multiplicity !== 'one') return;
  logger.warn(`sidecar render: kind '${rule.signalKind}' is multiplicity 'one' but no matching signal present`);
};

/**
 * Write the sidecar for one signal. A path or write failure logs a warning and returns
 * `undefined` rather than aborting the batch (see the failure-model note on `renderSidecars`).
 */
const renderFirstMatch = async <TSig extends AiSignal>(
  writeFile: WriteFile,
  outputDir: AbsolutePath,
  signal: TSig,
  rule: SidecarRule<TSig['type']>,
  logger: Logger
): Promise<AbsolutePath | undefined> => {
  const absPathResult = AbsolutePathFactory.parse(join(String(outputDir), rule.filename));
  if (!absPathResult.ok) {
    logger.warn(`sidecar render: could not resolve absolute path for ${rule.filename}: ${absPathResult.error.message}`);
    return undefined;
  }
  const body = (rule.extract as (s: AiSignal) => string)(signal);
  const writeResult = await writeFile(absPathResult.value, body);
  if (!writeResult.ok) {
    logger.warn(`sidecar render: write failed for ${String(absPathResult.value)}: ${writeResult.error.message}`);
    return undefined;
  }
  return absPathResult.value;
};
