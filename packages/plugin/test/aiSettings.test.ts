import { describe, expect, it } from 'vitest'
import { switchAiProvider } from '../src/ai/ask'

describe('AI provider switch', () => {
  it('a key, model and base URL stay with their own provider', () => {
    const a = { provider: 'ollama' as const, apiKey: '', model: 'llama3', baseUrl: 'http://192.168.1.20:11434', allowFallback: true } as Parameters<typeof switchAiProvider>[0]
    switchAiProvider(a, 'anthropic')
    expect(a).toMatchObject({ provider: 'anthropic', apiKey: '', model: '', baseUrl: '' }) // the LAN address does not carry over
    a.apiKey = 'sk-ant'
    switchAiProvider(a, 'openai')
    expect(a.apiKey).toBe('') // the Anthropic key is not sent to OpenAI
    switchAiProvider(a, 'none')
    switchAiProvider(a, 'anthropic')
    expect(a.apiKey).toBe('sk-ant')
    switchAiProvider(a, 'ollama')
    expect(a).toMatchObject({ model: 'llama3', baseUrl: 'http://192.168.1.20:11434' })
  })
})
