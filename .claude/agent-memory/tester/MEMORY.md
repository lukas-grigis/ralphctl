# Tester Memory

## Test Setup

- **Framework:** vitest
- **Config:** `vitest.config.ts` in project root
- **Location:** Colocated `*.test.ts` files next to source

## Test Files Found

```
src/claude/runner.test.ts       # Claude runner tests
src/integration/cli-smoke.test.ts # CLI smoke tests
src/integration/cli.test.ts     # CLI integration tests
src/schemas/index.test.ts       # Schema validation tests
src/store/progress.test.ts      # Progress store tests
src/store/task.test.ts          # Task store tests (topological sort, validation)
src/store/ticket.test.ts        # Ticket store tests
src/theme/index.test.ts         # Theme tests
src/utils/ids.test.ts           # ID generation tests
```

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

- CLI command execution via `execSync`
- Tests actual command output
- Slower, higher confidence

## Mocking Strategies

### No Mocks Needed

- Pure functions like `topologicalSort()`, `validateImportTasks()`
- Schema validation tests
- ID generation tests

### File System (when needed)

- Use temp directories for isolation
- Clean up in `afterEach`

## Coverage Gaps to Address

- [ ] Command handlers (src/commands/\*) - mostly untested
- [ ] Interactive flows (src/interactive/) - need mock prompts
- [ ] Claude integration (src/claude/) - partial coverage

## Test Conventions

1. **Descriptive names**: "puts dependencies before dependents" not "test case 2"
2. **Factory functions**: Create test data helpers
3. **Arrange-Act-Assert**: Clear structure in each test
4. **Error messages**: Test that errors contain helpful info
5. **Edge cases**: Empty arrays, cycles, missing data
