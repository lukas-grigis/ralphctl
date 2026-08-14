/**
 * Live proof that the prompt POINTER actually works against the real CLIs.
 *
 * The pointer (`prompt-pointer.ts`) replaced an inlined prompt body to stop `spawn ENAMETOOLONG` on
 * Windows. It is natural-language prose naming a file path, not a native `--prompt-file` flag, so
 * two things have to hold that the fake-spawn unit tests cannot check:
 *
 *   1. DELIVERY — the CLI receives the pointer and is actually permitted to READ that path. Every
 *      adapter grants the prompt file's directory and nothing wider (`--add-dir` for claude /
 *      copilot / codex, an `external_directory` config grant for OpenCode). A grant that silently
 *      fails to match opens a session whose only instruction is a path it cannot open.
 *   2. COMPLIANCE — the model obeys "read that file first, before any other action". A model that
 *      answers from the pointer text alone would run a session with no brief at all.
 *
 * The probe puts the prompt file OUTSIDE the working directory on purpose — that is the case the
 * grant exists for, and the case that regresses silently if a flag is dropped. The prompt body asks
 * for a sentinel file containing a token that appears NOWHERE in the pointer, so the sentinel can
 * only exist if the file was genuinely read. Delivery and compliance are reported separately: a
 * session that starts but writes nothing failed compliance, a session that dies on a permission
 * error failed delivery, and the two want different fixes.
 *
 * Usage: pnpm dlx tsx scripts/probe-prompt-pointer.ts [provider ...]
 *   No args probes only `opencode` — the one backend with a zero-auth free tier, so it costs
 *   nothing. The other three spend real quota on the operator's account and are opt-in by name.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildPromptPointer } from '@src/integration/ai/providers/_engine/prompt-pointer.ts';
import { buildOpencodeEnv } from '@src/integration/ai/providers/opencode/interactive.ts';

const SENTINEL = 'ralphctl-pointer-proof.txt';
const TIMEOUT_MS = 180_000;

/** The token lives only in the prompt FILE — never in the pointer — so echoing it proves a read. */
const promptBody = (token: string): string =>
  [
    '# Pointer probe',
    '',
    'Do exactly one thing and then stop:',
    '',
    `Create a file named \`${SENTINEL}\` in the current working directory whose entire contents are`,
    `the single line \`${token}\`.`,
    '',
    'Do not create any other file. Do not ask any questions. When the file exists, you are done.',
  ].join('\n');

type Probe = {
  readonly cli: string;
  readonly args: (ctx: { promptFile: string; pointer: string; cwd: string; promptDir: string }) => readonly string[];
  readonly env?: (ctx: { promptDir: string }) => Readonly<Record<string, string>>;
  /** Interactive TUIs never exit on their own — kill them once the sentinel lands (or we time out). */
  readonly interactive: boolean;
  /**
   * Wrap the spawn in a PTY. Some TUIs refuse to start on a pipe (`stdin is not a terminal`),
   * which the probe would otherwise misreport as a pointer failure. Production spawns these with
   * `stdio: 'inherit'` from a real terminal, so a PTY is the faithful topology, not a workaround.
   */
  readonly pty?: boolean;
};

const PROBES: Readonly<Record<string, Probe>> = {
  // The one HEADLESS path that carries a pointer. claude / codex / opencode headless pipe the
  // prompt over stdin and are untouched by the argv change, so they are not probed here.
  'copilot-headless': {
    cli: 'copilot',
    interactive: false,
    args: ({ pointer, promptDir }) => [`--add-dir=${promptDir}`, '--allow-all-tools', '-p', pointer],
  },
  'claude-interactive': {
    cli: 'claude',
    interactive: true,
    args: ({ pointer, promptDir }) => ['--add-dir', promptDir, '--permission-mode', 'acceptEdits', pointer],
  },
  'codex-interactive': {
    cli: 'codex',
    interactive: true,
    pty: true,
    args: ({ pointer, promptDir, cwd }) => [
      '--cd',
      cwd,
      '--add-dir',
      promptDir,
      '-s',
      'workspace-write',
      '-a',
      'never',
      pointer,
    ],
  },
  'copilot-interactive': {
    cli: 'copilot',
    interactive: true,
    pty: true,
    args: ({ pointer, promptDir }) => [`--add-dir=${promptDir}`, '--allow-all-tools', '-i', pointer],
  },
  'opencode-interactive': {
    cli: 'opencode',
    interactive: true,
    args: ({ pointer, cwd }) => [cwd, '--prompt', pointer],
    // The probe mounts exactly the one root the pointer needs; the adapter passes the engine's
    // full folded list. A refusal here can only mean the probe base path holds a glob
    // metacharacter, which would make the whole run meaningless — so it fails loudly.
    env: ({ promptDir }) => {
      const built = buildOpencodeEnv([promptDir]);
      if (!built.ok) throw new Error(built.error.message);
      return built.value;
    },
  },
};

