import { input } from '@inquirer/prompts';
import { success, info, muted } from '@src/utils/colors.ts';
import { createScope } from '@src/services/scope.ts';

export async function scopeCreateCommand(args: string[]): Promise<void> {
  let name: string | undefined;

  // Parse --name flag
  const nameIndex = args.indexOf('--name');
  if (nameIndex !== -1 && args[nameIndex + 1]) {
    name = args[nameIndex + 1];
  }

  // Prompt for name if not provided
  name ??= await input({
    message: 'Scope name:',
    validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
  });

  const scope = await createScope(name);

  console.log(success('\nScope created successfully!'));
  console.log(info('  ID:     ') + scope.id);
  console.log(info('  Name:   ') + scope.name);
  console.log(info('  Status: ') + scope.status);
  console.log(muted(`\nActivate with: ralphctl scope activate ${scope.id}\n`));
}
