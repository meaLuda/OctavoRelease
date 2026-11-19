import { describe, expect, it } from 'vitest'
import { READ_IDLE_MS, ReadingClock } from '../src/reader/readingClock'

const MIN = 60_000

describe('reading clock', () => {
  it('counts time between bits of activity', () => {
    let now = 0
    const c = new ReadingClock(() => now)
    c.start()
    for (let i = 0; i < 10; i++) { now += MIN; c.tick() }
    expect(c.stop()).toBe(10)
  })

  it('a book left open counts only up to the idle limit', () => {
    let now = 0
    const c = new ReadingClock(() => now)
    c.start()
    now += 2 * MIN; c.tick()
    now += 40 * 60 * MIN // open overnight and then some
    expect(c.stop()).toBe(2 + READ_IDLE_MS / MIN)
  })

  it('a hidden tab does not count', () => {
    let now = 0
    const c = new ReadingClock(() => now)
    c.start()
    now += MIN; c.pause()
    now += 3 * MIN; c.tick() // activity while paused is ignored
    c.resume()
    now += MIN
    expect(c.stop()).toBe(2)
  })

  it('stop without start is zero and running reflects state', () => {
    const c = new ReadingClock(() => 0)
    expect(c.running).toBe(false)
    expect(c.stop()).toBe(0)
    c.start()
    expect(c.running).toBe(true)
    c.stop()
    expect(c.running).toBe(false)
  })
})
