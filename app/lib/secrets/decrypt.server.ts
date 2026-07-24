const decoder = new TextDecoder()
const encoder = new TextEncoder()

function base64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeKey(value: string) {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(value.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16))
  }
  try {
    return base64ToBytes(value)
  } catch {
    return encoder.encode(value)
  }
}

export async function decryptSecret(value: string, encryptionKey: string) {
  const parsed = JSON.parse(value) as {
    version: number
    algorithm: string
    iv: string
    ciphertext: string
  }
  if (parsed.version !== 1 || parsed.algorithm !== "AES-GCM") {
    throw new Error("Unsupported encrypted secret format.")
  }

  const keyBytes = decodeKey(encryptionKey)
  if (keyBytes.byteLength !== 32) {
    throw new Error("FORMZERO_ENCRYPTION_KEY must contain exactly 32 bytes.")
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["decrypt"]
  )
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parsed.iv) },
    key,
    base64ToBytes(parsed.ciphertext)
  )
  return decoder.decode(plaintext)
}
