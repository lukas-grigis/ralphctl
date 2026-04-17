import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';
import { getRefinementDir, getPlanningDir, getSprintDir, getSchemaPath } from '@src/integration/persistence/paths.ts';

export class NodeFilesystemAdapter implements FilesystemPort {
  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf-8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Ensure parent directory exists
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  getRefinementDir(sprintId: string, ticketId: string): string {
    return getRefinementDir(sprintId, ticketId);
  }

  getPlanningDir(sprintId: string): string {
    return getPlanningDir(sprintId);
  }

  getSprintDir(sprintId: string): string {
    return getSprintDir(sprintId);
  }

  getSchemaPath(name: string): string {
    return getSchemaPath(name);
  }
}
