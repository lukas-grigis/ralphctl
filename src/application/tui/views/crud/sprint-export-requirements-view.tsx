/**
 * SprintExportRequirementsView — write the current sprint's refined
 * requirements to a markdown file.
 *
 * Prompts the user for the output path (default: cwd / `<sprintId>-requirements.md`),
 * runs `ExportRequirementsUseCase`, and shows a ResultCard with the path
 * + byte count on success.
 */

import React, { useEffect } from 'react';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { useInput } from 'ink';

import { ViewShell } from '../../components/view-shell.tsx';
import { Spinner } from '../../components/spinner.tsx';
import { ResultCard } from '../../components/result-card.tsx';
import { useViewHints } from '../view-hints-context.tsx';
import { useRouter } from '../router-context.ts';
import { useWorkflow } from '../../components/use-workflow.ts';
import { promptOrPop } from '../../components/prompt-or-pop.ts';
import { getSharedDeps, getPrompt } from '../../../bootstrap/get-shared-deps.ts';
import { ExportRequirementsUseCase } from '../../../../business/usecases/sprint/export-requirements.ts';
import { AbsolutePath } from '../../../../domain/values/absolute-path.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

interface Outcome {
  readonly path: string;
  readonly byteCount: number;
}

export function SprintExportRequirementsView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Outcome>();

  useEffect(() => {
    run('Exporting requirements…', async (setStep) => {
      const deps = await getSharedDeps();

      setStep('Loading current sprint…');
      const cfg = await deps.configStore.load();
      if (!cfg.ok) throw new Error(cfg.error.message);
      const sprintId = cfg.value.currentSprint;
      if (sprintId === null) throw new Error('No current sprint set.');

      const defaultName = `${String(sprintId)}-requirements.md`;
      const defaultPath = resolve(process.cwd(), defaultName);

      setStep('Awaiting output path…');
      const prompt = await getPrompt();
      const raw = await promptOrPop(router, () => prompt.input({ message: 'Output path', default: defaultPath }));
      const trimmed = raw.trim();
      const finalPath =
        trimmed.length === 0 ? defaultPath : isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);

      setStep('Writing file…');
      const uc = new ExportRequirementsUseCase(deps.sprintRepo, (p, b) => writeFile(p, b, 'utf-8'));
      const result = await uc.execute({
        sprintId,
        outputPath: AbsolutePath.trustString(finalPath),
      });
      if (!result.ok) throw new Error(result.error.message);

      return { path: String(result.value.path), byteCount: result.value.byteCount };
    });
  }, [run, router]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="EXPORT REQUIREMENTS">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to export requirements"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Requirements exported!"
          fields={[
            ['Path', phase.value.path],
            ['Bytes', String(phase.value.byteCount)],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
