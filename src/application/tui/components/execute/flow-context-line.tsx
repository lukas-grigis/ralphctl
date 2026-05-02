/**
 * FlowContextLine — dim sub-line below the session label that names the kind
 * of work the chain is doing.
 *
 * Sprint workflows (refine / plan / ideate / execute / feedback / create-pr)
 * get a "Sprint workflow — <flow>" prefix; one-shot chains (onboard) get
 * "Repo onboarding". Pure label parsing.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';
import type { LiveStep } from './step-trace.tsx';

// ── Flow label parser ─────────────────────────────────────────────────────────

function parseFlowType(label: string): string | null {
  const match = /^(\S+)\s+/.exec(label);
  return match?.[1] ?? null;
}

function describeFlow(label: string): { kind: 'sprint' | 'project' | 'other'; prefix: string; target: string } | null {
  const match = /^(\S+)\s+(\S+?)(?:#\d+)?$/.exec(label);
  if (!match) return null;
  const flow = match[1];
  const target = match[2];
  if (flow === undefined || target === undefined) return null;
  const sprintFlows = ['refine', 'plan', 'ideate', 'execute', 'feedback', 'create-pr'];
  if (sprintFlows.includes(flow)) return { kind: 'sprint', prefix: `Sprint workflow — ${flow}`, target };
  if (flow === 'onboard') return { kind: 'project', prefix: 'Repo onboarding', target };
  return { kind: 'other', prefix: flow, target };
}

// ── Next-step CTA ─────────────────────────────────────────────────────────────

export interface NextStep {
  readonly action: string;
  readonly description?: string;
}

/** Heuristic: per-task child steps inside an execute chain are named `task-<id>`. */
function isTaskStep(name: string): boolean {
  return /^task-[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Derive contextual next-step suggestions from the flow that just settled.
 * Terminal `failed` / `aborted` states always get a generic recovery hint.
 */
export function nextStepsForFlow(
  label: string,
  terminalStatus: 'completed' | 'failed' | 'aborted',
  steps: readonly LiveStep[]
): readonly NextStep[] {
  if (terminalStatus === 'failed' || terminalStatus === 'aborted') {
    return [
      { action: 'Esc', description: 'back to home' },
      { action: 'Check the steps above', description: 'to find the error, then try again' },
    ];
  }
  const flow = parseFlowType(label);
  switch (flow) {
    case 'refine':
      return [{ action: 'ralphctl sprint plan', description: 'plan implementation tasks' }];
    case 'plan':
    case 'ideate':
      return [{ action: 'ralphctl sprint start', description: 'start the sprint and execute tasks' }];
    case 'execute': {
      const taskSteps = steps.filter((s) => isTaskStep(s.name));
      const allPassed =
        taskSteps.length === 0 || taskSteps.every((s) => s.status === 'completed' || s.status === 'skipped');
      if (allPassed) {
        return [
          { action: 'ralphctl sprint close', description: 'close when done' },
          { action: 'ralphctl sprint create-pr', description: 'or publish a PR first' },
        ];
      }
      return [{ action: 'Continue from home', description: 'some tasks need attention' }];
    }
    case 'feedback':
      return [{ action: 'Continue work or close the sprint', description: 'feedback applied' }];
    case 'create-pr':
      return [{ action: 'ralphctl sprint close', description: 'sprint is published — close when ready' }];
    case 'onboard':
      return [{ action: 'Onboarding complete', description: 'project context file written' }];
    default:
      return [{ action: 'Esc', description: 'back to home' }];
  }
}

// ── FlowContextLine component ─────────────────────────────────────────────────

interface FlowContextLineProps {
  readonly label: string;
}

export function FlowContextLine({ label }: FlowContextLineProps): React.JSX.Element | null {
  const desc = describeFlow(label);
  if (!desc) return null;
  const accent =
    desc.kind === 'sprint' ? inkColors.primary : desc.kind === 'project' ? inkColors.info : inkColors.muted;
  const glyph = desc.kind === 'sprint' ? glyphs.phaseActive : desc.kind === 'project' ? glyphs.badge : glyphs.inlineDot;
  return (
    <Box>
      <Text color={accent}>{`  ${glyph} ${desc.prefix}`}</Text>
      <Text color={inkColors.muted}>{`  ${glyphs.inlineDot}  `}</Text>
      <Text color={inkColors.muted}>{desc.target}</Text>
    </Box>
  );
}
