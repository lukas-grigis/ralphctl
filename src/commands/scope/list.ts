import { info, muted, warning } from '@src/utils/colors.ts';
import { listScopes, formatScopeStatus } from '@src/services/scope.ts';
import { getActiveScope } from '@src/services/config.ts';

export async function scopeListCommand(): Promise<void> {
  const scopes = await listScopes();
  const activeScopeId = await getActiveScope();

  if (scopes.length === 0) {
    console.log(warning('\nNo scopes found.'));
    console.log(muted('Create one with: ralphctl scope create\n'));
    return;
  }

  console.log(info('\nScopes:\n'));

  for (const scope of scopes) {
    const isActive = scope.id === activeScopeId;
    const marker = isActive ? ' *' : '  ';
    const status = formatScopeStatus(scope.status);
    console.log(`${marker} ${scope.id}  ${status}  ${scope.name}`);
  }

  if (activeScopeId) {
    console.log(muted('\n  * = active scope\n'));
  } else {
    console.log(muted('\nNo active scope. Activate with: ralphctl scope activate <id>\n'));
  }
}
