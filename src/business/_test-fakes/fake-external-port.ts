/**
 * `FakeExternalPort` — non-IO fake of {@link ExternalPort} for use case
 * unit tests. Records every method invocation and replays scripted answers.
 *
 * The fake is shaped so each test only configures what it cares about —
 * all reads default to safe "no-op" values (no uncommitted changes, on the
 * expected branch, no history) and all writes / scripts default to success.
 */
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type {
  CheckScriptPhase,
  CheckScriptResult,
  CreatePullRequestInput,
  CreatePullRequestOutput,
  ExternalIssue,
  ExternalPort,
} from '@src/business/ports/external-port.ts';

export interface FakeExternalPortOptions {
  /** When set, `verifyBranch` returns this — otherwise `true`. */
  readonly branchOk?: boolean;
  /** When set, `getCurrentBranch` returns this — otherwise `'main'`. */
  readonly currentBranch?: string;
  /** When set, `hasUncommittedChanges` returns this — otherwise `false`. */
  readonly uncommitted?: boolean;
  /** Outcomes for `runCheckScript`, FIFO. Defaults to one passing run. */
  readonly checkScriptOutcomes?: readonly CheckScriptResult[];
  /** Outcomes for `autoCommit`, FIFO. Defaults to one ok. */
  readonly autoCommitOutcomes?: readonly Result<void, StorageError>[];
  /** Outcomes for `stashChanges`, FIFO. Defaults to one ok. */
  readonly stashOutcomes?: readonly Result<void, StorageError>[];
  /** Outcomes for `hardResetWorkingTree`, FIFO. Defaults to one ok. */
  readonly hardResetOutcomes?: readonly Result<void, StorageError>[];
  /** Outcomes for `verifyBranch`. When set, FIFO; otherwise uses `branchOk`. */
  readonly verifyBranchOutcomes?: readonly boolean[];
  /** Outcomes for `createPullRequest`, FIFO. Defaults to one stub URL. */
  readonly createPullRequestOutcomes?: readonly Result<CreatePullRequestOutput, StorageError>[];
}

export interface CapturedCheckScript {
  readonly projectPath: AbsolutePath;
  readonly script: string;
  readonly phase: CheckScriptPhase;
  readonly timeout?: number;
}

export interface CapturedAutoCommit {
  readonly projectPath: AbsolutePath;
  readonly message: string;
}

export interface CapturedStash {
  readonly projectPath: AbsolutePath;
  readonly message: string;
}

export class FakeExternalPort implements ExternalPort {
  readonly checkScriptCalls: CapturedCheckScript[] = [];
  readonly autoCommitCalls: CapturedAutoCommit[] = [];
  readonly stashCalls: CapturedStash[] = [];
  readonly hardResetCalls: AbsolutePath[] = [];
  readonly verifyBranchCalls: { projectPath: AbsolutePath; expected: string }[] = [];
  readonly createPullRequestCalls: CreatePullRequestInput[] = [];

  private readonly branchOk: boolean;
  private readonly currentBranch: string;
  private readonly uncommitted: boolean;
  private readonly checkScriptOutcomes: CheckScriptResult[];
  private readonly autoCommitOutcomes: Result<void, StorageError>[];
  private readonly stashOutcomes: Result<void, StorageError>[];
  private readonly hardResetOutcomes: Result<void, StorageError>[];
  private readonly verifyBranchOutcomes: boolean[];
  private readonly createPullRequestOutcomes: Result<CreatePullRequestOutput, StorageError>[];

  constructor(opts?: FakeExternalPortOptions) {
    this.branchOk = opts?.branchOk ?? true;
    this.currentBranch = opts?.currentBranch ?? 'main';
    this.uncommitted = opts?.uncommitted ?? false;
    this.checkScriptOutcomes = opts?.checkScriptOutcomes === undefined ? [] : [...opts.checkScriptOutcomes];
    this.autoCommitOutcomes = opts?.autoCommitOutcomes === undefined ? [] : [...opts.autoCommitOutcomes];
    this.stashOutcomes = opts?.stashOutcomes === undefined ? [] : [...opts.stashOutcomes];
    this.hardResetOutcomes = opts?.hardResetOutcomes === undefined ? [] : [...opts.hardResetOutcomes];
    this.verifyBranchOutcomes = opts?.verifyBranchOutcomes === undefined ? [] : [...opts.verifyBranchOutcomes];
    this.createPullRequestOutcomes =
      opts?.createPullRequestOutcomes === undefined ? [] : [...opts.createPullRequestOutcomes];
  }

  // --- Issue tracker ---

  fetchIssue(): Promise<Result<ExternalIssue | null, StorageError>> {
    return Promise.resolve(Result.ok<ExternalIssue | null>(null));
  }

  formatIssueContext(): string {
    return '';
  }

  // --- Check script ---

  runCheckScript(
    projectPath: AbsolutePath,
    script: string,
    phase: CheckScriptPhase,
    timeout?: number
  ): Promise<CheckScriptResult> {
    this.checkScriptCalls.push({
      projectPath,
      script,
      phase,
      ...(timeout !== undefined ? { timeout } : {}),
    });
    const next = this.checkScriptOutcomes.shift();
    return Promise.resolve(next ?? { passed: true, output: '' });
  }

  // --- Git: read-only ---

  hasUncommittedChanges(): boolean {
    return this.uncommitted;
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  verifyBranch(projectPath: AbsolutePath, expected: string): boolean {
    this.verifyBranchCalls.push({ projectPath, expected });
    if (this.verifyBranchOutcomes.length > 0) {
      const next = this.verifyBranchOutcomes.shift();
      return next ?? this.branchOk;
    }
    return this.branchOk;
  }

  getHeadSha(): string | null {
    return null;
  }

  getChangedFilesSince(): readonly string[] {
    return [];
  }

  getRecentGitHistory(): string {
    return '';
  }

  generateBranchName(sprintId: string): string {
    return `ralphctl/${sprintId}`;
  }

  isValidBranchName(name: string): boolean {
    return name.length > 0;
  }

  // --- Git: mutating ---

  hardResetWorkingTree(projectPath: AbsolutePath): Promise<Result<void, StorageError>> {
    this.hardResetCalls.push(projectPath);
    const next = this.hardResetOutcomes.shift();
    return Promise.resolve(next ?? Result.ok());
  }

  createAndCheckoutBranch(): Promise<Result<void, StorageError>> {
    return Promise.resolve(Result.ok());
  }

  autoCommit(projectPath: AbsolutePath, message: string): Promise<Result<void, StorageError>> {
    this.autoCommitCalls.push({ projectPath, message });
    const next = this.autoCommitOutcomes.shift();
    return Promise.resolve(next ?? Result.ok());
  }

  stashChanges(projectPath: AbsolutePath, message: string): Promise<Result<void, StorageError>> {
    this.stashCalls.push({ projectPath, message });
    const next = this.stashOutcomes.shift();
    return Promise.resolve(next ?? Result.ok());
  }

  // --- Pull / merge requests ---

  createPullRequest(input: CreatePullRequestInput): Promise<Result<CreatePullRequestOutput, StorageError>> {
    this.createPullRequestCalls.push(input);
    const next = this.createPullRequestOutcomes.shift();
    return Promise.resolve(
      next ??
        Result.ok<CreatePullRequestOutput>({
          url: `https://example.test/${input.branch}/pulls/1`,
        })
    );
  }
}
