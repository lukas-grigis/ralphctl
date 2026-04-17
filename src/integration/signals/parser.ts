/**
 * Signal parser implementation — extracts HarnessSignal objects from raw AI agent output.
 *
 * This parser consolidates signal extraction logic from:
 * - src/ai/parser.ts (task execution signals)
 * - src/ai/evaluator.ts (evaluation signals)
 * - src/commands/sprint/plan-utils.ts (planning signals)
 *
 * The parser is pure (no side effects) and returns typed signal objects in extraction order.
 */

import type {
  HarnessSignal,
  ProgressSignal,
  EvaluationSignal,
  TaskCompleteSignal,
  TaskVerifiedSignal,
  TaskBlockedSignal,
  NoteSignal,
  DimensionScore,
  EvaluationDimension,
} from '@src/domain/signals.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';

/**
 * Regex patterns for signal extraction.
 * Pre-compiled to avoid repeated creation per parse call.
 */
const SIGNAL_PATTERNS = {
  progress: /<progress>([\s\S]*?)<\/progress>/g,
  progressWithFiles: /<progress>([\s\S]*?)<\/progress>/,
  evaluation_passed: /<evaluation-passed>/,
  evaluation_failed: /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/,
  task_verified: /<task-verified>([\s\S]*?)<\/task-verified>/,
  task_complete: /<task-complete>/,
  task_blocked: /<task-blocked>([\s\S]*?)<\/task-blocked>/,
  note: /<note>([\s\S]*?)<\/note>/g,
  // Dimension scoring patterns
  correctness: /\*\*correctness\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
  completeness: /\*\*completeness\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
  safety: /\*\*safety\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
  consistency: /\*\*consistency\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
};

/**
 * Extract dimension scores from evaluation output.
 * Matches lines like: **Correctness**: PASS — one-line finding
 */
function parseDimensionScores(output: string): DimensionScore[] {
  const dimensions: EvaluationDimension[] = ['correctness', 'completeness', 'safety', 'consistency'];
  const scores: DimensionScore[] = [];

  for (const dim of dimensions) {
    const pattern = SIGNAL_PATTERNS[dim];
    const match = pattern.exec(output);
    if (match?.[1] && match[2]) {
      scores.push({
        dimension: dim,
        passed: match[1].toUpperCase() === 'PASS',
        finding: match[2].trim(),
      });
    }
  }

  return scores;
}

/**
 * Signal parser implementation.
 * Extracts all HarnessSignal objects from raw AI agent output in order.
 */
export class SignalParser implements SignalParserPort {
  parseSignals(output: string): HarnessSignal[] {
    const signals: HarnessSignal[] = [];
    const timestamp = new Date();

    // Parse progress signals
    // Format: <progress>summary</progress> or <progress files="path1,path2">summary</progress>
    let progressMatch: RegExpExecArray | null;
    while ((progressMatch = SIGNAL_PATTERNS.progress.exec(output)) !== null) {
      const summary = progressMatch[1]?.trim();
      if (summary) {
        const progressSignal: ProgressSignal = {
          type: 'progress',
          summary,
          // Note: Phase 1 doesn't parse files attribute; added in Phase 2+
          timestamp,
        };
        signals.push(progressSignal);
      }
    }

    // Parse evaluation signal
    // Format: <evaluation-passed> or <evaluation-failed>critique</evaluation-failed>
    if (output.includes('<evaluation-passed>')) {
      const dimensions = parseDimensionScores(output);
      const evaluationSignal: EvaluationSignal = {
        type: 'evaluation',
        status: 'passed',
        dimensions,
        timestamp,
      };
      signals.push(evaluationSignal);
    } else {
      const failedMatch = SIGNAL_PATTERNS.evaluation_failed.exec(output);
      if (failedMatch?.[1]) {
        const critique = failedMatch[1].trim();
        const dimensions = parseDimensionScores(output);
        const evaluationSignal: EvaluationSignal = {
          type: 'evaluation',
          status: dimensions.length > 0 ? 'failed' : 'malformed',
          dimensions,
          critique: dimensions.length > 0 ? critique : undefined,
          timestamp,
        };
        signals.push(evaluationSignal);
      } else if (parseDimensionScores(output).length > 0) {
        // No signal, but dimensions parsed — still failed
        const dimensions = parseDimensionScores(output);
        const evaluationSignal: EvaluationSignal = {
          type: 'evaluation',
          status: 'failed',
          dimensions,
          timestamp,
        };
        signals.push(evaluationSignal);
      }
    }

    // Parse task execution signals in order: verify → complete, or blocked
    const taskVerifiedMatch = SIGNAL_PATTERNS.task_verified.exec(output);
    if (taskVerifiedMatch?.[1]) {
      const verificationOutput = taskVerifiedMatch[1].trim();
      const verifiedSignal: TaskVerifiedSignal = {
        type: 'task-verified',
        output: verificationOutput,
        timestamp,
      };
      signals.push(verifiedSignal);
    }

    if (output.includes('<task-complete>')) {
      const completeSignal: TaskCompleteSignal = {
        type: 'task-complete',
        timestamp,
      };
      signals.push(completeSignal);
    }

    const taskBlockedMatch = SIGNAL_PATTERNS.task_blocked.exec(output);
    if (taskBlockedMatch?.[1]) {
      const reason = taskBlockedMatch[1].trim();
      const blockedSignal: TaskBlockedSignal = {
        type: 'task-blocked',
        reason,
        timestamp,
      };
      signals.push(blockedSignal);
    }

    // Parse note signals
    // Format: <note>text</note>
    let noteMatch: RegExpExecArray | null;
    while ((noteMatch = SIGNAL_PATTERNS.note.exec(output)) !== null) {
      const text = noteMatch[1]?.trim();
      if (text) {
        const noteSignal: NoteSignal = {
          type: 'note',
          text,
          timestamp,
        };
        signals.push(noteSignal);
      }
    }

    return signals;
  }
}
