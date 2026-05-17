import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Port for loading a prompt template by base name (no `.md` extension).
 *
 * The fs-backed implementation lives next door at `ai/prompts/_engine/fs-template-loader.ts`.
 * Tests substitute an in-memory loader. Prompt-building code in `ai/prompts/_engine/`
 * accepts this port; orchestration receives an instance via injection.
 */
export interface TemplateLoader {
  load(name: string): Promise<Result<string, StorageError>>;
}
