# Test Sizing

## The Test Pyramid

Invest testing effort according to the pyramid — most tests should be small and fast, with progressively
fewer tests at higher levels:

```
          ╱╲
         ╱  ╲         E2E Tests (~5%)
        ╱    ╲        Full user flows, real system
       ╱──────╲
      ╱        ╲      Integration Tests (~15%)
     ╱          ╲     Component interactions, API boundaries
    ╱────────────╲
   ╱              ╲   Unit Tests (~80%)
  ╱                ╲  Pure logic, isolated, milliseconds each
 ╱──────────────────╲
```

**The Beyoncé Rule:** If you liked it, you should have put a test on it. Infrastructure changes,
refactoring, and migrations are not responsible for catching your bugs — your tests are. If a change
breaks your code and you did not have a test for it, that is on you.

### Test Sizes (Resource Model)

Beyond the pyramid levels, classify tests by what resources they consume:

| Size       | Constraints                                            | Speed        | Example                                 |
| ---------- | ------------------------------------------------------ | ------------ | --------------------------------------- |
| **Small**  | Single process, no I/O, no network, no database        | Milliseconds | Pure function tests, data transforms    |
| **Medium** | Multi-process OK, localhost only, no external services | Seconds      | API tests with test DB, component tests |
| **Large**  | Multi-machine OK, external services allowed            | Minutes      | E2E tests, performance benchmarks       |

Small tests should make up the vast majority of your suite. They are fast, reliable, and easy to debug
when they fail.

### Decision Guide

```
Is it pure logic with no side effects?
  → Unit test (small)

Does it cross a boundary (API, database, file system)?
  → Integration test (medium)

Is it a critical user flow that must work end-to-end?
  → E2E test (large) — limit these to critical paths
```
