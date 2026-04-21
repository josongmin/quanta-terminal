/**
 * Session profile store — named templates for a shell + cwd + env combination.
 *
 * Rationale
 * ---------
 * Power users want to spawn a shell with a non-default binary (fish instead of
 * zsh), a fixed working directory ("~/work/quanta") and/or additional env
 * vars (e.g. `KUBECONFIG`) WITHOUT typing the flags every time. A session
 * profile captures that combination under a user-chosen name and is consumed
 * by `features/session-tabs.createSession` via the `profile` option.
 *
 * Data model
 * ----------
 * - Normalized: `order` is the visual order in the settings UI; `entities` is
 *   the id → SessionProfile map; `defaultId` points at the profile that Cmd+T
 *   uses when the caller doesn't specify one explicitly.
 * - `shell` is typed as one of the three common POSIX shells OR any arbitrary
 *   absolute path — users may set "/usr/local/bin/nu" or similar. We do not
 *   validate the path; a bad shell rejects at spawn time and surfaces via the
 *   existing error banner.
 * - `cwd` and `env` are optional; when omitted the host default applies.
 *
 * Persistence
 * -----------
 * The profile table is long-lived configuration — unlike the session
 * collection (which is strictly per-launch) — so it IS persisted to
 * localStorage under `quanta:session-profiles`. A malformed or missing
 * localStorage blob falls back to a single built-in "Default" profile that
 * uses the host-default shell (no fields set). See `readStored` below.
 *
 * The store is created via `zustand/create` rather than
 * `zustand/middleware/persist` because:
 *   1. we need tight control over the shape we serialize (discard derived
 *      state, sanitize env keys), and
 *   2. our tests already use a hand-rolled localStorage shim and we want to
 *      keep the read/write path explicit and easy to audit.
 */

import { create } from 'zustand';

/** localStorage key. Versioned so a future shape break can nuke v1 blobs. */
export const SESSION_PROFILES_STORAGE_KEY = 'quanta:session-profiles:v1';

/**
 * The three common POSIX shells we offer as a quick-pick in the UI. `custom`
 * signals that the stored `shell` string is an arbitrary absolute path the
 * user typed; we keep it for the UI to decide whether to render a select vs a
 * text input.
 */
export type SessionProfileShellKind = 'zsh' | 'bash' | 'fish' | 'custom';

export interface SessionProfile {
  readonly id: string;
  readonly name: string;
  /**
   * Absolute path to the shell binary. Stored verbatim; the UI derives the
   * `kind` (zsh/bash/fish/custom) by comparing against the three known paths
   * so switching between them in the settings form is lossless.
   */
  readonly shell: string;
  /**
   * Optional working directory override. Host default applies when omitted.
   * Identical in semantics to `startupCwd` — kept under `cwd` for legacy
   * storage compatibility.
   */
  readonly cwd?: string;
  /**
   * Additive startup env vars merged on top of the host default. Keys must
   * match {@link ENV_KEY_PATTERN} and the map is capped at
   * {@link MAX_STARTUP_ENV_ENTRIES} entries — both invariants enforced by
   * {@link sanitizeStartupEnv}.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Commands typed into the shell automatically once it reports `ready`.
   * Each entry is delivered verbatim with a trailing `\n` through the
   * normal submit path so the user sees them in their command history.
   * Applied on first session creation from the profile only — restart /
   * reconnect does NOT replay them.
   */
  readonly startupCommands?: readonly string[];
}

/**
 * POSIX env var name regex. Matches a leading letter/underscore followed by
 * zero or more letter/digit/underscore characters. Lowercase is allowed by
 * POSIX but conventionally env var names are uppercase — we upper-case the
 * pattern here so the settings UI nudges users toward the convention;
 * mixed-case values are simply rejected at validation time (UI shows
 * an inline error; runtime sanitization drops them).
 */
export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

/** Upper bound on the number of startup env vars per profile. */
export const MAX_STARTUP_ENV_ENTRIES = 64;

/** True iff `key` is a valid POSIX-style env var name. */
export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

