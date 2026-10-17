---
name: ensure-helper-must-return-resolvable-path
description: A best-effort "ensure canonical dir" helper that returns the target path even when the move failed makes callers create a second dir that readers then prefer
metadata:
  type: feedback
---

`ensureCanonicalSprintDir` swallows a failed legacy-dir rename and still returns `<id>--<slug>`. Launchers then
`mkdir` side files under it, `resolveEntityName` prefers the new-form dir, and `sprintRepo.findById` answers
NotFound while `sprint.json` / `tasks.json` still sit in the legacy dir. Before the helper existed, writers
followed `resolveSprintDir` and stayed beside the data.

**Why:** the helper's doc promises "the dir the readers resolve"; that only holds when the reconcile succeeds.
Windows (open handles on a dir rename) is the realistic trigger; a read-only/immutable legacy dir shows it on macOS.

**How to apply:** for any helper that returns a path after a best-effort move, force the failure and read back
through the real resolver. On macOS `chflags uchg <dir>` makes `rename` fail (undo with `nouchg`). The fix shape is
to return `resolveSprintDir(...) ?? canonical` when the reconcile did not converge.
