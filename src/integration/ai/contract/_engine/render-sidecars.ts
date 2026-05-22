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
 *   - `'any'`      — Iterate every matching signal; the first writes `<filename>`, subsequent
 *                    matches append `.1`, `.2`, … to disambiguate.
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
    const matching = signals.filter((s) => s.type === rule.signalKind);
    if (matching.length === 0) {
      if (rule.multiplicity === 'one') {
        // The Zod schema should have caught this upstream; if it slipped through, fail soft —
        // operator can still inspect signals.json directly.
        logger.warn(`sidecar render: kind '${rule.signalKind}' is multiplicity 'one' but no matching signal present`);
      }
      continue;
    }

    let index = 0;
    for (const signal of matching) {
      const filename = renderFilename(rule.filename, index, rule.multiplicity);
      const absPathResult = AbsolutePathFactory.parse(join(String(outputDir), filename));
      if (!absPathResult.ok) {
        logger.warn(
          `sidecar render: could not resolve absolute path for ${rule.filename}: ${absPathResult.error.message}`
        );
        index++;
        continue;
      }
      const body = (rule.extract as (s: AiSignal) => string)(signal);
      const writeResult = await writeFile(absPathResult.value, body);
      if (!writeResult.ok) {
        logger.warn(`sidecar render: write failed for ${String(absPathResult.value)}: ${writeResult.error.message}`);
      } else {
        writtenPaths.push(absPathResult.value);
      }
      index++;
      if (rule.multiplicity !== 'any') break;
    }
  }

  return Result.ok(writtenPaths);
};

const renderFilename = (filename: string, index: number, multiplicity: 'one' | 'optional' | 'any'): string => {
  if (multiplicity !== 'any' || index === 0) return filename;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return `${filename}.${String(index)}`;
  return `${filename.slice(0, dot)}.${String(index)}${filename.slice(dot)}`;
};