const run = async (name: string, probe: Probe): Promise<boolean> => {
  // Two SEPARATE temp roots: the prompt file must sit outside cwd, which is exactly the topology
  // the directory grant exists for (ideate and memory-distill run with cwd = the repository).
  // NOT under the system temp dir. Copilot auto-grants the temp directory (it ships a
  // `--disallow-temp-dir` flag to turn that off), so a prompt file in `tmpdir` would be readable
  // whether or not the `--add-dir` grant works — the probe would pass while proving nothing. Every
  // real prompt file lives under the data root, so probe from a comparable ordinary directory.
  const base = process.env['RALPHCTL_PROBE_BASE'] ?? join(homedir(), 'ralphctl-pointer-probe');
  await mkdir(base, { recursive: true });
  // Codex gates every unregistered directory behind an interactive "do you trust this directory?"
  // prompt, which a fresh `mkdtemp` always trips — the session then sits on the question and never
  // reaches the seed prompt, which reads exactly like a pointer failure. Point `RALPHCTL_PROBE_CWD`
  // at a directory Codex already trusts to probe it without answering that prompt by hand.
  const cwd = process.env['RALPHCTL_PROBE_CWD'] ?? (await mkdtemp(join(base, 'work-')));
  const promptDir = await mkdtemp(join(base, 'prompt-'));
  const promptFile = join(promptDir, 'prompt.md');
  const token = `POINTER-OK-${process.hrtime.bigint() % 1_000_000n}`;
  await writeFile(promptFile, promptBody(token), 'utf8');

  const pointer = buildPromptPointer(promptFile);
  const args = [...probe.args({ promptFile, pointer, cwd, promptDir })];
  const env = { ...process.env, ...(probe.env?.({ promptDir }) ?? {}) };

  process.stdout.write(`\n── ${name} ──\n  cwd:        ${cwd}\n  promptFile: ${promptFile}\n`);

  // Allocate a real pty and give the child BOTH ends of it. `script -q /dev/null …` is the usual
  // one-liner for this but requires a tty on its OWN stdin, which a CI runner or an agent harness
  // does not have (`tcgetattr/ioctl: Operation not supported on socket`). Opening the pty directly
  // has no such requirement — the child gets a terminal regardless of what the parent was given.
  const PTY_RUNNER = [
    'import os,pty,sys,select',
    'pid,fd=pty.fork()',
    'if pid==0: os.execvp(sys.argv[1],sys.argv[1:])',
    'out=os.fdopen(1,"wb",0)',
    'try:',
    '  while True:',
    '    r,_,_=select.select([fd],[],[],0.5)',
    '    if fd in r:',
    '      d=os.read(fd,65536)',
    '      if not d: break',
    '      out.write(d)',
    'except OSError: pass',
  ].join('\n');
  const [bin, binArgs] = probe.pty === true ? ['python3', ['-c', PTY_RUNNER, probe.cli, ...args]] : [probe.cli, args];
  // stdin stays an OPEN pipe we never write to. Closing it (`'ignore'`) hands the TUI an immediate
  // EOF, which it reads as the user pressing Ctrl-D and exits before the seed prompt is executed —
  // a probe artifact that looks exactly like the model ignoring the pointer.
  const child = spawn(bin, binArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr.on('data', (c: Buffer) => (output += c.toString()));

  const sentinelPath = join(cwd, SENTINEL);
  const landed = await new Promise<boolean>((resolve) => {
    const deadline = Date.now() + TIMEOUT_MS;
    const poll = setInterval(() => {
      void readFile(sentinelPath, 'utf8').then(
        (body) => {
          if (body.includes(token)) {
            clearInterval(poll);
            child.kill('SIGTERM');
            resolve(true);
          }
        },
        () => {
          if (Date.now() > deadline) {
            clearInterval(poll);
            child.kill('SIGTERM');
            resolve(false);
          }
        }
      );
    }, 1000);
    child.on('exit', () => {
      // A headless run that exited without the sentinel gets one last check for the race.
      if (probe.interactive) return;
      setTimeout(() => {
        void readFile(sentinelPath, 'utf8').then(
          (body) => {
            clearInterval(poll);
            resolve(body.includes(token));
          },
          () => {
            clearInterval(poll);
            resolve(false);
          }
        );
      }, 500);
    });
  });

  // Distinguish the two failure modes: a refused read is a DELIVERY bug (grant/flag), while a clean
  // session that simply never wrote the file is a COMPLIANCE bug (the model ignored the pointer).
  const refused = /permission|not allowed|denied|EACCES|no such file|cannot read|outside/i.test(output);
  if (landed) process.stdout.write(`  RESULT: PASS — file was read and obeyed (${token})\n`);
  else if (refused) process.stdout.write(`  RESULT: FAIL (delivery) — CLI could not read the prompt file\n`);
  else process.stdout.write(`  RESULT: FAIL (compliance) — session ran but never wrote the sentinel\n`);
  if (!landed) process.stdout.write(`  --- output tail ---\n${output.slice(-1500)}\n`);
  return landed;
};

const requested = process.argv.slice(2);
const selected = requested.length > 0 ? requested : ['opencode-interactive'];
const results: Array<readonly [string, boolean]> = [];
for (const name of selected) {
  const probe = PROBES[name];
  if (probe === undefined) {
    process.stdout.write(`unknown probe '${name}'. known: ${Object.keys(PROBES).join(', ')}\n`);
    continue;
  }
  results.push([name, await run(name, probe)]);
}

process.stdout.write('\n═══ summary ═══\n');
for (const [name, ok] of results) process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