/**
 * Validate-and-normalize an env map: drop entries whose key fails the POSIX
 * regex, coerce values to string, truncate the map to at most
 * {@link MAX_STARTUP_ENV_ENTRIES} entries. Empty-string values are allowed
 * (they explicitly unset the variable downstream).
 */
export function sanitizeStartupEnv(
  input: Readonly<Record<string, unknown>> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  let count = 0;
  for (const [k, v] of Object.entries(input)) {
    if (count >= MAX_STARTUP_ENV_ENTRIES) break;
    if (typeof k !== 'string' || !isValidEnvKey(k)) continue;
    if (typeof v !== 'string') continue;
    out[k] = v;
    count += 1;
  }
  return out;
}

/** Known shell path constants — these back the select options in Settings. */
export const SHELL_PATHS = {
  zsh: '/bin/zsh',
  bash: '/bin/bash',
  fish: '/bin/fish',
} as const;

/**
 * Reverse-lookup: map a concrete path to its `kind`. Anything that doesn't
 * match one of the three known paths is `custom`. Used by the settings form
 * to keep the shell select + custom-path input in sync.
 */
export function kindForShellPath(path: string): SessionProfileShellKind {
  if (path === SHELL_PATHS.zsh) return 'zsh';
  if (path === SHELL_PATHS.bash) return 'bash';
  if (path === SHELL_PATHS.fish) return 'fish';
  return 'custom';
}

export interface SessionProfileSeed {
  readonly name: string;
  readonly shell: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly startupCommands?: readonly string[];
}

export interface SessionProfilesState {
  readonly order: readonly string[];
  readonly entities: Readonly<Record<string, SessionProfile>>;
  readonly defaultId: string;
}

export interface SessionProfilesActions {
  /** Create a new profile; returns its id. */
  addProfile(seed: SessionProfileSeed): string;
  /**
   * Patch an existing profile. Unknown id is a no-op. `undefined` fields in
   * the patch are ignored (shallow merge); pass an empty string for `cwd` or
   * an empty object for `env` to clear them.
   */
  updateProfile(id: string, patch: Partial<SessionProfileSeed>): void;
  /**
   * Remove a profile. If the removed profile was the default, the first
   * remaining profile becomes the new default. If it was the ONLY profile,
   * a fresh built-in "Default" profile is re-seeded so `defaultId` always
   * points at a valid entity.
   */
  removeProfile(id: string): void;
  /** Change which profile is used when the caller doesn't specify one. */
  setDefault(id: string): void;
  /** Test helper — wipe everything and re-seed the built-in default. */
  reset(): void;
}

const BUILT_IN_DEFAULT_ID = 'default';

function builtInDefault(): SessionProfile {
  return {
    id: BUILT_IN_DEFAULT_ID,
    name: 'Default',
    // Empty string means "host default"; matches the SpawnSessionOptions
    // contract (shell is optional, host default applies when omitted).
    shell: '',
  };
}

function freshInitial(): SessionProfilesState {
  const def = builtInDefault();
  return {
    order: [def.id],
    entities: { [def.id]: def },
    defaultId: def.id,
  };
}

// ----------------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------------

interface StoredShape {
  readonly order: readonly string[];
  readonly entities: Readonly<Record<string, SessionProfile>>;
  readonly defaultId: string;
}

/**
 * Read the stored session-profile table from localStorage. Returns a fresh
 * initial state on any failure (missing key, bad JSON, shape mismatch) so
 * callers never see a half-populated store.
 */
