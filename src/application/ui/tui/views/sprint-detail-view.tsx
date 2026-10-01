/** Sprint detail — the sprint workspace. */

import React from 'react';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useSprintDetailBody } from '@src/application/ui/tui/views/sprint-detail-internals/detail-body.tsx';
import { SprintDetailContent } from '@src/application/ui/tui/views/sprint-detail-internals/detail-content.tsx';

export const SprintDetailView = (): React.JSX.Element => {
  const { subtitle, suppressScrollArrows, feedback, contentProps } = useSprintDetailBody();

  return (
    <ViewShell
      title="Sprint"
      subtitle={subtitle}
      suppressScrollArrows={suppressScrollArrows}
      {...(feedback !== undefined ? { feedback } : {})}
    >
      <SprintDetailContent {...contentProps} />
    </ViewShell>
  );
};
