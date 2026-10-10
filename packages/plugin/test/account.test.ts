import { describe, expect, it } from 'vitest'
import { formatBytes, usageLine, usageMeters, planLine, exportPath } from '../src/cloud/account'

const GB = 1e9
describe('account usage', () => {
  it('formats the one-line usage summary', () => {
    const me = { usage: { storageBytes: 2.1 * GB, ocrPages: 40, ttsMinutes: 12 }, quota: { storage: 25 * GB, ocr: 500, tts: 300 } }
    expect(usageLine(me)).toBe('2.1 GB of 25 GB · OCR 40/500 pages · voices 12/300 min')
  })
  it('clamps meters and treats missing usage as zero', () => {
    const m = usageMeters({ usage: { ocrPages: 900 }, quota: { storage: 10 * GB, ocr: 500 } })
    expect(m.map(x => [x.key, x.fraction])).toEqual([['storage', 0], ['ocr', 1]])
  })
  it('degrades to nothing when the server sends no quotas', () => {
    expect(usageLine({})).toBe('')
    expect(usageMeters({ usage: { storageBytes: 5 }, quota: { storage: 0 } })).toEqual([])
  })
  it('formats bytes in decimal units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(820e6)).toBe('820 MB')
    expect(formatBytes(1.55e9)).toBe('1.6 GB')
    expect(formatBytes(12e9)).toBe('12 GB')
  })
})

describe('plan line', () => {
  it('shows status and renewal or end date', () => {
    expect(planLine({ tier: 'cloud', status: 'active', renewsAt: '2026-11-03T00:00:00Z' })).toMatch(/^Cloud · active · renews .*2026$/)
    expect(planLine({ tier: 'cloud', status: 'cancelled', renewsAt: '2026-11-03T00:00:00Z', endsAt: '2026-11-03T00:00:00Z' })).toMatch(/^Cloud · cancelled · ends /)
    expect(planLine({ tier: 'cloud', status: 'past_due' })).toBe('Cloud · past due')
  })
  it('founders have no renewal and free has no status', () => {
    expect(planLine({ tier: 'founder', isFounder: true, status: 'active', renewsAt: '2026-11-03' })).toBe('Founder (lifetime)')
    expect(planLine({ tier: 'free', status: 'none' })).toBe('Free')
    expect(planLine({ tier: 'cloud', renewsAt: 'not a date' })).toBe('Cloud')
  })
  it('exports into Octavo/ with the date', () => {
    expect(exportPath(new Date('2026-10-10T12:00:00Z'))).toBe('Octavo/octavo-export-2026-10-10.json')
  })
})
