/**
 * Application-layer wrapper around the integration's `StoragePaths`.
 *
 * Re-exports the integration helpers under a single application module so
 * the composition root can pull "everything storage-paths" from one place,
 * and adds nothing besides delegation. The actual resolution + directory
 * creation logic lives in `integration/persistence/storage-paths.ts`.
 */
export { ensureLayoutDirs, resolveStoragePaths } from '../../integration/persistence/storage-paths.ts';
export type { ResolveStoragePathsOptions, StoragePaths } from '../../integration/persistence/storage-paths.ts';
