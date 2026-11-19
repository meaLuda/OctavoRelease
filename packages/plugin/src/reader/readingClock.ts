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
  constructor(private now: () => number = Date.now) {}

  get running(): boolean { return this.on }

  start(): void { this.on = true; this.last = this.now(); this.ms = 0; this.paused = false }

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
