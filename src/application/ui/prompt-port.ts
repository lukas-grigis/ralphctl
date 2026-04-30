/**
 * PromptPort re-export for application layer consumers.
 *
 * The canonical definition lives in `business/ports/prompt-port.ts` so
 * both `integration/` and `application/` can import it without violating
 * the architectural fence. Application consumers import from here.
 */
export type {
  PromptPort,
  PromptChoice,
  SelectOptions,
  ConfirmOptions,
  InputOptions,
  CheckboxOptions,
  EditorOptions,
  FileBrowserOptions,
} from '../../business/ports/prompt-port.ts';

export { PromptCancelledError } from '../../business/ports/prompt-port.ts';
