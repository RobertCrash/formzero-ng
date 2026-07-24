const encoder = new TextEncoder()

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeKey(value: string) {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(value.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16))
  }

  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return encoder.encode(value)
  }
}

async function importKey(value: string) {
  const bytes = decodeKey(value)
  if (bytes.byteLength !== 32) {
    throw new Error("FORMZERO_ENCRYPTION_KEY must contain exactly 32 bytes.")
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"])
}

export async function encryptSecret(value: string, encryptionKey: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await importKey(encryptionKey)
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value)
  )

  return JSON.stringify({
    version: 1,
    algorithm: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  })
}
