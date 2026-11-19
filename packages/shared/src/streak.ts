/**
 * Forgiving streak: a day counts if the user read at least `goalMinutes`.
 * Up to `restDaysPerWeek` missed days in any rolling 7-day window don't break it.
 * Dates are local YYYY-MM-DD strings.
 */
export interface StreakResult { current: number; best: number; todayMinutes: number; metToday: boolean }

export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y!, m! - 1, d!) }

export function computeStreak(minutesByDay: Record<string, number>, goalMinutes: number, today: Date, restDaysPerWeek = 1): StreakResult {
  const met = (d: string) => (minutesByDay[d] ?? 0) >= goalMinutes
  const todayKey = isoDay(today)
  const days = Object.keys(minutesByDay).filter(met).sort()
  if (!days.length) return { current: 0, best: 0, todayMinutes: minutesByDay[todayKey] ?? 0, metToday: false }

  // walk from earliest met day to today, tracking runs that tolerate rest days
  const walk = (endKey: string) => {
    let best = 0, run = 0, misses: number[] = []
    // step by calendar day, not 24 h: across a clock change a 24 h step lands on 23:00 or 01:00 and skips or repeats a day
    const end = parse(endKey).getTime()
    for (let d = parse(days[0]!), i = 0; d.getTime() <= end; d.setDate(d.getDate() + 1), i++) {
      const key = isoDay(d)
      if (met(key)) { run++; }
      else {
        misses = misses.filter(x => i - x < 7)
        if (misses.length < restDaysPerWeek && run > 0) misses.push(i)
        else { run = 0; misses = [] }
      }
      best = Math.max(best, run)
    }
    return { run, best }
  }
  // today not yet met shouldn't break the streak: evaluate through yesterday in that case
  const metToday = met(todayKey)
  const end = metToday ? todayKey : (() => { const d = parse(todayKey); d.setDate(d.getDate() - 1); return isoDay(d) })()
  const { run, best } = walk(end)
  return { current: run, best: Math.max(best, run), todayMinutes: minutesByDay[todayKey] ?? 0, metToday }
}
