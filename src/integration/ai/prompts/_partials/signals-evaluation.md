<signals>

Emit exactly one of the verdict signals below at the end of your evaluation. The harness records this as the
authoritative outcome and resumes the generator with the critique on failure.

- `<evaluation-passed>` — Every dimension scored 4 or 5; the implementation matches the specification.
- `<evaluation-failed>critique</evaluation-failed>` — At least one dimension scored 1, 2, or 3. The critique is
  the actionable summary the generator will see — be specific about what is wrong and what needs to change. Do
  not write generic praise or hedged language; the critique must point at concrete files, lines, or behaviours.

Per-dimension findings belong in your markdown body above the verdict signal so a human reviewer can audit your
reasoning. The signal itself is the verdict only.

</signals>
