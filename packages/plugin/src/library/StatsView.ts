import { ItemView, moment, type WorkspaceLeaf } from 'obsidian'
import { computeStreak } from '@octavo/shared'
import type OctavoPlugin from '../main'
import { propText } from './dedupe'
import { heatmap, hoursMinutes, totals } from './stats'

export const STATS_VIEW = 'octavo-stats'

/** Reading stats: a year heatmap of minutes per day, totals, streak, time per book and books finished per year. */
export class StatsView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: OctavoPlugin) { super(leaf) }

  getViewType() { return STATS_VIEW }
  getDisplayText() { return 'Reading stats' }
  getIcon() { return 'bar-chart-3' }

  async onOpen() {
    this.render()
    // a session logged while this is open (a book closed in another tab) shows up
    this.registerInterval(window.setInterval(() => this.render(), 60_000))
  }

  render() {
    const s = this.plugin.settings
    const c = this.contentEl
    c.empty()
    c.addClass('octavo-stats')
    const today = new Date()
    const t = totals(s.stats.minutesByDay, today)
    const st = computeStreak(s.stats.minutesByDay, s.goals.dailyMinutes, today, s.goals.restDaysPerWeek)
    const year = moment().format('YYYY')

    c.createEl('h2', { text: 'Reading stats' })
    const tiles = c.createDiv({ cls: 'octavo-stats-tiles' })
    const tile = (label: string, value: string) => { const d = tiles.createDiv({ cls: 'octavo-stats-tile' }); d.createDiv({ cls: 'octavo-stats-value', text: value }); d.createDiv({ cls: 'octavo-stats-label', text: label }) }
    tile('This week', hoursMinutes(t.week))
    tile('This month', hoursMinutes(t.month))
    tile(year, hoursMinutes(t.year))
    tile('Streak', `${st.current} day${st.current === 1 ? '' : 's'}`)
    tile(`Finished in ${year}`, String(s.stats.finishedByYear[year] ?? 0))

    c.createEl('h3', { text: 'Last 12 months' })
    const wrap = c.createDiv({ cls: 'octavo-heat-wrap' })
    const grid = wrap.createDiv({ cls: 'octavo-heat', attr: { role: 'img', 'aria-label': `Minutes read per day over the last year: ${hoursMinutes(t.year)} this year` } })
    const cells = heatmap(s.stats.minutesByDay, today)
    let lastMonth = ''
    const months = wrap.createDiv({ cls: 'octavo-heat-months' })
    for (let w = 0; w * 7 < cells.length; w++) {
      const m = moment(cells[w * 7].day).format('MMM')
      months.createSpan({ text: m !== lastMonth ? m : '' })
      lastMonth = m
    }
    for (const cell of cells) {
      const d = grid.createDiv({ cls: `octavo-heat-cell is-l${cell.level}${cell.future ? ' is-future' : ''}` })
      if (!cell.future) d.setAttribute('aria-label', `${moment(cell.day).format('ddd D MMM YYYY')}: ${cell.minutes ? hoursMinutes(cell.minutes) : 'no reading'}`)
    }
    const legend = wrap.createDiv({ cls: 'octavo-heat-legend' })
    legend.createSpan({ text: 'Less' })
    for (let l = 0; l <= 4; l++) legend.createDiv({ cls: `octavo-heat-cell is-l${l}` })
    legend.createSpan({ text: 'More' })
    c.createDiv({ cls: 'setting-item-description', text: `${t.days} reading day${t.days === 1 ? '' : 's'} · ${hoursMinutes(t.all)} in all · best streak ${st.best} day${st.best === 1 ? '' : 's'}` })

    const byBook = this.bookTimes()
    if (byBook.length) {
      c.createEl('h3', { text: 'Time per book' })
      const max = byBook[0].minutes
      const list = c.createDiv({ cls: 'octavo-stats-books' })
      for (const b of byBook.slice(0, 15)) {
        const row = list.createDiv({ cls: 'octavo-stats-book' })
        const name = row.createDiv({ cls: 'octavo-stats-book-name', text: b.title })
        if (b.note) { name.addClass('is-link'); name.onclick = () => void this.app.workspace.getLeaf(false).openFile(b.note!) }
        row.createDiv({ cls: 'octavo-stats-bar' }).setCssProps({ '--w': `${Math.max(3, (b.minutes / max) * 100)}%` })
        row.createDiv({ cls: 'octavo-stats-book-time', text: hoursMinutes(b.minutes) })
      }
      c.createDiv({ cls: 'setting-item-description', text: 'Time per book is counted from Octavo 1.1.1 on.' })
    }

    const years = Object.entries(s.stats.finishedByYear).filter(([, n]) => n > 0).sort()
    if (years.length) {
      c.createEl('h3', { text: 'Books finished' })
      const list = c.createDiv({ cls: 'octavo-stats-books' })
      const max = Math.max(...years.map(([, n]) => n))
      for (const [y, n] of years.reverse()) {
        const row = list.createDiv({ cls: 'octavo-stats-book' })
        row.createDiv({ cls: 'octavo-stats-book-name', text: y })
        row.createDiv({ cls: 'octavo-stats-bar' }).setCssProps({ '--w': `${Math.max(3, (n / max) * 100)}%` })
        row.createDiv({ cls: 'octavo-stats-book-time', text: String(n) })
      }
    }
  }

  private bookTimes() {
    const byId = this.plugin.settings.stats.minutesByBook
    const notes = new Map(this.plugin.library.allBooks().map(b => [propText(this.plugin.library.getProps(b.note)['octavo-id'] ?? ''), b.note]))
    return Object.entries(byId).filter(([, m]) => m > 0).map(([id, minutes]) => {
      const note = notes.get(id) ?? null
      const title = note ? propText(this.plugin.library.getProps(note).title ?? note.basename) : 'A book no longer in the library'
      return { id, minutes, note, title }
    }).sort((a, b) => b.minutes - a.minutes)
  }
}
