import { describe, expect, it } from 'vitest'
import { AwakeKeeper } from '../src/reader/comfort'

function fakeDoc() {
  const held: Array<{ released: boolean; release(): Promise<void> }> = []
  const wakeLock = {
    request: async () => {
      await new Promise(r => setTimeout(r, 20))
      const s = { released: false, release: async () => { s.released = true } }
      held.push(s)
      return s
    },
  }
  const doc = { hidden: false, defaultView: { navigator: { wakeLock } } } as unknown as Document
  return { doc, stillHeld: () => held.filter(s => !s.released).length, made: () => held.length }
}

describe('screen wake lock', () => {
  it('two pokes during one request take one lock, and releasing frees it', async () => {
    const f = fakeDoc()
    const k = new AwakeKeeper(() => f.doc, () => true, () => true)
    k.poke(); k.poke()
    await new Promise(r => setTimeout(r, 40))
    expect(f.made()).toBe(1)
    k.release()
    expect(f.stillHeld()).toBe(0)
  })

  it('a lock that arrives after the book was closed is let go at once', async () => {
    const f = fakeDoc()
    const k = new AwakeKeeper(() => f.doc, () => true, () => true)
    k.poke()
    k.release() // closed while the request is on its way
    await new Promise(r => setTimeout(r, 40))
    expect(f.stillHeld()).toBe(0)
  })
})
