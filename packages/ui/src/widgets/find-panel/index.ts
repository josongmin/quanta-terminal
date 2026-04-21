/**
 * FindPanel barrel — grid-wide find surface (Plan 0005 P1-F).
 *
 * Consumed by:
 *   - pages/terminal-page/TerminalPage.tsx  (mount alongside OutputSearch)
 *   - widgets/terminal-canvas/TerminalCanvas.tsx
 *       (reads `useFindPanelStore().matches` to paint highlights)
 */

export { FindPanel, type FindPanelProps } from './FindPanel.js';
export {
  useFindPanelStore,
  getFindPanelState,
  type FindPanelState,
} from './find-panel-store.js';
