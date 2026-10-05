/**
 * Entitlement tokens: compact JWS, ES256 (ECDSA P-256 / SHA-256), verified
 * offline with WebCrypto. No device fingerprinting, no scheduled phone-home:
 * the plugin refreshes the token only when the user opens Cloud features.
 */
export type Tier = 'free' | 'cloud' | 'cloud_ai' | 'founder'
export interface Entitlement {
  sub: string // account id
  tier: Tier
  iat: number // seconds
  exp: number // seconds
  /** storage quota bytes, OCR pages/mo, TTS minutes/mo */
  q?: { storage?: number; ocr?: number; tts?: number; ai?: number }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64urlEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

export type PublicKeys = Record<string, JsonWebKey>

export type VerifyResult =
  | { ok: true; ent: Entitlement; expired: false }
  | { ok: true; ent: Entitlement; expired: true } // within grace — still honoured
  | { ok: false; reason: 'malformed' | 'unknown-key' | 'bad-signature' | 'expired' | 'bad-alg' }

/** Grace after exp during which the tier stays active (offline travel, server down). */
export const GRACE_SECONDS = 14 * 86_400

export async function verifyToken(token: string, keys: PublicKeys, nowSec = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  let header: { alg?: string; kid?: string }
  let ent: Entitlement
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0]!)))
    ent = JSON.parse(dec.decode(b64urlDecode(parts[1]!)))
  } catch { return { ok: false, reason: 'malformed' } }
  if (header.alg !== 'ES256') return { ok: false, reason: 'bad-alg' }
  const jwk = header.kid ? keys[header.kid] : undefined
  if (!jwk) return { ok: false, reason: 'unknown-key' }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64urlDecode(parts[2]!) as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`) as BufferSource)
  if (!valid) return { ok: false, reason: 'bad-signature' }
  if (typeof ent.exp !== 'number') return { ok: false, reason: 'malformed' }
  if (nowSec <= ent.exp) return { ok: true, ent, expired: false }
  if (nowSec <= ent.exp + GRACE_SECONDS) return { ok: true, ent, expired: true }
  return { ok: false, reason: 'expired' }
}

/** Server-side signer (Node ≥ 20 / any WebCrypto runtime). */
export async function signToken(ent: Entitlement, privateJwk: JsonWebKey, kid: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const h = b64urlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }))
  const p = b64urlEncode(JSON.stringify(ent))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${h}.${p}`)))
  return `${h}.${p}.${b64urlEncode(sig)}`
}

export function hasCloud(t: Tier | undefined): boolean { return t === 'cloud' || t === 'cloud_ai' || t === 'founder' }
export function hasAi(t: Tier | undefined): boolean { return t === 'cloud_ai' }
