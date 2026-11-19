/** A gap longer than this between page turns, taps or keys counts as this long: the reader stepped away. */
export const READ_IDLE_MS = 5 * 60_000

/**
 * Reading time for stats. Counts the time between bits of activity, capped at READ_IDLE_MS per gap,
 * and nothing while the tab is hidden, so a book left open overnight is not logged as read.
 */
export class ReadingClock {
  private on = false
  private last = 0
  private paused = false
  private ms = 0
  /** Local YYYY-MM-DD the clock started on: time read past midnight is logged on the next day. */
  day = ''
  constructor(private now: () => number = Date.now) {}

  private static dayOf(t: number) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

  /** Running since before midnight: log what was read (stop) and start again for the new day. */
  get pastMidnight(): boolean { return this.on && this.day !== ReadingClock.dayOf(this.now()) }

  get running(): boolean { return this.on }

  start(): void { this.on = true; this.last = this.now(); this.day = ReadingClock.dayOf(this.last); this.ms = 0; this.paused = false }

  /** Call on page turns, taps, keys and scrolls. */
  tick(): void {
    if (!this.running || this.paused) return
    const t = this.now()
    this.ms += Math.min(t - this.last, READ_IDLE_MS)
    this.last = t
  }

  pause(): void { this.tick(); this.paused = true }

  resume(): void { if (this.running && this.paused) { this.paused = false; this.last = this.now() } }

  /** Whole minutes read since start; the clock stops. */
  stop(): number {
    if (!this.running) return 0
    this.tick()
    const minutes = Math.round(this.ms / 60_000)
    this.on = false; this.ms = 0; this.paused = false
    return minutes
  }
}