export function readStored(
  getItem?: (key: string) => string | null,
): SessionProfilesState {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return freshInitial();
  let raw: string | null;
  try {
    raw = get(SESSION_PROFILES_STORAGE_KEY);
  } catch {
    return freshInitial();
  }
  if (raw === null) return freshInitial();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape>;
    if (
      !parsed ||
      !Array.isArray(parsed.order) ||
      typeof parsed.entities !== 'object' ||
      parsed.entities === null ||
      typeof parsed.defaultId !== 'string'
    ) {
      return freshInitial();
    }
    // Filter order to ids that exist in entities, and vice versa — guards
    // against hand-edited localStorage.
    const entities: Record<string, SessionProfile> = {};
    for (const [id, val] of Object.entries(parsed.entities)) {
      if (!val || typeof val !== 'object') continue;
      const v = val as Partial<SessionProfile>;
      if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.shell !== 'string') {
        continue;
      }
      // Forward-compat: older serialized blobs predate `startupCommands`
      // (they carry only shell/cwd/env). Missing or malformed new fields
      // hydrate to the empty defaults rather than rejecting the whole row,
      // so a user's existing profile table survives a package upgrade.
      const env = v.env && typeof v.env === 'object' ? sanitizeStartupEnv(v.env) : undefined;
      const startupCommands = Array.isArray(
        (v as { startupCommands?: unknown }).startupCommands,
      )
        ? sanitizeStartupCommands(
            (v as { startupCommands?: unknown }).startupCommands as unknown[],
          )
        : undefined;
      const profile: SessionProfile = {
        id: v.id,
        name: v.name,
        shell: v.shell,
        ...(typeof v.cwd === 'string' && v.cwd.length > 0 ? { cwd: v.cwd } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
        ...(startupCommands && startupCommands.length > 0 ? { startupCommands } : {}),
      };
      entities[id] = profile;
    }
    const order = parsed.order.filter((id): id is string => typeof id === 'string' && id in entities);
    if (order.length === 0) return freshInitial();
    const defaultId = order.includes(parsed.defaultId) ? parsed.defaultId : (order[0] as string);
    return { order, entities, defaultId };
  } catch {
    return freshInitial();
  }
}

/**
 * Normalize a candidate startup-command list read from storage: drop
 * non-string entries, strip trailing CR from each line, discard blank lines
 * after trimming. We keep the order the user typed — running commands
 * out-of-order on boot would be astonishing.
 *
 * Bug 3 fix: also filter out commands containing null bytes (which break the
 * PTY line discipline) and strip other ASCII control characters (0x01–0x1f,
 * 0x7f) from the text. Newlines (0x0a) are preserved because multi-line
 * commands are valid.
 */
