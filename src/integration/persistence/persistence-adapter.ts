import type { CreateSprintInput, PersistencePort } from '@src/business/ports/persistence.ts';
import type { Sprint, Task, Ticket, Project, Repository, Config, ImportTask } from '@src/domain/models.ts';
import {
  getSprint,
  saveSprint,
  listSprints,
  createSprint,
  resolveSprintId,
  activateSprint,
  closeSprint,
  logSprintBaselines,
} from '@src/integration/persistence/sprint.ts';
import {
  getTasks,
  saveTasks,
  getTask,
  updateTaskStatus,
  updateTask,
  listTasks,
  reorderByDependencies,
  validateImportTasks,
  getNextTask,
  getReadyTasks,
  getRemainingTasks,
  areAllTasksDone,
} from '@src/integration/persistence/task.ts';
import { getTicket } from '@src/integration/persistence/ticket.ts';
import {
  getProject,
  getProjectById,
  getRepoById,
  listProjects,
  resolveRepoPath,
} from '@src/integration/persistence/project.ts';
import { getConfig, saveConfig } from '@src/integration/persistence/config.ts';
import { logProgress, getProgress, summarizeProgressForContext } from '@src/integration/persistence/progress.ts';
import { writeEvaluation } from '@src/integration/persistence/evaluation.ts';
import { importTasks } from '@src/integration/cli/commands/sprint/plan-utils.ts';
import type { TaskStatus } from '@src/domain/models.ts';

export class FilePersistenceAdapter implements PersistencePort {
  // Sprint

  async getSprint(id: string): Promise<Sprint> {
    return getSprint(id);
  }

  async saveSprint(sprint: Sprint): Promise<void> {
    return saveSprint(sprint);
  }

  async listSprints(): Promise<Sprint[]> {
    return listSprints();
  }

  async createSprint(input: CreateSprintInput): Promise<Sprint> {
    return createSprint(input);
  }

  async resolveSprintId(id?: string): Promise<string> {
    return resolveSprintId(id);
  }

  // Tasks

  async getTasks(sprintId: string): Promise<Task[]> {
    return getTasks(sprintId);
  }

  async saveTasks(tasks: Task[], sprintId: string): Promise<void> {
    return saveTasks(tasks, sprintId);
  }

  async getTask(id: string, sprintId: string): Promise<Task> {
    return getTask(id, sprintId);
  }

  async updateTaskStatus(id: string, status: string, sprintId: string): Promise<Task> {
    return updateTaskStatus(id, status as TaskStatus, sprintId);
  }

  async listTasks(sprintId: string): Promise<Task[]> {
    return listTasks(sprintId);
  }

  async reorderByDependencies(sprintId: string): Promise<void> {
    return reorderByDependencies(sprintId);
  }

  validateImportTasks(tasks: ImportTask[], existingTasks: Task[], ticketIds: Set<string>): string[] {
    return validateImportTasks(tasks, existingTasks, ticketIds);
  }

  async importTasks(tasks: ImportTask[], sprintId: string, options?: { replace?: boolean }): Promise<number> {
    return importTasks(tasks, sprintId, options);
  }

  // Tickets

  async getTicket(id: string, sprintId: string): Promise<Ticket> {
    return getTicket(id, sprintId);
  }

  // Projects

  async getProject(name: string): Promise<Project> {
    return getProject(name);
  }

  async getProjectById(id: string): Promise<Project> {
    return getProjectById(id);
  }

  async getRepoById(repoId: string): Promise<{ project: Project; repo: Repository }> {
    return getRepoById(repoId);
  }

  async resolveRepoPath(repoId: string): Promise<string> {
    return resolveRepoPath(repoId);
  }

  async listProjects(): Promise<Project[]> {
    return listProjects();
  }

  async logSprintBaselines(sprint: Sprint, resolvePath: (repoId: string) => Promise<string | null>): Promise<void> {
    return logSprintBaselines(sprint, resolvePath);
  }

  // Config

  async getConfig(): Promise<Config> {
    return getConfig();
  }

  async saveConfig(config: Config): Promise<void> {
    return saveConfig(config);
  }

  // Progress

  async logProgress(message: string, options?: { sprintId?: string; projectPath?: string }): Promise<void> {
    return logProgress(message, options);
  }

  async getProgress(sprintId: string): Promise<string> {
    return getProgress(sprintId);
  }

  async getProgressSummary(sprintId: string, projectPath: string, maxEntries?: number): Promise<string> {
    const raw = await getProgress(sprintId).catch(() => '');
    return summarizeProgressForContext(raw, projectPath, maxEntries);
  }

  // Evaluation

  async writeEvaluation(
    sprintId: string,
    taskId: string,
    iteration: number,
    status: string,
    body: string
  ): Promise<void> {
    await writeEvaluation(sprintId, taskId, iteration, status as 'passed' | 'failed' | 'malformed', body);
  }

  // Sprint lifecycle

  async activateSprint(id: string): Promise<Sprint> {
    return activateSprint(id);
  }

  async closeSprint(id: string): Promise<Sprint> {
    return closeSprint(id);
  }

  // Task queries

  async getNextTask(sprintId: string): Promise<Task | null> {
    return getNextTask(sprintId);
  }

  async getReadyTasks(sprintId: string): Promise<Task[]> {
    return getReadyTasks(sprintId);
  }

  async getRemainingTasks(sprintId: string): Promise<Task[]> {
    return getRemainingTasks(sprintId);
  }

  async areAllTasksDone(sprintId: string): Promise<boolean> {
    return areAllTasksDone(sprintId);
  }

  async updateTask(id: string, updates: Partial<Task>, sprintId: string): Promise<void> {
    await updateTask(id, updates, sprintId);
  }
}
