import { describe, expect, it } from 'vitest'
import { shouldPrompt, markPrompted, promptCopy, SYNC_LIMIT_BYTES, MAX_SEEN } from '../src/cloud/prompts'

const on = (seen: string[] = []) => ({ cloudPrompts: true, promptsSeen: seen })
describe('cloud prompts', () => {
  it('big-book hint only above the 5 MB Sync limit and never for cloud placeholders', () => {
    expect(shouldPrompt(on(), 'big', 'b1', { size: SYNC_LIMIT_BYTES })).toBe(false)
    expect(shouldPrompt(on(), 'big', 'b1', { size: SYNC_LIMIT_BYTES + 1 })).toBe(true)
    expect(shouldPrompt(on(), 'big', 'b1', { size: 50e6, isStub: true })).toBe(false)
  })
  it('shows each kind at most once per book', () => {
    const seen = markPrompted([], 'scan', 'b1')
    expect(shouldPrompt(on(seen), 'scan', 'b1')).toBe(false)
    expect(shouldPrompt(on(seen), 'scan', 'b2')).toBe(true)
    expect(shouldPrompt(on(seen), 'voice', 'b1', { systemVoice: true })).toBe(true)
    expect(markPrompted(seen, 'scan', 'b1')).toEqual(['scan:b1'])
  })
  it('respects the setting, a missing book id, and the voice context', () => {
    expect(shouldPrompt({ cloudPrompts: false, promptsSeen: [] }, 'scan', 'b1')).toBe(false)
    expect(shouldPrompt(on(), 'scan', '')).toBe(false)
    expect(shouldPrompt(on(), 'voice', 'b1', { systemVoice: false })).toBe(false)
  })
  it('keeps the remembered list bounded', () => {
    let seen: string[] = []
    for (let i = 0; i < MAX_SEEN + 20; i++) seen = markPrompted(seen, 'big', `b${i}`)
    expect(seen).toHaveLength(MAX_SEEN)
    expect(seen.at(-1)).toBe(`big:b${MAX_SEEN + 19}`)
  })
  it('offers the direct action to Cloud users', () => {
    expect(promptCopy('big', false).text).toBe('Over Obsidian Sync\'s 5 MB limit? Keep it in Octavo Cloud.')
    expect(promptCopy('big', true).action).toBe('Move to Octavo Cloud')
    expect(promptCopy('scan', false).text).toBe('Make this scan searchable with OCR (Cloud).')
    expect(promptCopy('scan', true, true).action).toBe('Run OCR')
    expect(promptCopy('voice', false).text).toBe('Natural voices with Octavo Cloud.')
  })
})
