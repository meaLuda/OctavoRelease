/** Pure helpers for the Account section (no Obsidian imports, unit-tested). */

export interface MeUsage { storageBytes?: number; ocrPages?: number; ttsMinutes?: number; aiCredits?: number }
export interface MeQuota { storage?: number; ocr?: number; tts?: number; ai?: number }
export interface Me {
  email?: string
  tier?: string
  status?: string
  plan?: string
  renewsAt?: string
  endsAt?: string
  isFounder?: boolean
  usage?: MeUsage
  quota?: MeQuota
  entitlement: string
  inbox?: string
  /** Octavo AI credits this month (Cloud + AI only). */
  ai?: { creditsLeft: number; resetsAt: string } | null
  /** Cloud + AI can be bought (the server has it switched on). */
  aiForSale?: boolean
}

export const planName = (tier?: string) =>
  tier === 'cloud_ai' ? 'Cloud + AI' : tier === 'founder' ? 'Founder (lifetime)' : tier === 'cloud' ? 'Cloud' : 'Free'

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

/** 1.5 GB, 820 MB, 12 KB. Decimal units, like the plan limits ("25 GB"). */
export function formatBytes(n: number): string {
  if (n >= 1e9) { const g = n / 1e9; return `${g >= 10 || Number.isInteger(g) ? Math.round(g) : g.toFixed(1)} GB` }
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${Math.round(n)} B`
}

export interface Meter { key: 'storage' | 'ocr' | 'tts' | 'ai'; label: string; used: string; limit: string; fraction: number }

/** One meter per quota the server reported; missing usage counts as 0, missing quota hides the meter. */
export function usageMeters(me: Pick<Me, 'usage' | 'quota'>): Meter[] {
  const u = me.usage ?? {}, q = me.quota ?? {}
  const out: Meter[] = []
  const add = (key: Meter['key'], label: string, used: number | null, limit: number | null, fmt: (n: number) => string) => {
    if (limit === null || limit <= 0) return
    const v = used ?? 0
    out.push({ key, label, used: fmt(v), limit: fmt(limit), fraction: Math.max(0, Math.min(1, v / limit)) })
  }
  add('storage', 'Library', num(u.storageBytes), num(q.storage), formatBytes)
  add('ocr', 'OCR', num(u.ocrPages), num(q.ocr), n => String(Math.round(n)))
  add('tts', 'Voices', num(u.ttsMinutes), num(q.tts), n => String(Math.round(n)))
  add('ai', 'AI credits', num(u.aiCredits), num(q.ai), n => String(Math.round(n)))
  return out
}

/** "2.1 GB of 25 GB · OCR 40/500 pages · voices 12/300 min" (empty when the server sent no quotas). */
export function usageLine(me: Pick<Me, 'usage' | 'quota'>): string {
  return usageMeters(me).map(m =>
    m.key === 'storage' ? `${m.used} of ${m.limit}` : m.key === 'ocr' ? `OCR ${m.used}/${m.limit} pages` : m.key === 'tts' ? `voices ${m.used}/${m.limit} min` : `AI ${m.used}/${m.limit} credits`,
  ).join(' · ')
}

const fmtDate = (iso: string): string | null => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "Cloud · active · renews 3 Nov 2026" / "Cloud · cancelled · ends 3 Nov 2026" / "Founder (lifetime)". */
export function planLine(me: Pick<Me, 'tier' | 'status' | 'renewsAt' | 'endsAt' | 'isFounder'>): string {
  const parts = [planName(me.isFounder ? 'founder' : me.tier)]
  const status = me.status?.replace(/_/g, ' ')
  if (status && !me.isFounder && me.tier && me.tier !== 'free') parts.push(status)
  const ends = me.endsAt ? fmtDate(me.endsAt) : null
  const renews = me.renewsAt ? fmtDate(me.renewsAt) : null
  if (!me.isFounder) {
    if (ends) parts.push(`ends ${ends}`)
    else if (renews) parts.push(`renews ${renews}`)
  }
  return parts.join(' · ')
}

/** Vault path for a data export, e.g. Octavo/octavo-export-2026-10-10.json */
export const exportPath = (date: Date) => `Octavo/octavo-export-${date.toISOString().slice(0, 10)}.json`
