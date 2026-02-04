import { getConfigPath } from '@src/utils/paths.ts';
import { fileExists, readValidatedJson, writeValidatedJson } from '@src/utils/storage.ts';
import { type Config, ConfigSchema } from '@src/schemas/index.ts';

const DEFAULT_CONFIG: Config = {
  currentSprint: null,
};

export async function getConfig(): Promise<Config> {
  const configPath = getConfigPath();
  if (!(await fileExists(configPath))) {
    return DEFAULT_CONFIG;
  }
  return readValidatedJson(configPath, ConfigSchema);
}

export async function saveConfig(config: Config): Promise<void> {
  await writeValidatedJson(getConfigPath(), config, ConfigSchema);
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
