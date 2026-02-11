# Tester Memory

## Test Setup

- **Framework:** vitest
- **Config:** `vitest.config.ts` in project root
- **Location:** Colocated `*.test.ts` files next to source

## Test Files Found

```
src/claude/runner.test.ts       # Claude runner tests
src/integration/cli-smoke.test.ts # CLI smoke tests (comprehensive E2E scenarios)
src/integration/cli.test.ts     # CLI integration tests
src/schemas/index.test.ts       # Schema validation tests
src/store/progress.test.ts      # Progress store tests
src/store/task.test.ts          # Task store tests (topological sort, validation)
src/store/ticket.test.ts        # Ticket store tests
src/theme/index.test.ts         # Theme tests
src/utils/ids.test.ts           # ID generation tests
```

## Interactive Mode Coverage

The interactive menu (`src/interactive/menu.ts`) defines menu structure but is **not directly tested**. However:

- **CLI commands** are comprehensively tested via `cli-smoke.test.ts`
- Interactive mode dispatches to the same command handlers
- Test coverage is indirect but effective

**Ticket Edit Status:**

- Menu entry exists at line 72 of `src/interactive/menu.ts`:
  `{ name: 'Edit', value: 'edit', description: 'Edit a ticket' }`
- **MISSING:** CLI handler not in interactive dispatch map (line 78-82 of `src/interactive/index.ts`)
- Command implementation: `src/commands/ticket/edit.ts` (fully implemented)
- CLI tests: Comprehensive coverage in `cli-smoke.test.ts` lines 310-326, 716-752

**Fix Required:**

- Import: `import { ticketEditCommand } from '@src/commands/ticket/edit.ts';`
- Dispatch: Add `edit: () => ticketEditCommand(undefined, { interactive: true })` to ticket command map

## Test Patterns

### Factory Functions

Create test data with sensible defaults:

```typescript
function createTask(id: string, blockedBy: string[] = []): Task {
  return {
    id,
    name: `Task ${id}`,
    description: undefined,
    steps: [],
    status: 'todo',
    order: 1,
    ticketId: undefined,
    blockedBy,
    projectPath: '/tmp/test',
    verified: false,
  };
}
```

### Describe/It Structure

Group related tests, descriptive names:

```typescript
describe('topologicalSort', () => {
  it('sorts independent tasks by original order', () => { ... });
  it('puts dependencies before dependents', () => { ... });
  it('detects simple cycle', () => { ... });
});
```

### Testing Errors

```typescript
it('detects simple cycle', () => {
  const tasks = [createTask('a', ['b']), createTask('b', ['a'])];
  expect(() => topologicalSort(tasks)).toThrow(DependencyCycleError);
});
```

### Testing Validation

```typescript
it('rejects reference to non-existent task', () => {
  const importTasks = [{ name: 'Task', blockedBy: ['nonexistent'] }];
  const errors = validateImportTasks(importTasks, []);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('does not exist');
});
```

## Commands

```bash
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
pnpm test <pattern>    # Run specific tests
```

## Test Categories

### Unit Tests (src/store/, src/utils/)

- Pure function testing
- No I/O mocking needed for algorithms
- Fast, focused tests

### Integration Tests (src/integration/)

- CLI command execution via in-process `runCli` helper or `execSync`
- Tests actual command output
- Slower, higher confidence
- `cli-smoke.test.ts` contains comprehensive E2E scenarios including full sprint lifecycle

## Mocking Strategies

### No Mocks Needed

- Pure functions like `topologicalSort()`, `validateImportTasks()`
- Schema validation tests
- ID generation tests

### File System (when needed)

- Use temp directories for isolation
- Clean up in `afterEach`

## Coverage Status

### Well Covered

- [x] Store logic (tickets, tasks, sprints, progress)
- [x] CLI commands (comprehensive smoke tests in `cli-smoke.test.ts`)
- [x] Schema validation
- [x] Ticket edit command (CLI E2E tests)
- [x] Error handling and edge cases

### Coverage Gaps

- [ ] Interactive mode menu dispatch (indirect coverage via CLI tests is sufficient)
- [ ] Interactive flows (src/interactive/) - need mock prompts for direct testing
- [ ] Command handlers (src/commands/\*) - partial, mostly via integration tests

## Test Conventions

1. **Descriptive names**: "puts dependencies before dependents" not "test case 2"
2. **Factory functions**: Create test data helpers
3. **Arrange-Act-Assert**: Clear structure in each test
4. **Error messages**: Test that errors contain helpful info
5. **Edge cases**: Empty arrays, cycles, missing data
