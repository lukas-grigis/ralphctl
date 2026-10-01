/** `flows` route alias — Work with the flow list focused. */

import React from 'react';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';

export const FlowsAliasView = (): React.JSX.Element => <HomeView focus="flows" />;
