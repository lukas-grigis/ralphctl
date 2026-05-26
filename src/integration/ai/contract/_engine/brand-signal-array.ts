import type { z } from 'zod';

/**
 * Brand a Zod schema for a signal array as the precise readonly union the contract
 * downstream consumes. Zod widens optional fields to `T | undefined` under
 * `exactOptionalPropertyTypes`, which collides with the strict-optional signal unions
 * in `@src/domain/signal.ts`. The runtime check (the raw schema's `safeParse`) remains
 * the source of truth; the cast just narrows the static type so the contract's generic
 * argument flows precisely through `validateSignalsFile` and `renderSidecars`.
 *
 * Centralised so the cast lives in exactly one place instead of fanning out across
 * every per-leaf `*.contract.ts` file.
 *
 * @public
 */
export const brandSignalArray = <S>(raw: z.ZodTypeAny): z.ZodType<readonly S[]> =>
  raw as unknown as z.ZodType<readonly S[]>;
