# Changelog

All notable changes to RalphCTL will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-02-15

### Added

- **Project management** — register multi-repo projects with named paths
- **Sprint lifecycle** — create, activate, close sprints with state machine enforcement (draft -> active -> closed)
- **Ticket tracking** — add work items linked to projects, with optional external IDs
- **Two-phase planning** — refine requirements (WHAT) then generate tasks (HOW) with human approval gates
- **Task dependencies** — `blockedBy` references with topological sort and cycle detection
- **Task execution** — headless, watch, session, and interactive modes via Claude CLI
- **Parallel execution** — one task per repo concurrently, with rate limit backoff and session resume
- **Interactive menu mode** — context-aware REPL with persistent status header and Quick Start wizard
- **Sprint health checks** — diagnose blockers, stale tasks, and missing dependencies
- **Requirements export** — markdown export of refined requirements
- **Progress logging** — append-only timestamped progress log per sprint
- **Ralph Wiggum personality** — themed UI with donut spinners, random quotes, and gradient banner
