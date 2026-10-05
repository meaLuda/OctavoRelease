/**
 * Reading-pace estimator: learns seconds-per-character from the reader's own
 * page dwell times (moving average, outliers dropped), then estimates time left.
 */
export class Pace {
  private samples: number[] = []
  constructor(private max = 40, initialSecPerChar = 0.06 /* ≈ 250 wpm */) {
    this.fallback = initialSecPerChar
  }
  private fallback: number

  /** Record that the user spent `seconds` on a page with `chars` characters. */
  record(seconds: number, chars: number): void {
    if (chars < 200) return // nearly empty pages tell us nothing
    if (seconds < 2 || seconds > 600) return // skimmed or idle
    this.samples.push(seconds / chars)
    if (this.samples.length > this.max) this.samples.shift()
  }

  get secPerChar(): number {
    if (this.samples.length < 3) return this.fallback
    const sorted = [...this.samples].sort((a, b) => a - b)
    const lo = Math.floor(sorted.length * 0.1)
    const hi = Math.ceil(sorted.length * 0.9)
    const kept = sorted.slice(lo, hi)
    return kept.reduce((a, b) => a + b, 0) / kept.length
  }

  /** Seconds left for `chars` remaining characters. */
  estimate(chars: number): number {
    return Math.round(chars * this.secPerChar)
  }

  toJSON() { return { s: this.samples.map(x => Math.round(x * 1e5) / 1e5) } }
  static fromJSON(j: unknown): Pace {
    const p = new Pace()
    const s = (j as { s?: unknown })?.s
    if (Array.isArray(s)) p.samples = s.filter((x): x is number => typeof x === 'number' && x > 0).slice(-p.max)
    return p
  }
}

export function formatDuration(sec: number): string {
  if (sec < 60) return '< 1 min'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}
