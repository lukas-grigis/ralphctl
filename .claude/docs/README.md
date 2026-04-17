# .claude/docs/

Living reference docs for ralphctl's architecture. Regenerate / re-read whenever
the shape of the pipelines or data models changes.

## Files

| File                                     | Purpose                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | Layers, ports, pipeline step orders, data models, file storage, error/exit tables |
| [REQUIREMENTS.md](./REQUIREMENTS.md)     | Acceptance-criteria checklists for every feature                                  |
| [seq-refine.puml](./seq-refine.puml)     | Refine pipeline sequence (per-ticket HITL clarification)                          |
| [seq-plan.puml](./seq-plan.puml)         | Plan pipeline sequence (task generation + re-plan detection)                      |
| [seq-ideate.puml](./seq-ideate.puml)     | Ideate pipeline sequence (quick refine + plan in one session)                     |
| [seq-evaluate.puml](./seq-evaluate.puml) | Evaluate pipeline sequence (standalone + nested in Execute)                       |
| [seq-execute.puml](./seq-execute.puml)   | Execute pipeline sequence (outer + per-task + feedback loop)                      |

Each `seq-*.puml` renders with PlantUML and maps 1:1 to a pipeline definition in
`src/business/pipelines/`. When a pipeline gains or drops a step, update the
matching diagram and the step-order row in ARCHITECTURE.md.
