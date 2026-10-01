/**
 * Test helpers for the title channel `ViewShell` publishes into. A view rendered on its own (no
 * app `Layout`) has no location line above it, so these stand in for it: `PublishedTitle` prints
 * what the view announced, and `WithLocation` mounts the real `LocationBar` next to the view.
 */

import React from 'react';
import { Text } from 'ink';
import { LocationBar } from '@src/application/ui/tui/components/location-bar.tsx';
import { ViewTitleProvider, useViewTitle } from '@src/application/ui/tui/runtime/view-title-context.tsx';

/** `title:<t> subtitle:<s>` for whatever the mounted view published. */
export const PublishedTitle = (): React.JSX.Element => {
  const v = useViewTitle();
  return <Text>{`title:${v?.title ?? '(none)'} subtitle:${v?.subtitle ?? '(none)'}`}</Text>;
};

/** Wraps `children` with a title channel and prints the published title above them. */
export const WithPublishedTitle = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <ViewTitleProvider>
    <PublishedTitle />
    {children}
  </ViewTitleProvider>
);

/** Wraps `children` with a title channel and the real location line above them. */
export const WithLocation = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <ViewTitleProvider>
    <LocationBar />
    {children}
  </ViewTitleProvider>
);
