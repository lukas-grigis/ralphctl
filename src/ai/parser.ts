export interface ExecutionResult {
  success: boolean;
  output: string;
  blockedReason?: string;
  verified?: boolean;
  verificationOutput?: string;
}

/**
 * Parse execution result from AI provider output.
 * Checks for task-verified, task-complete, and task-blocked signals.
 */
export function parseExecutionResult(output: string): ExecutionResult {
  // Check for verification signal
  const verifiedMatch = /<task-verified>([\s\S]*?)<\/task-verified>/.exec(output);
  const verified = verifiedMatch !== null;
  const verificationOutput = verifiedMatch?.[1]?.trim();

  // Check for completion signal
  if (output.includes('<task-complete>')) {
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

  // Check for blocked signal
  const blockedMatch = /<task-blocked>([\s\S]*?)<\/task-blocked>/.exec(output);
  if (blockedMatch) {
    return { success: false, output, blockedReason: blockedMatch[1]?.trim(), verified, verificationOutput };
  }

  // No signal found - treat as incomplete
  return { success: false, output, blockedReason: 'No completion signal received', verified, verificationOutput };
}
