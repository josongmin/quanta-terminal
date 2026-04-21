/**
 * Public surface of `widgets/run-overlay` — Plan 0005 P2-E.
 *
 * Exposes `<AgentRunCard />`. If/when the P1-C `BlockOverlay` widget
 * grows agent-Run awareness, it will re-export this card alongside its
 * shell-Run chrome.
 */

export { AgentRunCard } from './AgentRunCard.js';
export type { AgentRunCardProps } from './AgentRunCard.js';
