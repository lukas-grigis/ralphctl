import { select } from '@inquirer/prompts';
import { success, info, muted, error, warning } from '@src/utils/colors.ts';
import {
  activateScope,
  listScopes,
  ScopeStatusError,
  ScopeNotFoundError,
} from '@src/services/scope.ts';

export async function scopeActivateCommand(args: string[]): Promise<void> {
  let scopeId = args[0];

  // If no ID provided, show selection from draft scopes
  if (!scopeId) {
    const scopes = await listScopes();
    const draftScopes = scopes.filter((s) => s.status === 'draft');

    if (draftScopes.length === 0) {
      console.log(warning('\nNo draft scopes available to activate.'));
      console.log(muted('Create one with: ralphctl scope create\n'));
      return;
    }

    scopeId = await select({
      message: 'Select scope to activate:',
      choices: draftScopes.map((s) => ({
        name: `${s.id} - ${s.name}`,
        value: s.id,
      })),
    });
  }

  try {
    const scope = await activateScope(scopeId);
    console.log(success('\nScope activated successfully!'));
    console.log(info('  ID:     ') + scope.id);
    console.log(info('  Name:   ') + scope.name);
    console.log(info('  Status: ') + scope.status);
    console.log(muted('\nThis scope is now the active scope.\n'));
  } catch (err) {
    if (err instanceof ScopeNotFoundError) {
      console.log(error(`\nScope not found: ${scopeId}\n`));
    } else if (err instanceof ScopeStatusError) {
      console.log(error(`\n${err.message}\n`));
    } else {
      throw err;
    }
  }
}
