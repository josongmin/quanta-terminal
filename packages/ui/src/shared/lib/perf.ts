/**
 * Perf instrumentation — thin wrappers over the browser User Timing API.
 *
 * Local-only. No telemetry is emitted. The purpose is to expose marks/measures
 * so the future debug panel (Round 3 may wire) and devtools performance tab
 * can show them. In jsdom (tests) `performance.mark` exists but may be a
 * no-op; every call is guarded and swallows errors so instrumentation never
 * breaks hot paths.
 *
 * Conventions:
 *   - mark names: `quanta:<surface>.<event>` e.g. `quanta:term.write-start`.
 *   - measure names: `quanta:<surface>.<span>` e.g. `quanta:term.write`.
 *
 * The helpers intentionally avoid closures/options so inlining is cheap.
 */

const PREFIX = 'quanta:';

function safePerformance(): Performance | undefined {
  if (typeof performance === 'undefined') return undefined;
  return performance;
}

export function mark(name: string): void {
  const perf = safePerformance();
  if (!perf || typeof perf.mark !== 'function') return;
  try {
    perf.mark(PREFIX + name);
  } catch {
    // Swallow; some environments (Safari in certain iframe sandboxes) reject
    // duplicates. Never propagate instrumentation failures.
  }
}

/**
 * Record a measure between two marks. Returns the `duration` in milliseconds
 * (or `undefined` if the marks are missing / environment rejects the call).
 */
export function measure(name: string, startMark: string, endMark: string): number | undefined {
  const perf = safePerformance();
  if (!perf || typeof perf.measure !== 'function') return undefined;
  try {
    const entry = perf.measure(PREFIX + name, PREFIX + startMark, PREFIX + endMark);
    // Some polyfills return void; fall back to performance.getEntriesByName.
    if (entry && typeof entry.duration === 'number') return entry.duration;
    const entries =
      typeof perf.getEntriesByName === 'function' ? perf.getEntriesByName(PREFIX + name) : [];
    const last = entries[entries.length - 1];
    return last && typeof last.duration === 'number' ? last.duration : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Clear performance entries created by this module. Useful between test cases.
 */
export function clearPerfEntries(): void {
  const perf = safePerformance();
  if (!perf) return;
  try {
    if (typeof perf.clearMarks === 'function') perf.clearMarks();
    if (typeof perf.clearMeasures === 'function') perf.clearMeasures();
  } catch {
    /* ignore */
  }
}
