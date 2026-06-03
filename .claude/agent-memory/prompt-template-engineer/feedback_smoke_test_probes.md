---
name: Prompt tests must probe real content, not just placeholder resolution
description: Placeholder-parity is necessary but not sufficient — also assert the rendered body actually contains mandatory task content
type: feedback
---

**Durable principle: probe real content.** A placeholder-parity check (no `{{FOO}}` survives, every declared
slot is used) only guards syntax. It passes even when every slot is filled with an empty string — which was the
exact regression once: all task slots filled with `''`, parity green, but the AI got a blank task directive.
Substituting empty strings counts as "resolved" to a pattern check, so the real regression (task content never
reaching the AI) slips through. The content assertion is the true regression guard; the parity check is only the
syntax guard.

**Where this lives now:** parity is enforced per-flow at
`tests/integration/ai/prompts/<flow>/definition.test.ts` (both directions — every template placeholder is
declared by the def's parameters/partials, and every declared placeholder appears in the template), via
`extractPlaceholders` from `_engine/`. The meta-test `template-coverage.test.ts` fails the suite if a new flow
lands without its `definition.test.ts`. The old global `assertNoUnresolvedPlaceholders` /
`prompt-completeness.smoke.test.ts` are gone.

**How to apply:** alongside the parity assertions, add `expect(rendered).toContain(...)` checks on each
section renderer for mandatory content — e.g. the implement def's `renderTaskDescriptionSection` /
`renderTaskStepsSection` tests assert the heading AND a sample body line are present, and assert the empty-string
collapse when the field is absent. Pin the actual task text (a sample task name / step) so an empty-fill
regression fails the suite.
