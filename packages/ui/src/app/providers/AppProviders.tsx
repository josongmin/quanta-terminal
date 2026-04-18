/**
 * AppProviders — wrap the page tree with any top-level providers. Currently
 * empty beyond strict mode; exists so adding Zustand devtools, error
 * boundaries, or theme providers later does not touch the page.
 */

import { StrictMode } from 'react';
import type { ReactNode } from 'react';

export function AppProviders(props: { children: ReactNode }) {
  return <StrictMode>{props.children}</StrictMode>;
}

AppProviders.displayName = 'AppProviders';
