/**
 * Canonical `Result` re-export point for everything in `src/`.
 *
 * Every layer that needs `Result` / `AsyncResult` should import from this
 * module rather than reaching into `typescript-result` directly. Future
 * PRs that swap the underlying library or wrap it with project-specific
 * helpers can do so by changing this single file — no call-site churn.
 *
 * `Result` is exported as a value (it carries the `.ok` / `.error` /
 * `.map` / etc. constructors and helpers). `AsyncResult` is the awaitable
 * variant — exported as a type because consumers only need it in
 * signatures.
 */
export { Result } from 'typescript-result';
export type { AsyncResult } from 'typescript-result';
