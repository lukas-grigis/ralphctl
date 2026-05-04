---
name: Smoke tests must probe real content not just placeholder resolution
description: assertNoUnresolvedPlaceholders is necessary but not sufficient — add content assertions too
type: feedback
---

The smoke test `assertNoUnresolvedPlaceholders` only checks that no `{{FOO}}` tokens survive substitution.
It passes even when every slot is filled with empty strings — which was the exact bug in `buildExecutePrompt`:
all slots filled with `''`, smoke test green, but the AI got a blank task directive.

**Why:** Substituting empty strings counts as "resolved" to the pattern check. The real regression is
that task content never reached the AI.

**How to apply:** For every builder method that has mandatory content (task name, sprint name, etc.),
add an `expect(r.value).toContain(...)` assertion AFTER `assertNoUnresolvedPlaceholders`. The content
assertion is the true regression guard; the placeholder check is only the syntax guard.

Example added in `prompt-completeness.smoke.test.ts`:

```ts
assertNoUnresolvedPlaceholders(r.value, 'buildExecutePrompt');
expect(r.value).toContain('wire-up-login-form'); // task name must reach the AI
```
