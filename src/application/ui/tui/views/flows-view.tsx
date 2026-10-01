/**
 * `flows` route alias — Work with the flow list focused. Kept for one release so Execute's settled
 * `r` and persisted routes keep resolving; remove it next release together with the `flows`
 * registry, nav-tree and nav-label entries.
 */

import React from 'react';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';

export const FlowsAliasView = (): React.JSX.Element => <HomeView focus="flows" />;
