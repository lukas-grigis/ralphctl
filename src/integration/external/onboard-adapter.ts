/**
 * Concrete `OnboardAdapterPort` — bundles the filesystem helpers, linter, and
 * AI discovery into a single adapter so the onboard pipeline stays inside the
 * Clean Architecture fence.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AiProvider } from '@src/domain/models.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import type {
  AgentsMdDiscoveryInput,
  AgentsMdDiscoveryResult,
  ExistingInstructions,
  LintViolation,
  OnboardAdapterPort,
  RepoPathValidation,
  WriteInstructionsResult,
} from '@src/business/ports/onboard-adapter.ts';
import { detectCommandDrift, lintAgentsMd } from './agents-md-linter.ts';
import { readExistingProviderInstructions, writeProviderInstructionsAtomic } from './agents-md-writer.ts';
import { discoverAgentsMdWithAi } from '@src/integration/ai/discover-agents-md.ts';

export class DefaultOnboardAdapter implements OnboardAdapterPort {
  constructor(
    private readonly aiSession: AiSessionPort,
    private readonly signalParser: SignalParserPort
  ) {}

  readExistingInstructions(repoPath: string, provider: AiProvider): ExistingInstructions {
    return readExistingProviderInstructions(repoPath, provider);
  }

  validateRepoPath(path: string): RepoPathValidation {
    let exists: boolean;
    try {
      exists = existsSync(path) && statSync(path).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) return { exists: false, isGitRepo: false };
    // `.git` may be a directory (normal clone) or a file (worktree / submodule).
    const isGitRepo = existsSync(join(path, '.git'));
    return { exists: true, isGitRepo };
  }

  lintAgentsMd(content: string): { ok: boolean; violations: LintViolation[] } {
    return lintAgentsMd(content);
  }

  detectCommandDrift(content: string, repoPath: string): string[] {
    return detectCommandDrift(content, repoPath);
  }

  async discoverAgentsMd(input: AgentsMdDiscoveryInput): Promise<AgentsMdDiscoveryResult> {
    return discoverAgentsMdWithAi(input, this.aiSession, this.signalParser);
  }

  inferProjectType(repoPath: string): string {
    const checks: [string, string][] = [
      ['package.json', 'node'],
      ['pyproject.toml', 'python'],
      ['requirements.txt', 'python'],
      ['Cargo.toml', 'rust'],
      ['go.mod', 'go'],
      ['pom.xml', 'java'],
      ['build.gradle', 'java'],
      ['Makefile', 'makefile'],
    ];
    const hints: string[] = [];
    for (const [file, label] of checks) {
      if (existsSync(join(repoPath, file))) hints.push(label);
    }
    return hints.length === 0 ? 'unknown' : hints.join(', ');
  }

  writeProviderInstructions(repoPath: string, content: string, provider: AiProvider): WriteInstructionsResult {
    return writeProviderInstructionsAtomic(repoPath, content, provider);
  }
}
