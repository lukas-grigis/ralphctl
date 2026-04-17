import { SignalParser } from '@src/integration/signals/parser.ts';

interface ExecutionResult {
  success: boolean;
  output: string;
  blockedReason?: string;
  verified?: boolean;
  verificationOutput?: string;
}

const signalParser = new SignalParser();

/**
 * Parse execution result from AI provider output.
 * Delegates to the consolidated SignalParser and maps HarnessSignal[] to ExecutionResult.
 */
export function parseExecutionResult(output: string): ExecutionResult {
  const signals = signalParser.parseSignals(output);

  // Extract task lifecycle signals
  const verifiedSignal = signals.find((s) => s.type === 'task-verified');
  const completeSignal = signals.find((s) => s.type === 'task-complete');
  const blockedSignal = signals.find((s) => s.type === 'task-blocked');

  const verified = verifiedSignal != null;
  const verificationOutput = verifiedSignal?.type === 'task-verified' ? verifiedSignal.output : undefined;

  // task-complete requires prior task-verified
  if (completeSignal) {
    if (!verified) {
      return {
        success: false,
        output,
        blockedReason:
          'Task marked complete without verification. Output <task-verified> with verification results before <task-complete>.',
      };
    }
    return { success: true, output, verified, verificationOutput };
  }

  // task-blocked
  if (blockedSignal) {
    return { success: false, output, blockedReason: blockedSignal.reason, verified, verificationOutput };
  }

  // No signal found
  return { success: false, output, blockedReason: 'No completion signal received', verified, verificationOutput };
}
