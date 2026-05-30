# AI session data flow

Every AI-spawning leaf (refine, plan, ideate, implement-generator/evaluator, readiness,
detect-scripts, detect-skills, apply-feedback, create-pr) follows the same audit-[09] contract: the AI
writes one file (`signals.json`), the harness validates + projects.

## What moves between the harness and the AI

```mermaid
sequenceDiagram
    participant Leaf as Chain leaf
    participant Prompt as &lt;leaf&gt;.contract.ts<br/>+ prompt template
    participant Disk as &lt;outputDir&gt;/
    participant AI as AI provider (headless / interactive)
    participant Bus as EventBus + sink

    Leaf->>Prompt: render with placeholders + outputContractSection
    Prompt-->>Leaf: Prompt object
    Leaf->>Disk: write prompt.md (audit trail)
    Leaf->>AI: spawn (prompt, cwd, outputDir, permissions)
    AI->>Disk: Write tool → signals.json (envelope)
    Note over AI,Disk: optional bodyFile mirror for forensics

    AI-->>Leaf: exit + sessionId
    Leaf->>Disk: read signals.json
    Leaf->>Leaf: validate against signalsSchema (Zod)
    alt validation fails
        Leaf-->>Bus: error (ParseError · MigrationGapError · signals-missing · StorageError)
    else validation ok
        Leaf->>Disk: renderSidecars (commit-message.txt · evaluation.md · …)
        Leaf->>Bus: fan-out each validated signal
    end
```

## The wrapper shape on disk

```json
{
  "schemaVersion": 1,
  "signals": [{ "type": "task-complete", "timestamp": "2026-05-23T10:00:00.000Z" }]
}
```

The contract's `migrations[v]` chain walks `fileVersion → schemaVersion` so in-flight sprints
written with an older shape upgrade transparently at read time. A missing migration step
surfaces as `MigrationGapError` — never silent corruption.

## Why one file

Pre-audit, every adapter (claude / copilot / codex) parsed stdout for XML signal tags and
synthesised `signals.json`. That coupled the harness to each CLI's stdout format. The
contract path inverts the responsibility: the AI uses its own `Write` tool to land the file
verbatim; the adapter only mirrors raw body for forensic capture.

## Where each piece lives

| Concern              | Path                                                             |
| -------------------- | ---------------------------------------------------------------- |
| Per-kind Zod schemas | `src/integration/ai/contract/_engine/signals/<kind>/schema.ts`   |
| Validation reader    | `src/integration/ai/contract/_engine/validate-signals-file.ts`   |
| Sidecar renderer     | `src/integration/ai/contract/_engine/render-sidecars.ts`         |
| Per-leaf contract    | `src/application/flows/<flow>/leaves/<leaf>.contract.ts`         |
| Prompt section       | `src/integration/ai/contract/_engine/render-contract-section.ts` |

The audit-[09] contract is implemented under `src/integration/ai/contract/_engine/` (see the table above).
