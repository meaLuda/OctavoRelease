import { describe, expect, it, vi } from 'vitest'

const opened: Array<{ path: string; destroyed: boolean }> = []
vi.mock('../src/pdf/source', () => ({
  openPdfDocument: async (_lib: unknown, url: string) => {
    const d = { path: url, destroyed: false, destroy: () => { d.destroyed = true } }
    opened.push(d)
    return d
  },
}))

const { PdfDocCache, addsEmbed, releaseCanvas } = await import('../src/pdf/regionRender')
const { regionLimits, regionPlan, isDestroyedDocError } = await import('../src/pdf/region')

const app: any = { vault: { getResourcePath: (f: any) => f.path, readBinary: async () => new ArrayBuffer(0) } }
const file = (path: string, mtime = 1): any => ({ path, stat: { mtime, size: 10 } })

describe('PdfDocCache', () => {
  it('defers destroying an evicted document until its in-flight user is done', async () => {
    opened.length = 0
    const cache = new PdfDocCache(app, 1)
    let finish!: () => void
    const held = cache.use(file('a.pdf'), async pdf => { await new Promise<void>(r => { finish = r }); return pdf })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await cache.use(file('b.pdf'), async () => null) // evicts a.pdf while it is rendering
    const a = opened.find(d => d.path === 'a.pdf')!
    await Promise.resolve()
    expect(a.destroyed).toBe(false)
    finish()
    expect(await held).toBe(a)
    await vi.waitFor(() => expect(a.destroyed).toBe(true))
  })

  it('retries once on a fresh document when the document was destroyed under a render', async () => {
    opened.length = 0
    const cache = new PdfDocCache(app, 3)
    let calls = 0
    const r = await cache.use(file('c.pdf'), async pdf => { if (++calls === 1) throw new Error('Transport destroyed'); return pdf })
    expect(calls).toBe(2)
    expect(opened.length).toBe(2)
    expect(r).toBe(opened[1])
    await vi.waitFor(() => expect(opened[0]!.destroyed).toBe(true))
    // other errors are not retried
    let n = 0
    await expect(cache.use(file('c.pdf'), async () => { n++; throw new Error('bad page') })).rejects.toThrow('bad page')
    expect(n).toBe(1)
  })
})

describe('region limits', () => {
  it('caps pixels and dpr on mobile', () => {
    expect(regionLimits(true, 3)).toEqual({ dpr: 2, maxPixels: 2 ** 22 })
    expect(regionLimits(false, 3)).toEqual({ dpr: 3, maxPixels: 2 ** 24 })
    expect(regionLimits(false, 0).dpr).toBe(1)
    const lim = regionLimits(true, 3)
    const p = regionPlan({ x: 0, y: 0, w: 612, h: 792 }, 6000, lim.dpr, lim.maxPixels)
    expect(p.width * p.height).toBeLessThanOrEqual(2 ** 22 * 1.01)
    expect(isDestroyedDocError(new Error('Worker was destroyed'))).toBe(true)
    expect(isDestroyedDocError(new Error('Invalid page request'))).toBe(false)
  })
})

describe('embed mutation filter', () => {
  const SEL = '.internal-embed[src*=".pdf#" i][src*="rect=" i]'
  const rec = (...nodes: Node[]) => [{ addedNodes: nodes } as unknown as MutationRecord]
  it('rescans only for added embeds or a region embed that lost its crop', () => {
    const embed = document.createElement('span'); embed.className = 'internal-embed'
    const wrap = document.createElement('div'); wrap.append(embed.cloneNode())
    expect(addsEmbed(rec(embed), SEL)).toBe(true)
    expect(addsEmbed(rec(wrap), SEL)).toBe(true)
    expect(addsEmbed(rec(document.createElement('p'), document.createTextNode('typing')), SEL)).toBe(false)
    const host = document.createElement('span'); host.className = 'internal-embed'; host.setAttribute('src', 'B.pdf#page=2&rect=1,2,3,4')
    const child = document.createElement('div'); host.append(child)
    expect(addsEmbed(rec(child), SEL)).toBe(true) // core re-rendered the embed: crop gone
    const box = document.createElement('div'); box.className = 'octavo-region-embed'; host.prepend(box)
    expect(addsEmbed(rec(child), SEL)).toBe(false) // crop still there
  })
  it('releases canvas memory', () => {
    const c = document.createElement('canvas'); c.width = 100; c.height = 50
    releaseCanvas(c)
    expect([c.width, c.height]).toEqual([0, 0])
  })
})
