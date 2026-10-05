/** Stable book id: sha256(size + first 1 MiB), hex, first 16 chars. Same file → same id on every device. */
export async function bookIdFromBytes(head: ArrayBuffer | Uint8Array, size: number): Promise<string> {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head)
  const slice = bytes.subarray(0, 1024 * 1024)
  const sizeBytes = new TextEncoder().encode(`${size}:`)
  const buf = new Uint8Array(sizeBytes.length + slice.length)
  buf.set(sizeBytes, 0)
  buf.set(slice, sizeBytes.length)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
