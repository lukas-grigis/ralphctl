/**
 * Add-ticket wizard step machine.
 *
 * `Step` is a discriminated union covering the full lifecycle:
 *   link → (fetching → title prefilled OR fetch-failed → title manual) → description → confirm
 *   then saving → (pop) OR error.
 *
 * `backStep` returns the predecessor step the wizard should land on for Esc-as-back. Returns
 * `undefined` when Esc should cancel the whole view (first step, terminal saving/error states,
 * mid-fetch).
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
    case 'error':
      return undefined;
  }
};
