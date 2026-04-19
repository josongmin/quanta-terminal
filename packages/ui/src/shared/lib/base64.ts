/**
 * Base64 helpers for PTY byte frames. The custom VT engine consumes
 * `Uint8Array` chunks; these helpers bridge the host bridge's base64
 * transport to that format.
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
