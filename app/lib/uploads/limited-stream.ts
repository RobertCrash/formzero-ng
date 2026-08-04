/**
 * Byte counting, limiting and hashing that happen while data flows past.
 *
 * Uploads used to be materialised with `arrayBuffer()` before being written to
 * R2, and `crypto.subtle.digest` needed the whole body again — so a 10 MB file
 * cost at least 20 MB of Worker memory, with the size limit checked only after
 * the bytes had already been accepted.
 */

export class ByteLimitExceededError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`The stream exceeded its ${limit}-byte limit.`)
    this.name = "ByteLimitExceededError"
    this.limit = limit
  }
}

export type ByteLimiter = {
  /** Pipe the source through this before consuming it. */
  stream: TransformStream<Uint8Array, Uint8Array>
  /** Bytes seen so far; final once the source has been fully consumed. */
  bytesRead: () => number
}

/**
 * Errors the stream as soon as `maxBytes` is passed, so the consumer aborts
 * rather than completing a write that would have to be undone.
 */
export function createByteLimiter(maxBytes: number): ByteLimiter {
  let bytesRead = 0
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength
      if (bytesRead > maxBytes) {
        controller.error(new ByteLimitExceededError(maxBytes))
        return
      }
      controller.enqueue(chunk)
    },
  })
  return { stream, bytesRead: () => bytesRead }
}

function toHex(digest: ArrayBuffer) {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * A limiter that also hashes in the same pass.
 *
 * `DigestStream` is a Workers global; unlike `crypto.subtle.digest` it accepts
 * data incrementally, which is what makes a single pass possible.
 */
export function limitAndHash(source: ReadableStream<Uint8Array>, maxBytes: number) {
  const digest = new DigestStream("SHA-256")
  const writer = digest.getWriter()
  const limiter = createByteLimiter(maxBytes)

  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await writer.write(chunk)
      controller.enqueue(chunk)
    },
    async flush() {
      await writer.close()
    },
    async cancel(reason) {
      // Leaves the digest promise settled rather than pending forever.
      await writer.abort(reason).catch(() => {})
    },
  })

  return {
    body: source.pipeThrough(limiter.stream).pipeThrough(hashing),
    bytesRead: limiter.bytesRead,
    checksum: async () => toHex(await digest.digest),
  }
}
