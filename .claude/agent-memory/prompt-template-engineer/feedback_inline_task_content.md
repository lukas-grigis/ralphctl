---
name: Inline task content in the prompt
description: Inline task fields directly into the prompt — no per-task context-file indirection; the AI must receive task name / description / steps / criteria in the prompt body itself
type: feedback
---

**Durable principle: inline, don't indirect.** A prompt builder must fill task fields (name, description,
steps, verification criteria) directly into the prompt body. Writing a per-task context file and pointing the
prompt at it is needless IO, hard to test, and doesn't survive session-resume well. An early regression filled
every slot with empty strings — the AI received the template with no task content, causing silent do-nothing
runs and evaluator failures.

**Where this lives now:** the implement prompt is `src/integration/ai/prompts/implement/template.md`; the
generator / evaluator leaves render it via `round-artifacts.ts` (`writeRoundPrompt` lands the fully-substituted
prompt at `rounds/<N>/<role>/prompt.md` before each spawn). The earlier `buildExecutePrompt` builder and the
`task-execution.md` template are both gone.

**How to apply:** task content reaches the AI through inlined placeholders — `{{TASK_NAME}}`, `{{TASK_ID}}`,
`{{PROJECT_PATH}}`, `{{TASK_DESCRIPTION_SECTION}}`, `{{TASK_STEPS_SECTION}}`,
`{{VERIFICATION_CRITERIA_SECTION}}`, `{{PROGRESS_FILE}}`. Section-style placeholders collapse to empty string
when the field is absent (e.g. a task with no description) rather than leaving a bare label. Never reintroduce a
"write a per-task file, then reference its path" indirection for content the prompt body can carry directly.
