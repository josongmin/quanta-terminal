/**
 * Gzip helpers using the browser-native `CompressionStream` / `DecompressionStream`.
 *
 * We use these for block-output blobs above 1 MiB (ADR 0005 blob-spill
 * analogue). Using the platform API keeps the bundle empty of a pako-sized
 * dep, at the cost of needing a platform that ships these streams — Chrome
 * 80+, Firefox 113+, Safari 16.4+, Node 20+. All host targets qualify.
 *
 * In jsdom tests, `CompressionStream` may be absent. The persistence layer
 * checks `isGzipAvailable()` and skips compression when false — the stored
 * flag `compressed=false` keeps the round-trip faithful.
 *
 * `CompressionStream` / `DecompressionStream` accept `BufferSource` on write
 * and emit `Uint8Array` on read. The lib.dom typing is narrower than that on
 * some TS versions; we type the transformer structurally to avoid the tight
 * `TransformStream<Uint8Array, Uint8Array>` coupling.
 */

interface ByteTransformer {
  readonly writable: WritableStream<BufferSource>;
  readonly readable: ReadableStream<Uint8Array>;
}

function streamAvailable(): boolean {
  const g = globalThis as typeof globalThis & {
    CompressionStream?: unknown;
    DecompressionStream?: unknown;
  };
  return typeof g.CompressionStream === 'function' && typeof g.DecompressionStream === 'function';
}

export function isGzipAvailable(): boolean {
  return streamAvailable();
}

async function streamThrough(
  input: Uint8Array,
  transformer: ByteTransformer,
): Promise<Uint8Array> {
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();
  const chunks: Uint8Array[] = [];
  // Copy into a fresh ArrayBuffer-backed Uint8Array to satisfy the DOM
  // `BufferSource` typing: TS rejects `Uint8Array<ArrayBufferLike>` because
  // the buffer could in principle be a `SharedArrayBuffer`, which is not
  // writable through `WritableStream<BufferSource>` in the lib.dom types.
  const owned = new Uint8Array(input.byteLength);
  owned.set(input);
  const writePromise = (async () => {
    await writer.write(owned);
    await writer.close();
  })();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await writePromise;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** gzip-compress a byte array. Rejects if `CompressionStream` is unavailable. */
export async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (!streamAvailable()) throw new Error('gzip: CompressionStream unavailable');
  const g = globalThis as typeof globalThis & {
    CompressionStream: new (format: string) => ByteTransformer;
  };
  return streamThrough(bytes, new g.CompressionStream('gzip'));
}

/** gzip-decompress a byte array. Rejects if `DecompressionStream` is
 *  unavailable. */
export async function gzipDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (!streamAvailable()) throw new Error('gzip: DecompressionStream unavailable');
  const g = globalThis as typeof globalThis & {
    DecompressionStream: new (format: string) => ByteTransformer;
  };
  return streamThrough(bytes, new g.DecompressionStream('gzip'));
}
