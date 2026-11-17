/** Reading stats for the stats view: a year heatmap and totals. Pure: no Obsidian imports, unit-tested. */

export interface HeatCell { day: string; minutes: number; level: 0 | 1 | 2 | 3 | 4; future: boolean }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 0 none, then up to 15 min, 30, 60, more. */
export const heatLevel = (m: number): HeatCell['level'] => (m <= 0 ? 0 : m <= 15 ? 1 : m <= 30 ? 2 : m <= 60 ? 3 : 4)

/**
 * `weeks` columns of 7 days (Monday first), ending with the week of `today`. Days after today are marked `future`.
 * Returned column by column: cells[w * 7 + d].
 */
export function heatmap(minutesByDay: Record<string, number>, today: Date, weeks = 53): HeatCell[] {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const dow = (end.getDay() + 6) % 7 // Monday = 0
  const start = new Date(end)
  start.setDate(end.getDate() - dow - (weeks - 1) * 7)
  const out: HeatCell[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const day = iso(d), minutes = minutesByDay[day] ?? 0
    out.push({ day, minutes, level: heatLevel(minutes), future: d > end })
  }
  return out
}

export interface Totals { week: number; month: number; year: number; all: number; days: number }

/** Minutes this week (Monday on), this month, this year and ever, and the number of days with reading. */
export function totals(minutesByDay: Record<string, number>, today: Date): Totals {
  const t = iso(today)
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const wk = iso(monday)
  const out: Totals = { week: 0, month: 0, year: 0, all: 0, days: 0 }
  for (const [day, m] of Object.entries(minutesByDay)) {
    if (day > t || !m) continue
    out.all += m; out.days++
    if (day.slice(0, 4) === t.slice(0, 4)) out.year += m
    if (day.slice(0, 7) === t.slice(0, 7)) out.month += m
    if (day >= wk) out.week += m
  }
  return out
}

/** 95 → "1 h 35 min", 40 → "40 min". */
export function hoursMinutes(m: number): string {
  const h = Math.floor(m / 60), r = Math.round(m % 60)
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`
}
