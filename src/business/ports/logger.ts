export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  sprintId?: string;
  taskId?: string;
  step?: string;
  projectPath?: string;
  [key: string]: unknown;
}

export interface SpinnerHandle {
  succeed(message: string): void;
  fail(message: string): void;
  stop(): void;
}

export interface LoggerPort {
  // Structured log levels
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;

  // UI-level output (replaces showSuccess, showWarning, etc.)
  success(message: string): void;
  warning(message: string): void;
  tip(message: string): void;

  // Layout
  header(title: string, icon?: string): void;
  separator(width?: number): void;
  field(label: string, value: string, width?: number): void;
  card(title: string, lines: string[]): void;
  newline(): void;
  dim(message: string): void;
  item(message: string): void;

  // Interactive
  spinner(message: string): SpinnerHandle;

  // Scoped child logger
  child(context: LogContext): LoggerPort;

  // Timing — returns a stop function that logs duration
  time(label: string): () => void;
}
