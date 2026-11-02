/**
 * Unmounts every tree `ink-testing-library` rendered in the test that just finished. Without it a
 * failing assertion skips the trailing `unmount()` and leaks the tree's live spinner / caret
 * intervals into the next test in the file. Registered via the `tui` project's `setupFiles`
 * because `afterEach` called from inside a test body never runs.
 */
import { afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';

afterEach(cleanup);
