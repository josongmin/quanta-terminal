# Epic β — Single input path (SessionInputSurface)

- **Plan**: [0005 SOTA Convergence](./README.md)
- **Phase**: P0
- **Depends on**: Epic α (VT engine + alt-buffer) for live mode reads
- **Sibling**: Epic γ (write-batcher), Epic δ (P0 default gating)

---

## Goal

Every byte entering the PTY comes from `input-host`. The composer textarea is no longer the canonical byte path; the `SessionInputSurface` DOM element is. Works for block UI, works for TUI, works for plain-grid P0 default.

> Invariant I-12: One input path. CI grep rule `one-input-path` rejects any `bridge.write` / `connection.write` call that doesn't originate from `features/input/`.

---

## Out-of-scope split

- **Intent layer** (v3 P2-B) — `Intent` router above `SessionInputSurface` that gives meaning to user actions. Not shipped in P0.
- **AI hooks** — also P2.
- **Mode-stack awareness** (v3 P1-D) — pager hint / REPL policy / tmux depth resolution. P1.

In P0, `SessionInputSurface` is a dumb byte sink. That is the only requirement.

---

## Architectural shift

### Before (current default path)

```
┌──────────────────────────────────────────┐
│ Composer (<textarea>)                    │
│  value state owned by React              │
│  Enter → submitCommand({ text })         │
│          └─ bridge.write(text + '\n')   │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ TuiInputSurface (alt-screen-gated only)  │
│  input-host → encoder → bridge.write     │
└──────────────────────────────────────────┘
```

### After (P0)

```
┌──────────────────────────────────────────┐
│ SessionInputSurface (always mounted)     │
│  full chrome coverage                    │
│  input-host → encoder → bridge.write     │
│                                          │
│  Reads terminal mode live from           │
│  VtEmulator (via ModeSnapshot adapter).  │
└──────────────────────────────────────────┘

[Composer exists only when P1 flag.blockUx is on;
 its "submit" becomes: synthesize keystrokes via encoder,
 never calls bridge.write directly.]
```

---

## Component spec

### `SessionInputSurface.tsx`

```tsx
interface SessionInputSurfaceProps {
  readonly sessionId: SessionId;
  readonly bridge?: HostBridge;            // override for tests
  /** Engine instance for live mode reads; null during startup. */
  readonly engine: VtEngineHandle | null;
  /** Keymap guard for UI-level shortcuts (Cmd+K etc.) */
  readonly keymapGuard?: (ev: KeyboardEvent) => boolean;
}
```

Renders:

```tsx
<div
  ref={rootRef}
  className={styles.root}
  tabIndex={0}
  role="application"
  aria-label={t('terminal.input.ariaLabel')}
  data-testid="session-input-surface"
/>
```

Lifecycle:

1. On mount: call `mount(rootRef.current, { keyEncoder, mouseEncoder, paste, focus, onBytesOut, onPasteGate, ...})` from `features/input/input-host.ts`. Returns a `InputHostHandle`.
2. `onBytesOut` dispatches to `sessionConnection.write(bytes)` (which itself goes through the degraded gate).
3. On keydown before the encoder path: run `keymapGuard`. If it returns `true`, event is UI-owned; don't encode. Else, encoder handles.
4. On unmount: call `handle.dispose()`.

`ModeSnapshot` adapter:

```ts
function createEngineModeSnapshot(engine: VtEngineHandle | null): ModeSnapshot {
  return {
    bracketedPaste: () => engine?.getMode('bracketedPaste') ?? false,
    mouseTracking: () => engine?.getMode('mouseTracking') ?? 'off',
    decckm: () => engine?.getMode('decckm') ?? false,
    kittyKeyboard: () => engine?.getMode('kittyKeyboard') ?? 0,
  };
}
```

`engine` exposes `getMode(name)` reading directly from its internal mode state. Always live — no React re-render needed since encoders call it on each event.

### KeymapGuard (simple, P0)

```ts
const P0_UI_SHORTCUTS: readonly KeyPattern[] = [
  { key: 'k', mods: ['mod'] },       // palette
  { key: 't', mods: ['mod'] },       // new tab
  { key: 'w', mods: ['mod'] },       // close tab
  { key: 'd', mods: ['mod'] },       // split
  { key: 'D', mods: ['mod', 'shift'] },
  { key: '\\', mods: ['mod'] },      // focus cycle
  { key: '=', mods: ['mod'] },       // zoom in
  { key: '-', mods: ['mod'] },       // zoom out
  { key: '0', mods: ['mod'] },       // zoom reset
  { key: ',', mods: ['mod'] },       // settings
];

function defaultKeymapGuard(ev: KeyboardEvent): boolean {
  for (const pat of P0_UI_SHORTCUTS) {
    if (matchPattern(ev, pat)) return true; // UI claimed it
  }
  return false; // encoder handles
}
```

