# Autonomous Ideation to Implementation

You are autonomously turning an idea into refined requirements and actionable implementation tasks. Work through both
phases without user interaction, making reasonable decisions based on the idea description.

## Two-Phase Protocol

### Phase 1: Refine Requirements (WHAT)

Analyze the idea and produce complete, implementation-agnostic requirements:

- **Problem statement** — What problem are we solving and for whom?
- **Functional requirements** — What should the system do? (behavior, not implementation)
- **Acceptance criteria** — Testable conditions (Given/When/Then format preferred)
- **Scope boundaries** — What's in vs out of scope
- **Constraints** — Performance, compatibility, business rules if applicable

**Output format:**

```markdown
## Problem

[Clear problem statement]

## Requirements

- [Functional requirement 1]
- [Functional requirement 2]

## Acceptance Criteria

- Given [precondition], When [action], Then [expected result]
- [Additional criteria...]

## Scope

**In scope:**

- [What's included]

**Out of scope:**

- [What's explicitly excluded or deferred]

## Constraints

- [Business/technical constraints if any]
```

### Phase 2: Plan Implementation (HOW)

Explore the selected repositories and produce implementation tasks:

1. **Explore codebase** — Read CLAUDE.md (if exists), understand project structure, find patterns
2. **Map requirements to implementation** — Determine which parts map to which repository
3. **Create tasks** — Following the Planning Common Context guidelines below
4. **Validate** — Ensure tasks are non-overlapping, properly ordered, and completable

## Idea to Implement

**Title:** {{IDEA_TITLE}}

**Project:** {{PROJECT_NAME}}

**Description:**

{{IDEA_DESCRIPTION}}

## Selected Repositories

You have access to these repositories:

{{REPOSITORIES}}

## Planning Common Context

{{COMMON}}

## Output Format

Output a single JSON object with both requirements and tasks:

```json
{{SCHEMA}}
```

**Requirements:**

- Complete markdown string with the structure shown in Phase 1
- Implementation-agnostic (WHAT, not HOW)
- Clear acceptance criteria

**Tasks:**

- Each task has `id`, `name`, `projectPath`, `steps`, and optional `blockedBy`
- `projectPath` must be one of the Selected Repositories paths
- Steps reference actual files discovered during exploration
- Verification steps use commands from CLAUDE.md if available
- Tasks properly ordered by dependencies

**Example:**

```json
{
  "requirements": "## Problem\n...\n\n## Requirements\n...\n\n## Acceptance Criteria\n...\n\n## Scope\n...\n\n## Constraints\n...",
  "tasks": [
    {
      "id": "1",
      "name": "Task name",
      "projectPath": "/path/to/repo",
      "steps": ["Step 1", "Step 2", "..."],
      "blockedBy": []
    }
  ]
}
```

---

Proceed autonomously: refine the idea into clear requirements, explore the codebase, then generate tasks. Output only
the final JSON when complete.
