/**
 * Row-resync request / response types. The actual transport is bridge-level
 * (UI → host over the same RPC channel that carries other control messages);
 * this file ships the typed carrier so tests and callers can speak the same
 * shape. See plan §5.
 */

import type { RowDelta } from './types.js';

export interface ResyncRowRequest {
  readonly session_id: string;
  readonly grid_epoch: number;
  readonly resize_generation: number;
  readonly row: number;
}

export type ReplayFailedReason =
  | 'epoch_changed'
  | 'resize_generation_changed'
  | 'row_out_of_range'
  | 'session_gone';

export type ResyncRowResponse =
  | {
      readonly status: 'ok';
      readonly grid_epoch: number;
      readonly resize_generation: number;
      readonly sequence_no: number;
      readonly row_delta: RowDelta;
    }
  | {
      readonly status: 'replay_failed';
      readonly reason: ReplayFailedReason;
      readonly current_epoch: number;
      readonly current_resize_generation: number;
    };

/**
 * Placeholder transport. EPIC-F wires the real bridge; until then this is a
 * direct-invocation shim that unit tests can hand a response to. Kept as a
 * minimal function shape so it round-trips to the real bridge without
 * consumer changes.
 */
export type ResyncRowTransport = (req: ResyncRowRequest) => Promise<ResyncRowResponse>;

/** A stub transport that resolves `replay_failed` immediately — tests can
 *  replace this with whatever behavior they want to simulate. */
export function createStubTransport(): ResyncRowTransport {
  return async (_req: ResyncRowRequest): Promise<ResyncRowResponse> => ({
    status: 'replay_failed',
    reason: 'session_gone',
    current_epoch: 0,
    current_resize_generation: 0,
  });
}
