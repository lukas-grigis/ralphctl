import type { SprintStatus } from '@src/domain/entity/sprint.ts';

/**
 * Pre-launch readiness predicates declared by each flow. The TUI / CLI evaluate these against
 * the current session state to decide whether the flow's menu entry is enabled — and to show
 * a human-readable hint when it isn't.
 *
 * All fields are optional; an empty object means "always available." Each declared field acts
 * as a conjunction: every present field must match for the flow to be enabled. `currentSprintStatus`
 * is itself an OR — any of the listed values passes.
 */
export interface FlowTriggers {
  /** Flow needs an active project context (e.g. project root resolved). */
  readonly requiresProject?: boolean;
  /** Sprint must be in one of the listed statuses. */
  readonly currentSprintStatus?: readonly SprintStatus[];
  /** Sprint must have at least this many pending (un-refined) tickets. */
  readonly minPendingTickets?: number;
  /** Sprint must have at least this many approved tickets (ready to plan). */
  readonly minApprovedTickets?: number;
  /**
   * Sprint must have at least this many tasks the implement chain can pick up — `todo` PLUS
   * `in_progress`. Counting both matches `launchImplement`'s filter, which lets the resume
   * path re-launch on a sprint whose only remaining work is a half-finished attempt.
   */
  readonly minResumableTasks?: number;
}

/**
 * Static metadata for a flow, declared once and consumed by the CLI command builder, the TUI
 * menu, and the launch logic. Adding a flow to the application means adding one entry to
 * {@link flowRegistry} — no other index file or scattered list needs to learn about it.
 */
export interface FlowManifest {
  /** Stable kebab-case identifier — also the URL-safe key for routing / persistence. */
  readonly id: string;
  /** Human-friendly title shown in the TUI menu and CLI help. */
  readonly title: string;
  /** One-line description of what the flow does. */
  readonly description: string;
  /**
   * True iff the flow can run detached from the interactive session (e.g. the implement loop).
   * False for flows that wait on per-step user input.
   */
  readonly canBackground: boolean;
  /** Pre-launch readiness predicates — see {@link FlowTriggers}. */
  readonly triggers: FlowTriggers;
}

/**
 * Each flow exports its own typed factory; the registry holds just the manifest. Concrete
 * `Element<TCtx>` factories live next to the manifest in each flow folder and are imported
 * directly by the launcher / CLI command builder.
 */
export interface FlowEntry {
  readonly manifest: FlowManifest;
}

import { createSprintManifest } from '@src/application/flows/create-sprint/manifest.ts';
import { refineManifest } from '@src/application/flows/refine/manifest.ts';
import { addTicketsManifest } from '@src/application/flows/add-tickets/manifest.ts';
import { planManifest } from '@src/application/flows/plan/manifest.ts';
import { readinessManifest } from '@src/application/flows/readiness/manifest.ts';
import { detectScriptsManifest } from '@src/application/flows/detect-scripts/manifest.ts';
import { detectSkillsManifest } from '@src/application/flows/detect-skills/manifest.ts';
import { implementManifest } from '@src/application/flows/implement/manifest.ts';
import { reviewManifest } from '@src/application/flows/review/manifest.ts';
import { closeSprintManifest } from '@src/application/flows/close-sprint/manifest.ts';
import { ideateManifest } from '@src/application/flows/ideate/manifest.ts';
import { exportContextManifest } from '@src/application/flows/export-context/manifest.ts';
import { exportRequirementsManifest } from '@src/application/flows/export-requirements/manifest.ts';
import { createPrManifest } from '@src/application/flows/create-pr/manifest.ts';
import { doctorManifest } from '@src/application/flows/doctor/manifest.ts';
import { settingsManifest } from '@src/application/flows/settings/manifest.ts';
import { ticketAddManifest } from '@src/application/flows/ticket-add/manifest.ts';
import { ticketRemoveManifest } from '@src/application/flows/ticket-remove/manifest.ts';

/**
 * Single source of truth for "what flows exist." Adding a flow = appending one entry. Order
 * here drives display order in the TUI menu and CLI help.
 */
export const flowRegistry: readonly FlowEntry[] = [
  { manifest: createSprintManifest },
  { manifest: ideateManifest },
  { manifest: refineManifest },
  { manifest: addTicketsManifest },
  { manifest: planManifest },
  { manifest: readinessManifest },
  { manifest: detectScriptsManifest },
  { manifest: detectSkillsManifest },
  { manifest: implementManifest },
  { manifest: reviewManifest },
  { manifest: closeSprintManifest },
  { manifest: exportContextManifest },
  { manifest: exportRequirementsManifest },
  { manifest: createPrManifest },
  { manifest: doctorManifest },
  { manifest: settingsManifest },
  { manifest: ticketAddManifest },
  { manifest: ticketRemoveManifest },
];
