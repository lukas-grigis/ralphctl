import { mkdir, readFile, writeFile, access, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import {
  getRefinementDir,
  getPlanningDir,
  getSprintDir,
  getSchemaPath,
  getProgressFilePath,
} from '@src/integration/persistence/paths.ts';

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

  async deleteFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Missing file is not an error — callers use this as best-effort cleanup.
    }
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

  getProgressFilePath(sprintId: string): string {
    return getProgressFilePath(sprintId);
  }

  getProjectContextFilePath(projectPath: string, sprintId: string, taskId: string): string {
    return join(projectPath, `.ralphctl-sprint-${sprintId}-task-${taskId}-context.md`);
  }

  getSchemaPath(name: string): string {
    return getSchemaPath(name);
  }
}
