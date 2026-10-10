import { describe, expect, it } from 'vitest'
import { scrollStep, autoScrollAction, decideAxis, wheelLock, TURN_PAUSE_MS } from '../src/pdf/autoScroll'

describe('scrollStep', () => {
  it('carries fractions so slow speeds still move', () => {
    let acc = 0, moved = 0
    for (let i = 0; i < 60; i++) { const s = scrollStep(acc, 1000 / 60, 40); acc = s.acc; moved += s.px }
    expect(moved).toBeGreaterThanOrEqual(39); expect(moved).toBeLessThanOrEqual(40)
  })
  it('caps a long frame at 100 ms', () => expect(scrollStep(0, 5000, 100).px).toBe(10))
  it('negative or zero time does nothing', () => expect(scrollStep(0.5, -20, 100)).toEqual({ px: 0, acc: 0.5 }))
})

describe('autoScrollAction', () => {
  const base = { paged: false, top: 0, view: 800, height: 5000, lastPage: false, waited: null, speed: 40 }
  it('vertical scrolls until the end of the book', () => {
    expect(autoScrollAction(base)).toBe('scroll')
    expect(autoScrollAction({ ...base, top: 4200 })).toBe('end')
  })
  it('paged: a tall page scrolls first', () => expect(autoScrollAction({ ...base, paged: true, height: 1600, top: 100 })).toBe('scroll'))
  it('paged: at the bottom it waits, then turns after the pause', () => {
    const at = { ...base, paged: true, height: 1600, top: 800 }
    expect(autoScrollAction(at)).toBe('wait')
    expect(autoScrollAction({ ...at, waited: TURN_PAUSE_MS - 1 })).toBe('wait')
    expect(autoScrollAction({ ...at, waited: TURN_PAUSE_MS })).toBe('turn')
  })
  it('paged: a page that fits stays up for a screen at this speed', () => {
    const fits = { ...base, paged: true, height: 860, speed: 400 } // 800 px at 400 px/s = 2 s
    expect(autoScrollAction({ ...fits, waited: 1500 })).toBe('wait')
    expect(autoScrollAction({ ...fits, waited: 2000 })).toBe('turn')
  })
  it('paged: the last page ends', () => expect(autoScrollAction({ ...base, paged: true, height: 1600, top: 800, lastPage: true })).toBe('end'))
})

describe('decideAxis', () => {
  it('waits for ~10 px of movement', () => expect(decideAxis(4, 6)).toBeNull())
  it('picks the dominant axis', () => {
    expect(decideAxis(12, 3)).toBe('x')
    expect(decideAxis(-3, -12)).toBe('y')
  })
  it('vertical wins a tie', () => expect(decideAxis(8, 8)).toBe('y'))
})

describe('wheelLock', () => {
  it('locks a gesture to its first direction and suppresses the minor axis', () => {
    let r = wheelLock(null, 2, 12, 0)
    expect(r.axis).toBe('y'); expect(r.suppress).toBe(true)
    r = wheelLock(r.gesture, 30, 5, 50) // sideways drift mid-gesture stays vertical
    expect(r.axis).toBe('y'); expect(r.suppress).toBe(true)
    r = wheelLock(r.gesture, 0, 5, 100)
    expect(r.suppress).toBe(false) // pure vertical events pass through natively
  })
  it('accumulates small deltas before deciding', () => {
    let r = wheelLock(null, 3, 1, 0)
    expect(r.axis).toBeNull(); expect(r.suppress).toBe(false)
    r = wheelLock(r.gesture, 6, 2, 16); r = wheelLock(r.gesture, 4, 1, 32)
    expect(r.axis).toBe('x')
  })
  it('a pause of 200 ms starts a new gesture', () => {
    const r = wheelLock(null, 0, 20, 0)
    expect(wheelLock(r.gesture, 20, 0, 150).axis).toBe('y')
    expect(wheelLock(r.gesture, 20, 0, 260).axis).toBe('x')
  })
})
