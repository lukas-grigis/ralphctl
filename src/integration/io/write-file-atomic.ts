import type { WriteFile } from '@src/business/io/write-file.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';

/**
 * `WriteFile` adapter backed by `writeTextAtomic` — write-to-temp then rename, so readers see
 * either the old content or the full new content but never a half-written file. Creates parent
 * directories as needed.
 *
 * The composition root constructs one of these and threads it through any chain that needs to
 * drop a text artefact on disk (e.g. the readiness chain writing the AI's proposed
 * `CLAUDE.md` / `AGENTS.md`).
 */
export const createAtomicWriteFile = (): WriteFile => (path, content) => writeTextAtomic(String(path), content);
