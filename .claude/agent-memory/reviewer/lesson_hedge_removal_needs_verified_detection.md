---
name: lesson-hedge-removal-needs-verified-detection
description: Removing a prompt-side graceful-degradation hedge because a detector-driven fallback now covers the case — check every adapter's detector is verified against the real CLI
metadata:
  type: feedback
---

When a diff deletes a prompt hedge ("if this session lacks context, re-read X") on the grounds that
a harness-side fallback now handles the failure, the hedge was covering BOTH detected and
undetected failures. The fallback only covers what the per-adapter detector (e.g. `RESUME_STALE_RE`)
matches. Check each adapter's detector comment: if it says the CLI wording is undocumented or
unverified (copilot's stale-resume regex does), the undetected path just lost its safety net.

**Why:** conformance tests for such fallbacks script each adapter's own regex wording into the fake
spawn, so they are tautological for detection — they prove the swap, not that the real CLI's
message matches. A green suite says nothing about the undetected path.

**How to apply:** on any "fallback now covers it, drop the hedge" diff, list the detectors, note
which are verified against the real CLI (look for "verified against vX" in the comment), and flag
the rest as residual risk rather than a blocker unless the hedge removal was optional.
Related: [[lesson-partial-wiring-of-general-seam]].
