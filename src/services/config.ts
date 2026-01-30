import { getConfigPath } from '@src/utils/paths.ts';
import {
  readValidatedJson,
  writeValidatedJson,
  fileExists,
} from '@src/utils/storage.ts';
import { ConfigSchema, type Config } from '@src/schemas/index.ts';

const DEFAULT_CONFIG: Config = {
  activeScope: null,
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

export async function getActiveScope(): Promise<string | null> {
  const config = await getConfig();
  return config.activeScope;
}

export async function setActiveScope(scopeId: string | null): Promise<void> {
  const config = await getConfig();
  config.activeScope = scopeId;
  await saveConfig(config);
}
