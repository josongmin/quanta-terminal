# @quanta/host-common — HostBridge Contract

Shared TypeScript interfaces the UI uses to talk to whatever surface the app
runs in. One package so that every host (Tauri, VS Code, future hosts)
implements the same contract.

## The HostBridge

`HostBridge` is the only thing the UI asks of a host. It must implement:

```ts
interface HostBridge {
  readonly capabilities: HostCapabilities;
  ready(): Promise<void>;
  spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  write(sessionId: SessionId, data: string): Promise<void>;
  resize(sessionId: SessionId, cols: number, rows: number): Promise<void>;
  close(sessionId: SessionId): Promise<void>;
  subscribe(listener: HostEventListener): Subscription;
}
```

Lifecycle invariants (enforced by `bridge-conformance.ts`):

- `subscribe` returns a handle whose `unsubscribe` is idempotent.
- Multiple subscribers fan out; unsubscribing one must not affect others.
- `write`/`resize`/`close` may reject but must never throw synchronously.
- Events follow the Rust `#[serde(tag = "kind", rename_all = "snake_case")]`
  discriminator convention (see `events.ts`).

## Adding a new host

1. Implement a `HostBridge` — usually thin translation between the UI's method
   calls and the host's IPC surface.
2. Decide the `HostCapabilities` flags for your host. `DEFAULT_CAPABILITIES`
   is the "nothing assumed" baseline — opt in where the host supports more
   (native window chrome, editor integration, system notifications).
3. Add a vitest file that runs the conformance suite:

   ```ts
   import { runHostBridgeConformance } from '@quanta/host-common/__tests__/bridge-conformance.js';
   runHostBridgeConformance('MyHost', () => createMyHost());
   ```

4. Call `bootstrapUi({ root, bridge })` from `@quanta/ui` with your bridge.

## Events

Phase-1 hosts surface two families:

- **Core domain events** — `session_created`, `session_cwd_changed`,
  `session_shell_integration_status`, `session_ended`, `input_submitted`.
  These mirror the Rust `Event` enum in `crates/quanta-proto`.
- **Phase-1 host-transport events** — `pty_data`, `pty_exit`. Synthesized by
  the host adapter (Tauri topics, VS Code messaging). Will be replaced by
  `output_chunk` / `block_completed` once the `quanta-core` sidecar ships.

Schema drift between Rust and TypeScript is caught by
`src/__tests__/schema-parity.test.ts`, which scrapes the Rust proto sources
and fails if a snake_case literal is missing from the TS mirrors.

## Testing

```
pnpm --filter @quanta/host-common test
```
