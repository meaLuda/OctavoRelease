import { describe, expect, it } from 'vitest'
import { mergeSyncedStats } from '../src/settings'

describe('settings saved by another device', () => {
  it('keeps both devices\' reading stats: the larger count per day, year and book', () => {
    const desktop = { minutesByDay: { '2026-11-18': 40, '2026-11-19': 10 }, finishedByYear: { '2026': 4 }, minutesByBook: { a: 100 } }
    const phone = { minutesByDay: { '2026-11-19': 30 }, finishedByYear: { '2026': 5 }, minutesByBook: { a: 90, b: 30 } }
    expect(mergeSyncedStats(desktop, phone)).toEqual({
      minutesByDay: { '2026-11-18': 40, '2026-11-19': 30 },
      finishedByYear: { '2026': 5 },
      minutesByBook: { a: 100, b: 30 },
    })
  })

  it('copes with an older settings file that has no stats', () => {
    const mine = { minutesByDay: { d: 1 }, finishedByYear: {}, minutesByBook: {} }
    expect(mergeSyncedStats(mine, undefined)).toEqual(mine)
  })
})
