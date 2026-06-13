---
name: ledger-unknown-field-preservation
description: stamp-promoted must preserve non-stamped learnings.ndjson lines BYTE-FOR-BYTE (raw line), because the z.object schema strips unknown future fields on parse
metadata:
  type: project
---

`learningRecordSchema` (application/flows/\_shared/memory/learning-record.ts) is a plain `z.object`
that STRIPS unknown keys on parse — its `.strict()` is intentionally omitted with a comment claiming
older readers "tolerate (ignore)" future fields. But any read-modify-WRITE that re-serializes a parsed
record silently DELETES those fields.

**Why:** `stampPromotedLeaf` rebuilds the entire ledger from parsed records on every distill. An older
pinned `npx ralphctl@x` running distill against a shared `<memoryRoot>` ledger would destroy fields a
newer version added — "tolerate on read" silently becoming "destroy on write".

**How to apply:** In any ledger rewrite, only re-serialize the rows you actually mutate; preserve every
other row from its original trimmed raw line (`outLines.push(\`${trimmed}\n\`)`). Do NOT switch the
schema to `z.looseObject`/passthrough as the fix — it adds an index signature to the inferred type and
breaks the `\_SchemaMatchesInterface`compile-time guard that fences write/read drift. Test pattern: a
ledger line with an extra`futureField` survives a stamp of a DIFFERENT row unchanged (assert via raw
JSON.parse of the on-disk line, not via parseLearningLine which would strip it back).