Conservative: only the shortcuts we bind at the React app layer are claimed. Everything else — Ctrl+C, Ctrl+R, Cmd+V (paste, which the encoder's Paste path handles), arrows, function keys — goes through the encoder.

**Cmd+V nuance**: don't claim `Cmd+V` as UI — let the Paste encoder handle it because bracketed paste + paste-safety gate run inside Paste.

### Paste safety

Already implemented in `features/paste-safety/`. Wire to `input-host`'s `onPasteGate` prop:

```ts
const pasteGate = useCallback(async (text: string) => {
  const analysis = analyzePaste(text);
  if (!needsConfirmation(analysis)) return true;
  return await showPasteConfirmDialog(text, analysis);  // returns boolean
}, []);
```

`PasteConfirmDialog` renders via a portal; user confirms/cancels; dialog resolves the promise.

### IME

Reuse the existing `ImeStateMachine`. The state machine is already bound inside `input-host.ts`. No changes needed — just needs to be mounted.

### Focus policy

- On session-active: `SessionInputSurface.focus()` called in a `useEffect`. If the page is loading / the user clicks into another surface (settings panel, palette), focus yields. On dismiss of those surfaces: refocus session surface.
- Visual: no ring, no outline (terminal aesthetic). Custom `:focus-visible` styling optional.

### Test harness hooks

- `data-testid="session-input-surface"` — standard target.
- Event dispatching in tests via `fireEvent.keyDown(container, { key: 'c', ctrlKey: true })` — the event bubbles through the encoder just like production.

---

## Composer fate in P0

**P0 default (`flag.blockUx === false`)**: Composer is NOT rendered. No React textarea in the tree.

**P1 (`flag.blockUx === true`)**: Composer renders as a line-editor overlay. When user types inside it:

- Characters typed in the textarea are mirrored as keystrokes via `input-host.synthesize({ key, mods })`.
- Enter key: composer's current value is sent as `bracketPastePayload(value) + encodeKey('Enter')` through the encoder. Shell sees a paste followed by Enter — identical to typing the whole line and pressing Enter.

In P0 none of that exists. Composer is simply unmounted.

---

## Migration from `TuiInputSurface`

`TuiInputSurface` deletion checklist:

1. Rename file → `SessionInputSurface.tsx`.
2. Drop the alt-screen mount gate; component is always rendered when a session is active.
3. Update `ModeSnapshot` source: was the `createStubMirror()` placeholder; becomes the engine-backed mode snapshot.
4. Update container CSS: full-chrome coverage instead of alt-screen-only positioning.
5. Update `TerminalPage.tsx` to mount `SessionInputSurface` at the main terminal region, remove the `altScreen.active` guard.
6. Delete `TuiInputSurface.tsx` once everything points at `SessionInputSurface`.
7. Existing tests under `features/tui/__tests__/TuiInputSurface.test.tsx` — rewrite for the new surface's always-on semantics.
8. Existing tests under `features/tui/__tests__/tui-integration.test.tsx` — convert to test the `SessionInputSurface` equivalent flows.

---

## Exit gates (from Plan 0005 §4.β)

- **E-β-01** bash: `Ctrl+R` opens reverse-i-search; typing narrows; ESC exits.
- **E-β-02** zsh: Tab completion lists files.
- **E-β-03** `Ctrl+C` interrupts running command in < 50 ms.
- **E-β-04** `Ctrl+Z` suspends; `fg` resumes.
- **E-β-05** Korean 2-set IME: recorded corpus byte-identical on block vs alt-screen entry.
- **E-β-06** Paste > 10 KB with newline triggers paste-safety dialog.
- **E-β-07** Mouse click on pre-vim grid emits 1000/1006 report.
- **E-β-08** CI grep rule `one-input-path` passes.

Each gate has at least one test in `__tests__/integration/` or `__tests__/compat/`.

---

## Risks

- **R-β-1 (high)** — IME users typing into a non-textarea surface may hit browser-specific quirks. Mitigation: `input-host` already uses a contenteditable-style hidden input for IME preedit. Recorded corpora pass in existing `TuiInputSurface` tests.
- **R-β-2 (med)** — `Cmd+V` routing ambiguity between keymap guard and Paste encoder. Mitigation: explicit policy — Paste encoder always wins for `Cmd/Ctrl+V` regardless of guard.
- **R-β-3 (low)** — focus competition with palette / settings / toast. Mitigation: refocus chain already established in TuiInputSurface; inherit.

---

## Implementation order (internal to Epic β)

1. Draft `SessionInputSurface.tsx` by renaming + generalizing `TuiInputSurface.tsx`.
2. Wire `createEngineModeSnapshot` adapter (needs engine exposure — coordinate with α1).
3. Mount in `TerminalPage.tsx`; remove alt-screen gate.
4. Keymap guard impl.
5. Paste safety wiring.
6. Migrate TuiInputSurface tests to SessionInputSurface test suite.
7. Delete `TuiInputSurface.tsx` + `TuiRenderSurface.tsx` after confirming no references.
8. Add `one-input-path` CI grep rule.

---

## Files

**Rewrite / rename:**
```
packages/ui/src/features/tui/TuiInputSurface.tsx → packages/ui/src/features/session/SessionInputSurface.tsx
packages/ui/src/features/tui/tui-input-surface.module.css → session-input-surface.module.css
packages/ui/src/pages/terminal-page/TerminalPage.tsx (mount site)
```

**Update:**
```
packages/ui/src/features/input/ModeSnapshot.ts (accept engine-backed source)
packages/ui/src/features/paste-safety/PasteConfirmDialog.tsx (portal wiring if needed)
```

**New:**
```
packages/ui/src/features/session/KeymapGuard.ts (UI shortcut registry)
packages/ui/src/features/session/__tests__/SessionInputSurface.test.tsx
packages/ui/src/__tests__/integration/always-on-input.test.tsx
tools/check-one-input-path/  (CI grep rule)
```

**Delete (after migration):**
```
packages/ui/src/features/tui/TuiInputSurface.tsx
packages/ui/src/features/tui/__tests__/TuiInputSurface.test.tsx (rewrite)
packages/ui/src/features/tui/__tests__/tui-integration.test.tsx (rewrite)
```
