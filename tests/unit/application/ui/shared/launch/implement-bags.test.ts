/**
 * `buildImplementProviders` / `buildImplementOptsBag` — proves a bound agent definition's
 * model/effort overrides the per-flow row (AC5). `CreateImplementFlowOpts.generatorModel` /
 * `generatorEffort` is the SAME field both the gen-eval spawn (`GenEvalLoopRoleConfig` built from
 * these opts in `flow.ts`) and `finalize-gen-eval`'s escalation baseline
 * (`configuredGeneratorModel`/`configuredGeneratorEffort`) read — so asserting the value here
 * proves both downstream consumers see the override.
 */

import { describe, expect, it } from 'vitest';
import type { AiImplementSettings, Settings } from '@src/domain/entity/settings.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { buildImplementOptsBag, buildImplementProviders } from '@src/application/ui/shared/launch/implement-bags.ts';
import type { LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { absolutePath, slug } from '@tests/fixtures/domain.ts';

const implementPair = (): AiImplementSettings =>
  ({
    generator: { provider: 'claude-code', model: 'claude-sonnet-5', effort: 'low' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
  }) as AiImplementSettings;

const effectiveSettings = (globalEffort?: string): Settings =>
  ({
    harness: { rateLimitRetries: 0, idleWatchdogMs: 60_000 },
    ai: { ...(globalEffort !== undefined ? { effort: globalEffort } : {}) },
  }) as unknown as Settings;

const launcherDeps = (): LauncherDeps => ({ app: { eventBus: createInMemoryEventBus() } }) as unknown as LauncherDeps;

const definition: AgentDefinition = {
  name: 'ralphctl-generator',
  description: 'Implements the task.',
  content: 'You are an implementer.\n',
  model: 'claude-opus-4-8',
  effort: 'max',
};

describe('buildImplementProviders', () => {
  it('falls through to the row model/effort when no definition is bound', () => {
    const result = buildImplementProviders(implementPair(), effectiveSettings(), launcherDeps());
    expect(result.generatorModel).toBe('claude-sonnet-5');
    expect(result.generatorEffort).toBe('low');
  });

  it("a bound generator definition's model/effort override the row (AC5)", () => {
    const result = buildImplementProviders(implementPair(), effectiveSettings(), launcherDeps(), {
      generator: definition,
    });
    expect(result.generatorModel).toBe('claude-opus-4-8');
    expect(result.generatorEffort).toBe('max');
    // The evaluator role is untouched by the generator-only binding (AC3's precedence guarantee).
    expect(result.evaluatorModel).toBe('gpt-5.5');
  });
});

describe('buildImplementOptsBag', () => {
  const sprint = { id: 'sprint-1' } as never;
  const project = { id: 'proj-1', slug: slug('proj-1'), repositories: [] } as never;
  const sprintPaths = {
    progressPath: absolutePath('/sprints/s1/progress.md'),
    sprintDirPath: absolutePath('/sprints/s1'),
  };

  it('the overridden generatorModel/generatorEffort reach the opts bag that feeds BOTH the spawn and the escalation baseline', () => {
    const providers = buildImplementProviders(implementPair(), effectiveSettings(), launcherDeps(), {
      generator: definition,
    });
    const opts = buildImplementOptsBag(
      sprint,
      project,
      [],
      sprintPaths,
      implementPair(),
      providers,
      absolutePath('/data/memory')
    );

    expect(opts.generatorModel).toBe('claude-opus-4-8');
    expect(opts.generatorEffort).toBe('max');
  });

  it('threads the resolved agent-definition + prompt section into the opts bag per role', () => {
    const providers = buildImplementProviders(implementPair(), effectiveSettings(), launcherDeps(), {
      generator: definition,
    });
    const opts = buildImplementOptsBag(
      sprint,
      project,
      [],
      sprintPaths,
      implementPair(),
      providers,
      absolutePath('/data/memory'),
      { generator: { definition, section: 'announced section' }, evaluator: {} }
    );

    expect(opts.generatorAgentDefinition).toBe(definition);
    expect(opts.generatorAgentDefinitionSection).toBe('announced section');
    expect(opts.evaluatorAgentDefinition).toBeUndefined();
    expect(opts.evaluatorAgentDefinitionSection).toBeUndefined();
  });
});
