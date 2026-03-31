import { getConfigPath } from '@src/utils/paths.ts';
import { fileExists, readValidatedJson, writeValidatedJson } from '@src/utils/storage.ts';
import { type AiProvider, type Config, ConfigSchema } from '@src/schemas/index.ts';
import { unwrapOrThrow } from '@src/utils/result-helpers.ts';

export const DEFAULT_EVALUATION_ITERATIONS = 1;

const DEFAULT_CONFIG: Config = {
  currentSprint: null,
  aiProvider: null,
  editor: null,
};

export async function getConfig(): Promise<Config> {
  const configPath = getConfigPath();
  if (!(await fileExists(configPath))) {
    return DEFAULT_CONFIG;
  }
  return unwrapOrThrow(await readValidatedJson(configPath, ConfigSchema));
}

export async function saveConfig(config: Config): Promise<void> {
  unwrapOrThrow(await writeValidatedJson(getConfigPath(), config, ConfigSchema));
}

/**
 * Get the current sprint ID (which sprint commands target).
 */
export async function getCurrentSprint(): Promise<string | null> {
  const config = await getConfig();
  return config.currentSprint;
}

/**
 * Set the current sprint ID.
 */
export async function setCurrentSprint(sprintId: string | null): Promise<void> {
  const config = await getConfig();
  config.currentSprint = sprintId;
  await saveConfig(config);
}

/**
 * Get the configured AI provider (claude or copilot).
 * Returns null if not yet configured (first-run).
 */
export async function getAiProvider(): Promise<AiProvider | null> {
  const config = await getConfig();
  return config.aiProvider ?? null;
}

/**
 * Set the AI provider.
 */
export async function setAiProvider(provider: AiProvider): Promise<void> {
  const config = await getConfig();
  config.aiProvider = provider;
  await saveConfig(config);
}

/**
 * Get the configured editor command (e.g., "subl -w", "code --wait", "vim").
 * Returns null if not yet configured (first-run).
 */
export async function getEditor(): Promise<string | null> {
  const config = await getConfig();
  return config.editor ?? null;
}

/**
 * Set the editor command.
 */
export async function setEditor(editor: string): Promise<void> {
  const config = await getConfig();
  config.editor = editor;
  await saveConfig(config);
}

/**
 * Get the configured evaluation iteration count.
 * Returns the default (1) when the field is missing from config (safe fallback for upgrades).
 */
export async function getEvaluationIterations(): Promise<number> {
  const config = await getConfig();
  return config.evaluationIterations ?? DEFAULT_EVALUATION_ITERATIONS;
}

/**
 * Set the evaluation iteration count (0 = disabled).
 */
export async function setEvaluationIterations(iterations: number): Promise<void> {
  const config = await getConfig();
  config.evaluationIterations = iterations;
  await saveConfig(config);
}
