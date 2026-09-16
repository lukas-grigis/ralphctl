```json
{
  "schemaVersion": 1,
  "signals": [
    {
      "type": "evaluation",
      "status": "failed",
      "dimensions": [
        { "dimension": "correctness", "passed": false, "finding": "assessment in progress" },
        { "dimension": "completeness", "passed": false, "finding": "assessment in progress" },
        { "dimension": "safety", "passed": false, "finding": "assessment in progress" },
        { "dimension": "consistency", "passed": false, "finding": "assessment in progress" },
        { "dimension": "robustness", "passed": false, "applicable": false, "finding": "assessment in progress" }
      ],
      "timestamp": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Robustness carries the optional `applicable` field shown above — set it to `false` only if your
review determines the change touches no error/failure path (with the real reason in `finding`), or
omit it (default `true`) once you record an actual pass/fail.
