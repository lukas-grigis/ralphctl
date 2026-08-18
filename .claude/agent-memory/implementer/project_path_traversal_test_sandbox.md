---
name: path-traversal-test-sandbox
description: Writing a failing path-traversal regression test first really escapes the tmp sandbox — nest the session dir under a per-run root or the post-fix assertion is poisoned by the artifact the pre-fix run wrote
metadata:
  type: project
---

Test-first on a path-traversal defect: the failing run genuinely writes outside the fixture. A name
like `../../../../tmp/pwned` under a `mkdtemp` session dir landed a real `SKILL.md` in
`$TMPDIR/tmp/pwned`, which then made the post-fix `expect(existsSync(escapeTarget)).toBe(false)`
assertion fail forever until the artifact was deleted by hand.

**Why:** traversal targets that leave the unique `mkdtemp` dir resolve to a SHARED path, so the
escape assertion is not run-isolated — a leftover from any earlier run (or from the vulnerable code
itself) masks a regression in both directions.

**How to apply:** for any traversal regression test, build the fixture as `root = mkdtemp(...)` +
`session = root/repo`, and pick traversal depths that resolve back inside `root` (`../escape`,
`../../../escape-far`). The escape is still real (outside `session`) but the asserted path stays
unique per run. Related: [[project_slugged_data_layout_resolver]].
