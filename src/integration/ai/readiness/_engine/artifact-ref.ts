import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Slug } from '@src/domain/value/slug.ts';

/** Pointer to a file artifact found by a probe. Caller can read/inspect via integration. */
export interface ArtifactRef {
  readonly path: AbsolutePath;
}

/** A named entry inside a per-tool artifact collection (skill, command, subagent, …). */
export interface NamedArtifactRef extends ArtifactRef {
  readonly name: Slug;
}

/** A hook entry declared inside a per-tool settings file. */
export interface HookRef {
  readonly event: string;
  readonly script: AbsolutePath;
}