function sanitizeStartupCommands(input: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    // Drop any command that contains a null byte — it corrupts the PTY.
    if (entry.includes('\x00')) continue;
    const stripped = entry
      // Strip all ASCII control chars except \n (0x0a) — keep newlines for
      // multi-line commands. Covers 0x01–0x09, 0x0b–0x1f, 0x7f.
      .replace(/[\x01-\x09\x0b-\x1f\x7f]/gu, '');
    const trimmed = stripped.replace(/\r$/u, '').trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function writeStored(next: SessionProfilesState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: StoredShape = {
      order: next.order,
      entities: next.entities,
      defaultId: next.defaultId,
    };
    localStorage.setItem(SESSION_PROFILES_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private-mode Safari / storage full: swallow.
  }
}

// ----------------------------------------------------------------------------
// Store
// ----------------------------------------------------------------------------

function genId(): string {
  // Not cryptographically strong — the id just has to be unique within the
  // local profile table. Collisions on the first 9 chars are vanishingly
  // unlikely for a handful of user-created profiles.
  return (
    'prof_' +
    Math.random().toString(36).slice(2, 11) +
    '_' +
    Date.now().toString(36)
  );
}

export const useSessionProfiles = create<SessionProfilesState & SessionProfilesActions>(
  (set) => {
    const initial = readStored();
    return {
      ...initial,

      addProfile: (seed) => {
        const id = genId();
        const env = seed.env ? sanitizeStartupEnv(seed.env) : undefined;
        const startupCommands = seed.startupCommands
          ? sanitizeStartupCommands(seed.startupCommands)
          : undefined;
        const profile: SessionProfile = {
          id,
          name: seed.name,
          shell: seed.shell,
          ...(seed.cwd !== undefined && seed.cwd.length > 0 ? { cwd: seed.cwd } : {}),
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
          ...(startupCommands && startupCommands.length > 0 ? { startupCommands } : {}),
        };
        set((prev) => {
          const next: SessionProfilesState = {
            order: [...prev.order, id],
            entities: { ...prev.entities, [id]: profile },
            defaultId: prev.defaultId,
          };
          writeStored(next);
          return next;
        });
        return id;
      },

      updateProfile: (id, patch) => {
        set((prev) => {
          const existing = prev.entities[id];
          if (!existing) return prev;
          const merged: SessionProfile = {
            id,
            name: patch.name ?? existing.name,
            shell: patch.shell ?? existing.shell,
            ...resolveCwd(existing.cwd, patch.cwd),
            ...resolveEnv(existing.env, patch.env),
            ...resolveStartupCommands(existing.startupCommands, patch.startupCommands),
          };
          const next: SessionProfilesState = {
            ...prev,
            entities: { ...prev.entities, [id]: merged },
          };
          writeStored(next);
          return next;
        });
      },

      removeProfile: (id) => {
        set((prev) => {
          if (!prev.entities[id]) return prev;
          const nextOrder = prev.order.filter((x) => x !== id);
          const nextEntities = { ...prev.entities };
          delete nextEntities[id];
          if (nextOrder.length === 0) {
            // Never end up with an empty table — re-seed the built-in default.
            const seeded = freshInitial();
            writeStored(seeded);
            return seeded;
          }
          const nextDefault =
            prev.defaultId === id ? (nextOrder[0] as string) : prev.defaultId;
          const next: SessionProfilesState = {
            order: nextOrder,
            entities: nextEntities,
            defaultId: nextDefault,
          };
          writeStored(next);
          return next;
        });
      },

      setDefault: (id) => {
        set((prev) => {
          if (!prev.entities[id]) return prev;
          if (prev.defaultId === id) return prev;
          const next: SessionProfilesState = { ...prev, defaultId: id };
          writeStored(next);
          return next;
        });
      },

      reset: () => {
        const seeded = freshInitial();
        writeStored(seeded);
        set(() => seeded);
      },
    };
  },
);

/** Convenience: pull the `SessionProfile` used as the active default. */
export function getDefaultSessionProfile(): SessionProfile {
  const s = useSessionProfiles.getState();
  const profile = s.entities[s.defaultId];
  if (profile) return profile;
  // Defensive: state invariants guarantee defaultId is valid. If we ever
  // get here, fall back to a synthesized built-in.
  return builtInDefault();
}

/** Convenience: look up a profile by id, returning `undefined` if unknown. */
export function getSessionProfile(id: string): SessionProfile | undefined {
  return useSessionProfiles.getState().entities[id];
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

function resolveCwd(
  prev: string | undefined,
  patch: string | undefined,
): { cwd?: string } {
  if (patch === undefined) {
    return prev !== undefined ? { cwd: prev } : {};
  }
  // Empty string clears the cwd override.
  if (patch.length === 0) return {};
  return { cwd: patch };
}

function resolveEnv(
  prev: Readonly<Record<string, string>> | undefined,
  patch: Readonly<Record<string, string>> | undefined,
): { env?: Record<string, string> } {
  if (patch === undefined) {
    return prev ? { env: { ...prev } } : {};
  }
  // Empty object clears the env override.
  if (Object.keys(patch).length === 0) return {};
  const cleaned = sanitizeStartupEnv(patch);
  if (Object.keys(cleaned).length === 0) return {};
  return { env: cleaned };
}

function resolveStartupCommands(
  prev: readonly string[] | undefined,
  patch: readonly string[] | undefined,
): { startupCommands?: readonly string[] } {
  if (patch === undefined) {
    return prev && prev.length > 0 ? { startupCommands: [...prev] } : {};
  }
  // Empty array clears the startup-commands override.
  if (patch.length === 0) return {};
  const cleaned = sanitizeStartupCommands(patch);
  if (cleaned.length === 0) return {};
  return { startupCommands: cleaned };
}
