/**
 * `ProviderSpawn` that replays the canned {@link DemoTranscript} instead of launching a real AI
 * CLI — the engine behind `ralphctl demo --script`.
 *
 * The point is that everything OUTSIDE the model is real: the chain, the round directories, the
 * contract validation, git, the verify gate, the TUI. Only the session is scripted. Concretely
 * one scripted spawn does exactly what a real headless session does, in the same order:
 *
 *   1. read the prompt off stdin and pull the absolute `<outputDir>/signals.json` path out of it
 *      (the harness embeds that path verbatim — see `render-contract-section.ts`);
 *   2. derive the role + round from that path's `rounds/<N>/<role>/` segments;
 *   3. write the beat's workspace files into the spawn's `cwd`, so the commit leaf has a real
 *      diff and the verify gate has a real file to read;
 *   4. write the `{ schemaVersion, signals }` wrapper the leaf's contract will validate;
 *   5. emit claude-shaped `stream-json` lines on stdout and exit 0.
 *
 * Deliberate omissions:
 *
 *  - **no token usage on the `result` line.** Inventing counts for a session that never called a
 *    model would put fabricated numbers into the run's cost rollup. Absent is not zero, and the
 *    rollup already renders "absent" correctly.
 *  - **argv is ignored** apart from `--model`, which is echoed back on the init line so the TUI
 *    banner shows the model the operator actually configured.
 *
 * Writes are synchronous. The scripted-child builder resolves its script one macrotask after the
 * adapter wrote the prompt to stdin, and stdout / exit follow in that same tick, so the files
 * MUST already be on disk when the beat returns — an async write would race the harness's
 * post-spawn read of `signals.json`. These are fake-session writes, not persisted harness
 * artifacts, so the atomic `WriteFile` port is deliberately not in play here.
 *
 * Pinned to the claude stream shape: `scripted-run.ts` pins the demo sandbox to `claude-code` on
 * every AI row, so exactly one adapter's output format has to be emulated.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { createScriptedChild, type SpawnScript } from '@src/integration/ai/providers/_engine/scripted-spawn.ts';
import { type DemoBeat, type DemoRole, type DemoTranscript, beatFor } from '@src/application/demo/transcript.ts';

/**
 * The harness's per-round output path — `…/rounds/<N>/<generator|evaluator>/signals.json` — as it
 * appears verbatim in the rendered output-contract section.
 *
 * The whole `rounds/<N>/<role>/` tail is part of the pattern on purpose. Both prompt templates
 * ALSO talk about `signals.json` in prose, including the literal `<outputDir>/signals.json` in the
 * evaluate template, and a looser "any path ending in signals.json" match happily locks onto that
 * placeholder and reports a role of `<outputDir>`. Anchoring on the real layout means only a
 * genuine round directory can match. Quotes / backticks / whitespace terminate the path because
 * the prompt renders it inside a backtick span; the `C:\…` spelling is accepted too.
 */
const ROUND_SIGNALS_PATH_RE =
  /(?:[A-Za-z]:)?[\\/][^\s`'"]*[\\/]rounds[\\/](\d+)[\\/](generator|evaluator)[\\/]signals\.json/g;

interface SpawnTarget {
  readonly signalsPath: string;
  readonly role: DemoRole;
  readonly round: number;
}

/**
 * Resolve which beat a prompt is asking for. Returns `undefined` when the prompt names no round
 * output directory — which is how a role the transcript does not script (reproduce, the best-of-N
 * judge) surfaces as a loud non-zero exit rather than a silently wrong beat. The demo settings
 * keep those rungs off; see `scripted-run.ts`.
 *
 * The LAST match wins: the output-contract section is appended after the flow's own prose, so a
 * template that ever cites an earlier round's directory as context cannot redirect the write.
 *
 * @public
 */
export const resolveSpawnTarget = (prompt: string): SpawnTarget | undefined => {
  const matches = [...prompt.matchAll(ROUND_SIGNALS_PATH_RE)];
  const match = matches[matches.length - 1];
  if (match === undefined) return undefined;
  const round = Number.parseInt(match[1] ?? '', 10);
  const role = match[2] as DemoRole;
  return { signalsPath: match[0], role, round: Number.isInteger(round) ? round : 1 };
};

const writeFileAt = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
};

/** Emit the beat's files + `signals.json`. Workspace files are skipped when the spawn has no cwd. */
const applyBeat = (beat: DemoBeat, target: SpawnTarget, cwd: string | undefined): void => {
  for (const file of beat.files) {
    if (cwd === undefined) continue;
    writeFileAt(isAbsolute(file.path) ? file.path : join(cwd, file.path), file.content);
  }
  writeFileAt(
    target.signalsPath,
    `${JSON.stringify({ schemaVersion: beat.schemaVersion, signals: beat.signals }, null, 2)}\n`
  );
};

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * Claude `stream-json` transcript for one scripted session: `system.init` (carries the session
 * id the harness mirrors into `session-id.txt` and resumes with next round), one `assistant`
 * line so the live TUI stream has prose to render, and the terminal `result` line the harness
 * reads the body off.
 */
const streamLines = (beat: DemoBeat, sessionId: string, model: string | undefined): string => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: sessionId, ...(model !== undefined ? { model } : {}) },
    {
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: beat.body }] },
    },
    { type: 'result', subtype: 'success', session_id: sessionId, result: beat.body },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
};

/** One stable session id per role, so a resumed round looks like the same conversation thread. */
const sessionIdFor = (role: DemoRole): string => `demo-scripted-${role}`;

const unscriptedScript = (reason: string): SpawnScript => ({
  stderrChunks: [`ralphctl demo: ${reason}\n`],
  exitCode: 1,
});

/**
 * Build the demo's {@link ProviderSpawn}. Threaded into `launchTui({ providerSpawn })`, which
 * carries it through `wire()` → `AppDeps.providerSpawn` → the per-launch adapter rebuild, so
 * every AI session in the demo run replays the transcript.
 *
 * @public
 */
export const createDemoProviderSpawn = (transcript: DemoTranscript): ProviderSpawn => {
  return (_command, args, options): ChildProcessWithoutNullStreams => {
    let prompt = '';
    return createScriptedChild(
      (): SpawnScript => {
        const target = resolveSpawnTarget(prompt);
        if (target === undefined) {
          return unscriptedScript('this session asked for an output path the demo transcript does not script');
        }
        const beat = beatFor(transcript, target.role, target.round);
        if (beat === undefined) {
          return unscriptedScript(`no scripted beat for ${target.role} round ${String(target.round)}`);
        }
        applyBeat(beat, target, options.cwd);
        return { stdoutChunks: [streamLines(beat, sessionIdFor(target.role), flagValue(args, '--model'))] };
      },
      {
        onStdin: (chunk) => {
          prompt += chunk;
        },
      }
    );
  };
};
