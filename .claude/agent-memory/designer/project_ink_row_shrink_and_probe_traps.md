---
name: project-ink-row-shrink-and-probe-traps
description: Ink row Boxes shrink their leading Text siblings to nothing; pty-probe batching and partial-frame artefacts; location-line drill-in rule
metadata:
  type: project
---

A row `<Box>` whose cursor / checkbox / label are bare `<Text>` siblings of a long truncating cell loses them under Yoga's default shrink: the cursor vanishes and the row grows a blank second line (seen in System hub, Housekeeping, Runs). Wrap fixed cells in `<Box flexShrink={0}>`, give the flexible cell `flexShrink={1} minWidth={0}` + `wrap="truncate-end"` (`truncate-middle` for paths). Reproduce in 10 lines with `renderToString` from ink at width 80 — ink-testing-library's 100 cols hides it, `renderAtSize` at 60 shows it.

**Why:** the 80x24 probe showed "rows lost / misaligned" that never failed a test; the cause was layout shrink, not data.

**How to apply:** any new list row with a long trailing string; add a `renderAtSize(…, { columns: 60 })` test that asserts one line per row.

Pty probe traps: (1) several keys in one `keys` string arrive as a single chunk and Ink drops all but the first arrow — send one key per step. (2) Snapshots of a freshly mounted big view can be a half-painted frame under CPU load (three parallel probes, or a scripted demo run starting) — re-run that size alone before calling it a bug. (3) Help-overlay rows wrapping past the card width garbled neighbouring rows in the terminal; labels must truncate.

Location line below `lg`: on a drilled-in view (trail present) or an Execute view with a status chip, drop chip → sprint → project before clipping the trail, so the row never reads as two truncated sprint names.
