/**
 * Base64 helpers for PTY byte frames. xterm.js accepts Uint8Array via
 * `term.write`, which we hand the raw decoded bytes.
 *
 * Kept dependency-free and environment-agnostic: uses the WHATWG `atob` global
 * which exists in every supported browser and in Node 16+. Tests run in jsdom,
 * which provides it.
 */

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
