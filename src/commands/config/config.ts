import { AiProviderSchema } from '@src/schemas/index.ts';
import { getAiProvider, getEditor, setAiProvider, setEditor } from '@src/store/config.ts';
import { field, icons, log, printHeader, showError, showSuccess } from '@src/theme/ui.ts';

export async function configSetCommand(args: string[]): Promise<void> {
  if (args.length < 2) {
    showError('Usage: ralphctl config set <key> <value>');
    log.dim('Available keys: provider, editor');
    log.newline();
    return;
  }

  const [key, value] = args;

  if (key === 'provider') {
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
    return;
  }

  if (key === 'editor') {
    const trimmed = value?.trim();
    if (!trimmed) {
      showError('Editor command cannot be empty');
      log.dim('Examples: "subl -w", "code --wait", "vim", "nano"');
      log.newline();
      return;
    }

    await setEditor(trimmed);
    showSuccess(`Editor set to: ${trimmed}`);
    log.newline();
    return;
  }

  showError(`Unknown config key: ${key ?? '(empty)'}`);
  log.dim('Available keys: provider, editor');
  log.newline();
}

export async function configShowCommand(): Promise<void> {
  const provider = await getAiProvider();
  const editorCmd = await getEditor();

  printHeader('Configuration', icons.info);
  console.log(field('AI Provider', provider ?? '(not set — will prompt on first use)'));
  console.log(field('Editor', editorCmd ?? '(not set — will prompt on first use)'));
  log.newline();
}
