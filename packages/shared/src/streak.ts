/**
 * Forgiving streak: a day counts if the user read at least `goalMinutes`.
 * Up to `restDaysPerWeek` missed days in any rolling 7-day window don't break it.
 * Dates are local YYYY-MM-DD strings.
 */
export interface StreakResult { current: number; best: number; todayMinutes: number; metToday: boolean }

const DAY = 86_400_000
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
    const start = parse(days[0]!).getTime()
    const end = parse(endKey).getTime()
    for (let t = start, i = 0; t <= end; t += DAY, i++) {
      const key = isoDay(new Date(t))
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
  const end = metToday ? todayKey : isoDay(new Date(parse(todayKey).getTime() - DAY))
  const { run, best } = walk(end)
  return { current: run, best: Math.max(best, run), todayMinutes: minutesByDay[todayKey] ?? 0, metToday }
}
