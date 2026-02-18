import { AiProviderSchema } from '@src/schemas/index.ts';
import { getAiProvider, setAiProvider } from '@src/store/config.ts';
import { field, icons, log, printHeader, showError, showSuccess } from '@src/theme/ui.ts';

export async function configSetCommand(args: string[]): Promise<void> {
  if (args.length < 2) {
    showError('Usage: ralphctl config set provider <claude|copilot>');
    log.newline();
    return;
  }

  const [key, value] = args;

  if (key !== 'provider') {
    showError(`Unknown config key: ${key ?? '(empty)'}`);
    log.dim('Available keys: provider');
    log.newline();
    return;
  }

  const parsed = AiProviderSchema.safeParse(value);
  if (!parsed.success) {
    showError(`Invalid provider: ${value ?? '(empty)'}`);
    log.dim('Valid providers: claude, copilot');
    log.newline();
    return;
  }

  await setAiProvider(parsed.data);
  showSuccess(`AI provider set to: ${parsed.data}`);
  log.newline();
}

export async function configShowCommand(): Promise<void> {
  const provider = await getAiProvider();

  printHeader('Configuration', icons.info);
  console.log(field('AI Provider', provider ?? '(not set — will prompt on first use)'));
  log.newline();
}
