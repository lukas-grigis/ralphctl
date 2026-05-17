/**
 * Re-export the `RunInTerminal` type + passthrough impl. The Ink-aware launcher host that
 * actually pauses the React tree lives in `./ink-host.ts`; tests and the plain-CLI launcher
 * use the passthrough below.
 */
export { type RunInTerminal, passthroughRunInTerminal } from '@src/integration/io/run-in-terminal.ts';
