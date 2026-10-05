import type { OctavoSettings } from '../settings'

/**
 * Read-aloud with word-level highlighting. foliate's TTS module returns SSML
 * with <mark name="n"/> before each word; we speak the plain text with the
 * Web Speech API and map `boundary` events back to marks.
 */
export class Speaker {
  active = false
  private utter: SpeechSynthesisUtterance | null = null
  constructor(private foliate: any, private opts: OctavoSettings['tts'], private onEnd: () => void) {}

  static voice(name: string): SpeechSynthesisVoice | undefined {
    return name ? speechSynthesis.getVoices().find(v => v.name === name) : undefined
  }

  static say(text: string, opts: OctavoSettings['tts']) {
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = opts.rate
    const v = Speaker.voice(opts.voice)
    if (v) u.voice = v
    speechSynthesis.speak(u)
  }

  start() {
    this.active = true
    const ssml = this.foliate.tts?.start()
    if (ssml) this.speak(ssml)
    else this.finish()
  }

  stop() {
    this.active = false
    speechSynthesis.cancel()
  }

  private speak(ssml: string): void {
    const { text, marks } = parseSsml(ssml)
    if (!text.trim()) { void this.advance(); return }
    const u = new SpeechSynthesisUtterance(text)
    u.rate = this.opts.rate
    const v = Speaker.voice(this.opts.voice)
    if (v) u.voice = v
    u.onboundary = e => {
      if (e.name !== 'word') return
      // last mark at or before the boundary
      let mark: string | undefined
      for (const m of marks) { if (m.offset <= e.charIndex) mark = m.name; else break }
      if (mark !== undefined) this.foliate.tts?.setMark(mark)
    }
    u.onend = () => { if (this.active) this.advance() }
    u.onerror = () => this.finish()
    this.utter = u
    speechSynthesis.speak(u)
  }

  private async advance(): Promise<void> {
    const next = this.foliate.tts?.next()
    if (next) return this.speak(next)
    // end of section → turn to the next section and continue
    const before = this.foliate.renderer?.primaryIndex
    await this.foliate.renderer?.nextSection?.()
    if (!this.active || this.foliate.renderer?.primaryIndex === before) return this.finish()
    this.foliate.tts = null
    await this.foliate.initTTS('word')
    this.start()
  }

  private finish() { this.active = false; this.onEnd() }
}

export function parseSsml(ssml: string): { text: string; marks: Array<{ name: string; offset: number }> } {
  const doc = new DOMParser().parseFromString(ssml, 'application/xml')
  let text = ''
  const marks: Array<{ name: string; offset: number }> = []
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) text += c.textContent
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const e = c as Element
        if (e.localName === 'mark') marks.push({ name: e.getAttribute('name') ?? '', offset: text.length })
        else if (e.localName === 'break') text += ' '
        else walk(e)
      }
    }
  }
  walk(doc.documentElement)
  return { text, marks }
}

/**
 * Cloud read-aloud (Kokoro voices via Octavo Cloud). Speaks foliate's TTS
 * blocks one at a time, prefetching the next block's audio, and moves the word
 * highlight along with playback (the audio has no word timings, so position is
 * interpolated from playback progress).
 */
export class CloudSpeaker {
  active = false
  private audio = new Audio()
  private cancel = { cancelled: false }
  private next: { ssml: string; url: Promise<string> } | null = null
  constructor(private foliate: any, private fetchUrl: (text: string, signal: { cancelled: boolean }) => Promise<string>, private rate: number, private onEnd: () => void, private onError: (e: Error) => void) {}

  start() {
    this.active = true
    this.cancel = { cancelled: false }
    const ssml = this.foliate.tts?.start()
    if (ssml) void this.play(ssml)
    else this.finish()
  }

  stop() {
    this.active = false
    this.cancel.cancelled = true
    this.audio.pause()
    this.audio.removeAttribute('src')
  }

  private prefetch() {
    const ssml = this.foliate.tts?.next() // advances the cursor without moving the highlight
    if (!ssml) { this.next = null; return }
    // foliate advanced its cursor; remember the block so we can play it next
    const { text } = parseSsml(ssml)
    this.next = { ssml, url: text.trim() ? this.fetchUrl(text, this.cancel) : Promise.resolve('') }
    this.next.url.catch(() => {})
  }

  private async play(ssml: string, url?: Promise<string>): Promise<void> {
    const { text, marks } = parseSsml(ssml)
    try {
      const src = await (url ?? (text.trim() ? this.fetchUrl(text, this.cancel) : Promise.resolve('')))
      if (!this.active) return
      if (!src) return this.advance()
      this.prefetch()
      this.audio.src = src
      this.audio.playbackRate = this.rate
      let last: string | undefined
      this.audio.ontimeupdate = () => {
        if (!this.audio.duration) return
        const at = (this.audio.currentTime / this.audio.duration) * text.length
        let mark: string | undefined
        for (const m of marks) { if (m.offset <= at) mark = m.name; else break }
        if (mark !== undefined && mark !== last) { last = mark; this.foliate.tts?.setMark(mark) }
      }
      this.audio.onended = () => { if (this.active) void this.advance() }
      await this.audio.play()
    } catch (e) {
      if (!this.cancel.cancelled) { this.onError(e as Error); this.finish() }
    }
  }

  private async advance(): Promise<void> {
    if (this.next) { const n = this.next; this.next = null; return this.play(n.ssml, n.url) }
    const before = this.foliate.renderer?.primaryIndex
    await this.foliate.renderer?.nextSection?.()
    if (!this.active || this.foliate.renderer?.primaryIndex === before) return this.finish()
    this.foliate.tts = null
    await this.foliate.initTTS('word')
    this.start()
  }

  private finish() { this.active = false; this.onEnd() }
}
