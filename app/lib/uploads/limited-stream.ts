/**
 * Byte counting, limiting and hashing that happen while data flows past.
 *
 * Uploads used to be materialised with `arrayBuffer()` before being written to
 * R2, and `crypto.subtle.digest` needed the whole body again — so a 10 MB file
 * cost at least 20 MB of Worker memory, with the size limit checked only after
 * the bytes had already been accepted.
 *
 * R2 also rejects ordinary TransformStream bodies ("must have a known length").
 * The final hop therefore goes through FixedLengthStream so the advertised size
 * matches the bytes that will actually be written.
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

type DigestStreamLike = WritableStream<ArrayBuffer | ArrayBufferView> & {
  digest: Promise<ArrayBuffer>
}

function createSha256DigestStream(): DigestStreamLike {
  // Workers expose DigestStream on crypto, not as a bare global.
  const ctor = (
    globalThis.crypto as Crypto & {
      DigestStream?: new (algorithm: string) => DigestStreamLike
    }
  ).DigestStream
  if (!ctor) {
    throw new Error("crypto.DigestStream is required for hashed uploads.")
  }
  return new ctor("SHA-256")
}

function withKnownLength(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number
): ReadableStream<Uint8Array> {
  // Node unit tests do not ship FixedLengthStream; production Workers always do.
  if (typeof FixedLengthStream === "undefined") return stream
  return stream.pipeThrough(new FixedLengthStream(expectedBytes))
}

/**
 * A limiter that also hashes in the same pass.
 *
 * `crypto.DigestStream` accepts data incrementally (unlike `crypto.subtle.digest`),
 * which is what makes a single pass possible. The returned body is wrapped so R2
 * sees a known length equal to `expectedBytes`.
 */
export function limitAndHash(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes: number
) {
  if (expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new ByteLimitExceededError(maxBytes)
  }

  const digest = createSha256DigestStream()
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

  const limited = source.pipeThrough(limiter.stream).pipeThrough(hashing)

  return {
    body: withKnownLength(limited, expectedBytes),
    bytesRead: limiter.bytesRead,
    checksum: async () => toHex(await digest.digest),
  }
}
