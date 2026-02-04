import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';

export class ValidationError extends Error {
  public readonly path: string;

  constructor(message: string, path: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ValidationError';
    this.path = path;
  }
}

export class FileNotFoundError extends Error {
  public readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = 'FileNotFoundError';
    this.path = path;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readValidatedJson<Output, Def extends ZodTypeDef, Input>(
  filePath: string,
  schema: ZodType<Output, Def, Input>
): Promise<Output> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new FileNotFoundError(`File not found: ${filePath}`, filePath);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new ValidationError(`Invalid JSON in ${filePath}`, filePath, err);
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ValidationError(`Validation failed for ${filePath}:\n${issues}`, filePath, result.error);
  }

  return result.data;
}

export async function writeValidatedJson<Output, Def extends ZodTypeDef, Input>(
  filePath: string,
  data: Output,
  schema: ZodType<Output, Def, Input>
): Promise<void> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ValidationError(`Validation failed before writing to ${filePath}:\n${issues}`, filePath, result.error);
  }

  await ensureDir(dirname(filePath));
  await writeFile(filePath, JSON.stringify(result.data, null, 2) + '\n', 'utf-8');
}

export async function appendToFile(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath));
  await appendFile(filePath, content, 'utf-8');
}

export async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new FileNotFoundError(`File not found: ${filePath}`, filePath);
    }
    throw err;
  }
}
