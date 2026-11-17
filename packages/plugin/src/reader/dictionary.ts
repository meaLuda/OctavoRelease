import { normalizePath, type App } from 'obsidian'

/** Definitions kept for offline use: word (lower case) → definition and when it was looked up. */
export type DictEntries = Record<string, { d: string; at: number }>

/** At most this many words are kept; the oldest go first. */
export const DICT_MAX = 4000

export const dictKey = (word: string) => word.trim().toLowerCase().replace(/[“”"'’‘.,;:!?()[\]]/g, '').replace(/\s+/g, ' ')

/** The entries with `word` added, trimmed to DICT_MAX by age. */
export function remember(entries: DictEntries, word: string, defn: string, now = Date.now()): DictEntries {
  const k = dictKey(word)
  if (!k || !defn.trim()) return entries
  const next = { ...entries, [k]: { d: defn.trim(), at: now } }
  const keys = Object.keys(next)
  if (keys.length <= DICT_MAX) return next
  const keep = keys.sort((a, b) => next[b].at - next[a].at).slice(0, DICT_MAX)
  return Object.fromEntries(keep.map(x => [x, next[x]]))
}

/** A definition from Vocabulary.md lines (`word::definition`), for words saved there. */
export function fromVocabulary(md: string, word: string): string | null {
  const k = dictKey(word)
  for (const line of md.split('\n')) {
    const i = line.indexOf('::')
    if (i > 0 && dictKey(line.slice(0, i)) === k) return line.slice(i + 2).trim() || null
  }
  return null
}

/**
 * Offline fallback for Define: every definition found online (or from your AI) is kept in the plugin folder
 * (`dictionary.json`, per device, never synced into notes), and words in your Vocabulary note count too.
 */
export class OfflineDictionary {
  private entries: DictEntries | null = null
  private saveTimer = 0
  constructor(private app: App, private dir: string, private vocabPath: () => string) {}

  private get path() { return normalizePath(`${this.dir}/dictionary.json`) }

  private async load(): Promise<DictEntries> {
    if (this.entries) return this.entries
    try { this.entries = JSON.parse(await this.app.vault.adapter.read(this.path)) as DictEntries } catch { this.entries = {} }
    return this.entries
  }

  async get(word: string): Promise<string | null> {
    const hit = (await this.load())[dictKey(word)]
    if (hit) return hit.d
    const vocab = this.app.vault.getFileByPath(this.vocabPath())
    return vocab ? fromVocabulary(await this.app.vault.cachedRead(vocab), word) : null
  }

  async put(word: string, defn: string): Promise<void> {
    this.entries = remember(await this.load(), word, defn)
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.app.vault.adapter.write(this.path, JSON.stringify(this.entries)).catch(() => {}), 1500)
  }
}
