/**
 * FakePromptPort — test double for PromptPort.
 *
 * Lets tests script prompt responses by providing an ordered queue of
 * answer functions per prompt type. If a prompt fires and no answer is
 * queued, it throws to make the test failure obvious.
 *
 * Usage:
 *
 *   const promptPort = new FakePromptPort();
 *   promptPort.queueInput('my sprint');
 *   promptPort.queueInput('my-sprint');
 *   // ... render component that fires two input prompts
 */

import { vi } from 'vitest';
import type {
  PromptPort,
  SelectOptions,
  ConfirmOptions,
  InputOptions,
  CheckboxOptions,
  EditorOptions,
  FileBrowserOptions,
} from '@src/business/ports/prompt-port.ts';

export class FakePromptPort implements PromptPort {
  private readonly _selectAnswers: (() => Promise<unknown>)[] = [];
  private readonly _confirmAnswers: (() => Promise<boolean>)[] = [];
  private readonly _inputAnswers: (() => Promise<string>)[] = [];
  private readonly _checkboxAnswers: (() => Promise<unknown[]>)[] = [];
  private readonly _editorAnswers: (() => Promise<string | null>)[] = [];
  private readonly _fileBrowserAnswers: (() => Promise<string | null>)[] = [];

  // Track calls for assertions
  readonly selectMock = vi.fn();
  readonly confirmMock = vi.fn();
  readonly inputMock = vi.fn();
  readonly checkboxMock = vi.fn();
  readonly editorMock = vi.fn();
  readonly fileBrowserMock = vi.fn();

  queueSelect(answer: unknown): void {
    this._selectAnswers.push(() => Promise.resolve(answer));
  }

  queueConfirm(answer: boolean): void {
    this._confirmAnswers.push(() => Promise.resolve(answer));
  }

  queueInput(answer: string): void {
    this._inputAnswers.push(() => Promise.resolve(answer));
  }

  queueCheckbox(answer: readonly unknown[]): void {
    this._checkboxAnswers.push(() => Promise.resolve([...answer]));
  }

  queueEditor(answer: string | null): void {
    this._editorAnswers.push(() => Promise.resolve(answer));
  }

  queueFileBrowser(answer: string | null): void {
    this._fileBrowserAnswers.push(() => Promise.resolve(answer));
  }

  select<T>(options: SelectOptions<T>): Promise<T> {
    this.selectMock(options);
    const next = this._selectAnswers.shift();
    if (!next) throw new Error(`FakePromptPort: no queued answer for select prompt "${options.message}"`);
    return next() as Promise<T>;
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    this.confirmMock(options);
    const next = this._confirmAnswers.shift();
    if (!next) throw new Error(`FakePromptPort: no queued answer for confirm prompt "${options.message}"`);
    return next();
  }

  input(options: InputOptions): Promise<string> {
    this.inputMock(options);
    const next = this._inputAnswers.shift();
    if (!next) throw new Error(`FakePromptPort: no queued answer for input prompt "${options.message}"`);
    return next();
  }

  checkbox<T>(options: CheckboxOptions<T>): Promise<T[]> {
    this.checkboxMock(options);
    const next = this._checkboxAnswers.shift();
    if (!next) throw new Error(`FakePromptPort: no queued answer for checkbox prompt "${options.message}"`);
    return next() as Promise<T[]>;
  }

  async editor(options: EditorOptions): Promise<string | null> {
    this.editorMock(options);
    const next = this._editorAnswers.shift();
    if (!next) return null; // Default: cancel
    return next();
  }

  async fileBrowser(options: FileBrowserOptions): Promise<string | null> {
    this.fileBrowserMock(options);
    const next = this._fileBrowserAnswers.shift();
    if (!next) return null; // Default: cancel
    return next();
  }
}
