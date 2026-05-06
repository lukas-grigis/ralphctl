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
  /** Outcomes for `runSetupScript`, FIFO. Defaults to one passing run. */
  readonly setupScriptOutcomes?: readonly CheckScriptResult[];
  /** Outcomes for `runCheckScript`, FIFO. Defaults to one passing run. */
  readonly checkScriptOutcomes?: readonly CheckScriptResult[];
  /** Outcomes for `stashChanges`, FIFO. Defaults to one ok. */
  readonly stashOutcomes?: readonly Result<void, StorageError>[];
  /** Outcomes for `hardResetWorkingTree`, FIFO. Defaults to one ok. */
  readonly hardResetOutcomes?: readonly Result<void, StorageError>[];
  /** Outcomes for `verifyBranch`. When set, FIFO; otherwise uses `branchOk`. */
  readonly verifyBranchOutcomes?: readonly boolean[];
  /** Outcomes for `createPullRequest`, FIFO. Defaults to one stub URL. */
  readonly createPullRequestOutcomes?: readonly Result<CreatePullRequestOutput, StorageError>[];
  /** Outcomes for `createAndCheckoutBranch`, FIFO. Defaults to ok. */
  readonly createAndCheckoutBranchOutcomes?: readonly Result<void, StorageError>[];
  /**
   * Outcomes for `commitChanges`, FIFO. Defaults to a stub success returning
   * a deterministic SHA derived from the call index.
   */
  readonly commitChangesOutcomes?: readonly Result<string, StorageError>[];
}

export interface CapturedSetupScript {
  readonly projectPath: AbsolutePath;
  readonly script: string;
  readonly timeout?: number;
}

export interface CapturedCheckScript {
  readonly projectPath: AbsolutePath;
  readonly script: string;
  readonly phase: CheckScriptPhase;
  readonly timeout?: number;
}

export interface CapturedStash {
  readonly projectPath: AbsolutePath;
  readonly message: string;
}

export interface CapturedCreateBranch {
  readonly projectPath: AbsolutePath;
  readonly branchName: string;
}

export interface CapturedCommit {
  readonly projectPath: AbsolutePath;
  readonly message: string;
}

export class FakeExternalPort implements ExternalPort {
  readonly setupScriptCalls: CapturedSetupScript[] = [];
  readonly checkScriptCalls: CapturedCheckScript[] = [];
  readonly stashCalls: CapturedStash[] = [];
  readonly hardResetCalls: AbsolutePath[] = [];
  readonly verifyBranchCalls: { projectPath: AbsolutePath; expected: string }[] = [];
  readonly createPullRequestCalls: CreatePullRequestInput[] = [];
  readonly createAndCheckoutBranchCalls: CapturedCreateBranch[] = [];
  readonly commitChangesCalls: CapturedCommit[] = [];

  private readonly branchOk: boolean;
  private readonly currentBranch: string;
  private readonly uncommitted: boolean;
  private readonly setupScriptOutcomes: CheckScriptResult[];
  private readonly checkScriptOutcomes: CheckScriptResult[];
  private readonly stashOutcomes: Result<void, StorageError>[];
  private readonly hardResetOutcomes: Result<void, StorageError>[];
  private readonly verifyBranchOutcomes: boolean[];
  private readonly createPullRequestOutcomes: Result<CreatePullRequestOutput, StorageError>[];
  private readonly createAndCheckoutBranchOutcomes: Result<void, StorageError>[];
  private readonly commitChangesOutcomes: Result<string, StorageError>[];

  constructor(opts?: FakeExternalPortOptions) {
    this.branchOk = opts?.branchOk ?? true;
    this.currentBranch = opts?.currentBranch ?? 'main';
    this.uncommitted = opts?.uncommitted ?? false;
    this.setupScriptOutcomes = opts?.setupScriptOutcomes === undefined ? [] : [...opts.setupScriptOutcomes];
    this.checkScriptOutcomes = opts?.checkScriptOutcomes === undefined ? [] : [...opts.checkScriptOutcomes];
    this.stashOutcomes = opts?.stashOutcomes === undefined ? [] : [...opts.stashOutcomes];
    this.hardResetOutcomes = opts?.hardResetOutcomes === undefined ? [] : [...opts.hardResetOutcomes];
    this.verifyBranchOutcomes = opts?.verifyBranchOutcomes === undefined ? [] : [...opts.verifyBranchOutcomes];
    this.createPullRequestOutcomes =
      opts?.createPullRequestOutcomes === undefined ? [] : [...opts.createPullRequestOutcomes];
    this.createAndCheckoutBranchOutcomes =
      opts?.createAndCheckoutBranchOutcomes === undefined ? [] : [...opts.createAndCheckoutBranchOutcomes];
    this.commitChangesOutcomes = opts?.commitChangesOutcomes === undefined ? [] : [...opts.commitChangesOutcomes];
  }

  // --- Issue tracker ---

  fetchIssue(): Promise<Result<ExternalIssue | null, StorageError>> {
    return Promise.resolve(Result.ok<ExternalIssue | null>(null));
  }

  formatIssueContext(): string {
    return '';
  }

  // --- Setup / check script ---

  runSetupScript(projectPath: AbsolutePath, script: string, timeout?: number): Promise<CheckScriptResult> {
    this.setupScriptCalls.push({
      projectPath,
      script,
      ...(timeout !== undefined ? { timeout } : {}),
    });
    const next = this.setupScriptOutcomes.shift();
    return Promise.resolve(next ?? { passed: true, output: '' });
  }

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

  createAndCheckoutBranch(projectPath: AbsolutePath, branchName: string): Promise<Result<void, StorageError>> {
    this.createAndCheckoutBranchCalls.push({ projectPath, branchName });
    const next = this.createAndCheckoutBranchOutcomes.shift();
    return Promise.resolve(next ?? Result.ok());
  }

  stashChanges(projectPath: AbsolutePath, message: string): Promise<Result<void, StorageError>> {
    this.stashCalls.push({ projectPath, message });
    const next = this.stashOutcomes.shift();
    return Promise.resolve(next ?? Result.ok());
  }

  commitChanges(projectPath: AbsolutePath, message: string): Promise<Result<string, StorageError>> {
    this.commitChangesCalls.push({ projectPath, message });
    const next = this.commitChangesOutcomes.shift();
    if (next !== undefined) return Promise.resolve(next);
    // Default: deterministic stub SHA so tests can assert without scripting.
    const stub = `fakecommit${String(this.commitChangesCalls.length).padStart(4, '0')}`;
    return Promise.resolve(Result.ok(stub));
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
