<examples>

The illustrations below are non-normative — they show good/bad shapes for the rules stated in `plan-common.md`. Use
them as calibration, not templates to copy literally.

## Verification Criteria — good vs bad

> **Good criteria (verifiable, unambiguous):**
>
> - "TypeScript compiles with no errors"
> - "All existing tests pass plus new tests for the added feature"
> - "GET /api/users returns 200 with paginated user list"
> - "GET /api/users?page=-1 returns 400 with validation error"
> - "Component renders without console errors in browser"
> - "Playwright e2e: login flow completes without errors" _(UI tasks with Playwright configured)_

> **Bad criteria (vague, not independently verifiable):**
>
> - "Code is clean and well-structured"
> - "Error handling is appropriate"
> - "Performance is acceptable"

## Dependency Graph — good vs bad

### Good Dependency Graph

```
Task 1: Add shared validation utilities       (no deps)
Task 2: Implement user registration form       (blockedBy: [1])
Task 3: Implement user profile editor          (blockedBy: [1])
Task 4: Add form submission analytics          (blockedBy: [2, 3])
```

Tasks 2 and 3 run in parallel (both depend only on 1). Task 4 waits for both.

### Bad Dependency Graph

```
Task 1: Add validation utilities               (no deps)
Task 2: Implement registration form            (blockedBy: [1])
Task 3: Implement profile editor               (blockedBy: [2])  <-- WRONG
Task 4: Add submission analytics               (blockedBy: [3])  <-- WRONG
```

Task 3 does not actually need Task 2 — it only needs Task 1. This creates a false serial chain that prevents parallel
execution.

## Precise Steps — good vs bad

Bad — vague steps that force the agent to guess:

```json
{
  "name": "Add user authentication",
  "steps": ["Implement auth", "Add tests", "Update docs"]
}
```

Good — precise steps with file paths and pattern references:

```json
{
  "name": "Add user authentication",
  "projectPath": "/Users/dev/my-app",
  "steps": [
    "Create auth service in src/services/auth.ts with login(), logout(), getCurrentUser() — follow the pattern in src/services/user.ts for error handling and return types",
    "Add AuthContext provider in src/contexts/AuthContext.tsx wrapping the app — follow existing ThemeContext pattern",
    "Create useAuth hook in src/hooks/useAuth.ts exposing auth state and actions",
    "Add ProtectedRoute wrapper component in src/components/ProtectedRoute.tsx",
    "Write unit tests in src/services/__tests__/auth.test.ts — follow test patterns in src/services/__tests__/user.test.ts",
    "{{CHECK_GATE_EXAMPLE}}"
  ],
  "verificationCriteria": [
    "TypeScript compiles with no errors",
    "All existing tests pass plus new auth tests",
    "ProtectedRoute redirects unauthenticated users to /login",
    "useAuth hook exposes isAuthenticated, user, login, and logout"
  ]
}
```

</examples>
