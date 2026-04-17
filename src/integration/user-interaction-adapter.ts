import { getPrompt } from '@src/integration/bootstrap.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { Repository } from '@src/domain/models.ts';

/**
 * Interactive adapter that routes through the PromptPort abstraction.
 *
 * The underlying prompt adapter (Ink) is responsible for its own theming —
 * including the donut-emoji prefix — so messages passed here are kept free
 * of decoration.
 */
export class InteractiveUserAdapter implements UserInteractionPort {
  async confirm(message: string, defaultValue?: boolean, details?: string): Promise<boolean> {
    return getPrompt().confirm({ message, default: defaultValue, details });
  }

  async selectPaths(
    reposByProject: Map<string, Repository[]>,
    message: string,
    preselected?: string[]
  ): Promise<string[]> {
    const choices: { label: string; value: string }[] = [];
    const defaults: string[] = [];
    const preselectedSet = new Set(preselected ?? []);

    for (const [projectName, repos] of reposByProject) {
      for (const repo of repos) {
        choices.push({
          label: `${projectName} / ${repo.name} (${repo.path})`,
          value: repo.path,
        });
        // Match the original behaviour: if no preselection was supplied, every
        // repo starts checked; otherwise only the preselected subset.
        const checked = preselectedSet.size > 0 ? preselectedSet.has(repo.path) : true;
        if (checked) defaults.push(repo.path);
      }
    }

    return getPrompt().checkbox({ message, choices, defaults });
  }

  async selectBranchStrategy(sprintId: string, autoName: string): Promise<string | null> {
    const choice = await getPrompt().select({
      message: `Select branch strategy for sprint ${sprintId}`,
      choices: [
        { label: `Create sprint branch: ${autoName} (Recommended)`, value: 'auto' as const },
        { label: 'Keep current branch (no branch management)', value: 'keep' as const },
        { label: 'Custom branch name', value: 'custom' as const },
      ],
    });

    if (choice === 'auto') return autoName;
    if (choice === 'keep') return null;

    const name = await getPrompt().input({
      message: 'Enter branch name',
      validate: (val) => (val.trim().length > 0 ? true : 'Branch name cannot be empty'),
    });
    return name.trim();
  }

  async getFeedback(message: string): Promise<string | null> {
    const response = await getPrompt().input({ message });
    return response.trim().length > 0 ? response.trim() : null;
  }
}

/**
 * Auto/headless adapter that returns defaults without user interaction.
 */
export class AutoUserAdapter implements UserInteractionPort {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  confirm(_message: string, defaultValue?: boolean, _details?: string): Promise<boolean> {
    return Promise.resolve(defaultValue ?? true);
  }

  selectPaths(reposByProject: Map<string, Repository[]>, _message: string, preselected?: string[]): Promise<string[]> {
    // In auto mode, return preselected paths or all paths
    if (preselected && preselected.length > 0) {
      return Promise.resolve(preselected);
    }
    const allPaths: string[] = [];
    for (const repos of reposByProject.values()) {
      for (const repo of repos) {
        allPaths.push(repo.path);
      }
    }
    return Promise.resolve(allPaths);
  }

  selectBranchStrategy(_sprintId: string, autoName: string): Promise<string | null> {
    return Promise.resolve(autoName);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getFeedback(_message: string): Promise<string | null> {
    return Promise.resolve(null);
  }
}
