/** Add-ticket wizard step machine. */

export interface TicketDraft {
  readonly title: string;
  readonly description: string;
  readonly link: string;
  readonly createTrackerIssue?: boolean;
}

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
  | {
      readonly kind: 'ask-create';
      readonly link: string;
      readonly title: string;
      readonly description: string;
    }
  | { readonly kind: 'saving' }
  | { readonly kind: 'added'; readonly title: string; readonly count: number }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'create-failed';
      readonly message: string;
      /** What happened to the local ticket and how to recover — see `persistTicket`. */
      readonly hint: string;
    };

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
    case 'ask-create':
      return {
        kind: 'confirm',
        link: step.link,
        title: step.title,
        description: step.description,
      };
    case 'saving':
    case 'added':
    case 'error':
    case 'create-failed':
      return undefined;
  }
};
