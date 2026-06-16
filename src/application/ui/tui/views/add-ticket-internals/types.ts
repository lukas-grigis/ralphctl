/**
 * Add-ticket wizard step machine.
 *
 * `Step` is a discriminated union covering the full lifecycle, which now LOOPS so the user can
 * append several tickets without re-entering the view each time:
 *   link → (fetching → title prefilled OR fetch-failed → title manual) → description → confirm
 *   then saving → added → (YES: back to a fresh `link` for the next ticket) OR (NO: pop)
 *                       OR error.
 *
 * The `added` step is the success branch of a save: it shows a one-line acknowledgement plus the
 * running session count and an "Add another ticket?" confirm. Answering YES resets the machine to
 * `{ kind: 'link' }` (see `AddTicketView`); answering NO pops the view. It carries the just-saved
 * `title` (for the success copy) and the `count` of tickets added this session so far.
 *
 * `backStep` returns the predecessor step the wizard should land on for Esc-as-back. Returns
 * `undefined` when Esc should cancel the whole view (first step, terminal saving/error states,
 * mid-fetch) or when the step is a confirm-driven terminal-ish branch (`added`) whose navigation
 * is owned by its own Yes/No prompt rather than Esc-as-back.
 */

export type Step =
  | { readonly kind: 'link' }
  | { readonly kind: 'fetching'; readonly link: string }
  | { readonly kind: 'fetch-failed'; readonly link: string; readonly reason: string }
  | {
      readonly kind: 'title';
      readonly link: string;
      readonly titleInitial: string;
      readonly descriptionInitial: string;
    }
  | {
      readonly kind: 'description';
      readonly link: string;
      readonly title: string;
      readonly descriptionInitial: string;
    }
  | {
      readonly kind: 'confirm';
      readonly link: string;
      readonly title: string;
      readonly description: string;
    }
  | { readonly kind: 'saving' }
  | { readonly kind: 'added'; readonly title: string; readonly count: number }
  | { readonly kind: 'error'; readonly message: string };

export const backStep = (step: Step): Step | undefined => {
  switch (step.kind) {
    case 'link':
      return undefined;
    case 'fetching':
      // Spinner is short-lived; treat Esc as a hard cancel of the view.
      return undefined;
    case 'fetch-failed':
      return { kind: 'link' };
    case 'title':
      return { kind: 'link' };
    case 'description':
      return {
        kind: 'title',
        link: step.link,
        titleInitial: step.title,
        descriptionInitial: step.descriptionInitial,
      };
    case 'confirm':
      return {
        kind: 'description',
        link: step.link,
        title: step.title,
        descriptionInitial: step.description,
      };
    case 'saving':
    case 'added':
    case 'error':
      return undefined;
  }
};
