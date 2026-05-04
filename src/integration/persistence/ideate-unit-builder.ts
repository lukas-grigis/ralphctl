/**
 * `buildIdeationUnit` — materialise a per-ticket ideation sandbox.
 *
 * Layout: `<sprintDir>/ideation/<id>-<slug>/`
 *   - `CLAUDE.md` or `.github/copilot-instructions.md` (context file)
 *   - `ticket.md` — pre-rendered ticket input for the AI
 *   - `session.md` — written by `ProviderAiSessionAdapter` at spawn time
 *   - `output.json` — where the AI writes its proposed sprint output
 *   - `.claude/skills/` — managed separately by `link-skills` / `unlink-skills`
 */
import { join } from 'node:path';

import type { AiProvider } from '@src/business/ports/ai-session-port.ts';
import type { IdeationUnitPaths } from '@src/business/ports/session-folder-builder-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { StoragePaths } from '@src/integration/persistence/storage-paths.ts';
import { unitSlug } from '@src/integration/persistence/unit-slug.ts';
import {
  ensureDirSafe,
  renderTicketInput,
  writeContextFile,
  writeFileSafe,
} from '@src/integration/persistence/session-folder-helpers.ts';

export async function buildIdeationUnit(
  storage: StoragePaths,
  input: {
    readonly sprint: Sprint;
    readonly ticket: Ticket;
    readonly aiProvider: AiProvider;
  }
): Promise<Result<IdeationUnitPaths, DomainError>> {
  const slug = unitSlug(String(input.ticket.id), input.ticket.title);
  const root = storage.ideationUnitDir(input.sprint.id, slug);

  const ensure = await ensureDirSafe(root);
  if (!ensure.ok) return Result.error(ensure.error);

  const ctx = await writeContextFile({
    root,
    sprint: input.sprint,
    provider: input.aiProvider,
    phase: 'ideate',
    affectedRepos: [],
  });
  if (!ctx.ok) return Result.error(ctx.error);

  const ticketMdPath = AbsolutePath.trustString(join(root, 'ticket.md'));
  const wrote = await writeFileSafe(ticketMdPath, renderTicketInput(input.ticket));
  if (!wrote.ok) return Result.error(wrote.error);

  return Result.ok({
    root,
    sessionMdPath: AbsolutePath.trustString(join(root, 'session.md')),
    ticketMdPath,
    outputJsonPath: AbsolutePath.trustString(join(root, 'output.json')),
  });
}
