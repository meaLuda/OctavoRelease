import { describe, expect, it } from 'vitest'
import { Platform } from 'obsidian'
import { besideLeaf, canPopout } from '../src/platform'

const app = (calls: unknown[]) => ({ workspace: { getLeaf: (k: unknown) => { calls.push(k); return {} } } }) as any

describe('platform helpers', () => {
  it('desktop: pop-outs allowed and notes open in a split', () => {
    Object.assign(Platform, { isMobile: false, isPhone: false })
    const calls: unknown[] = []
    besideLeaf(app(calls))
    expect(canPopout()).toBe(true)
    expect(calls).toEqual(['split'])
  })
  it('phone: no pop-outs, notes open in place (one leaf on screen)', () => {
    Object.assign(Platform, { isMobile: true, isPhone: true })
    const calls: unknown[] = []
    besideLeaf(app(calls))
    expect(canPopout()).toBe(false)
    expect(calls).toEqual([false])
  })
  it('tablet: no pop-outs, but there is room to split', () => {
    Object.assign(Platform, { isMobile: true, isPhone: false, isTablet: true })
    const calls: unknown[] = []
    besideLeaf(app(calls))
    expect(canPopout()).toBe(false)
    expect(calls).toEqual(['split'])
  })
})
