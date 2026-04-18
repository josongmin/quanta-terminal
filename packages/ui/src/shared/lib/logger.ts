/**
 * Tiny logger — gated on `import.meta.env.DEV` (Vite) and on the presence of
 * a `globalThis.__QUANTA_DEBUG__` flag. `warn` and `error` always pass through;
 * `debug` and `info` are compiled / stripped in production builds because
 * modern bundlers dead-code-eliminate `if (false)` branches.
 *
 * Hosts / tests may flip `globalThis.__QUANTA_DEBUG__ = true` at runtime to
 * enable debug logging without a rebuild.
 *
 * This module exists so feature code can stop calling `console.log` directly —
 * production paths then carry no console noise.
 */

type LogArgs = readonly unknown[];

declare global {
  // eslint-disable-next-line no-var
  var __QUANTA_DEBUG__: boolean | undefined;
}

function isDev(): boolean {
  // Prefer the global flag (set by hosts or tests); fall back to Vite's env.
  if (typeof globalThis.__QUANTA_DEBUG__ === 'boolean') return globalThis.__QUANTA_DEBUG__;
  try {
    // `import.meta.env` is Vite-only; in non-Vite environments (e.g. vitest
    // jsdom without vite), `import.meta.env?.DEV` may be undefined.
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
    return Boolean(env?.DEV);
  } catch {
    return false;
  }
}

export interface Logger {
  debug(...args: LogArgs): void;
  info(...args: LogArgs): void;
  warn(...args: LogArgs): void;
  error(...args: LogArgs): void;
}

export function createLogger(scope: string): Logger {
  const tag = `[quanta:${scope}]`;
  return {
    debug(...args) {
      if (!isDev()) return;
      // eslint-disable-next-line no-console
      console.debug(tag, ...args);
    },
    info(...args) {
      if (!isDev()) return;
      // eslint-disable-next-line no-console
      console.info(tag, ...args);
    },
    warn(...args) {
      // eslint-disable-next-line no-console
      console.warn(tag, ...args);
    },
    error(...args) {
      // eslint-disable-next-line no-console
      console.error(tag, ...args);
    },
  };
}
