import { requestUrl } from 'obsidian'
import type { OctavoSettings } from '../settings'

export const DEFAULT_MODELS = { openai: '', anthropic: 'claude-sonnet-5-5', ollama: '' } as const

export function aiConfigured(s: OctavoSettings): boolean {
  const a = s.ai
  if (a.provider === 'none') return false
  if (a.provider === 'ollama') return true
  if (a.provider === 'openai') return !!a.apiKey && !!a.model
  return !!a.apiKey
}

/**
 * Bring-your-own-key AI. Network calls happen only when the user triggers an
 * AI action (Ask / Define), go straight to the provider the user configured,
 * and never through an Octavo server.
 */
const ollamaBase = (s: OctavoSettings) => (s.ai.baseUrl || 'http://localhost:11434').replace(/\/$/, '')

/** Models installed in the local Ollama (empty list if it isn't running). */
export async function listOllamaModels(s: OctavoSettings): Promise<string[]> {
  try {
    const res = await requestUrl({ url: `${ollamaBase(s)}/api/tags`, throw: false })
    return res.status === 200 ? (res.json?.models ?? []).map((m: any) => String(m.name)) : []
  } catch { return [] }
}

/**
 * Ask the configured model. `onText` receives the growing answer when the
 * provider streams (local Ollama streams token by token; cloud providers
 * return in one piece).
 */
export async function askAI(s: OctavoSettings, prompt: string, onText?: (soFar: string) => void): Promise<string> {
  const a = s.ai
  if (a.provider === 'ollama') return askOllama(s, prompt, onText)
  if (a.provider === 'anthropic') {
    const res = await requestUrl({
      url: `${a.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': a.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: a.model || DEFAULT_MODELS.anthropic, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      throw: false,
    })
    if (res.status >= 400) throw new Error(res.json?.error?.message ?? `HTTP ${res.status}`)
    return (res.json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
  }
  if (a.provider === 'openai') {
    const res = await requestUrl({
      url: `${(a.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({ model: a.model, messages: [{ role: 'user', content: prompt }] }),
      throw: false,
    })
    if (res.status >= 400) throw new Error(res.json?.error?.message ?? `HTTP ${res.status}`)
    return res.json.choices?.[0]?.message?.content ?? ''
  }
  throw new Error('No AI provider configured')
}

async function askOllama(s: OctavoSettings, prompt: string, onText?: (soFar: string) => void): Promise<string> {
  let model = s.ai.model
  if (!model) model = (await listOllamaModels(s))[0] ?? DEFAULT_MODELS.ollama
  const options = { num_predict: 400, temperature: 0.3 }
  const body = JSON.stringify({ model, stream: !!onText, options, messages: [{ role: 'user', content: prompt }] })
  const url = `${ollamaBase(s)}/api/chat`
  if (onText) {
    // Ollama allows app:// origins by default, so the renderer can stream directly.
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = '', text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line) continue
          const j = JSON.parse(line)
          if (j.error) throw new Error(j.error)
          text += j.message?.content ?? ''
          onText(text)
        }
      }
      return text
    } catch (e) {
      if (!(e instanceof TypeError)) throw e // TypeError = blocked by CORS/network: fall back below
    }
  }
  const res = await requestUrl({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, options, messages: [{ role: 'user', content: prompt }] }), throw: false })
  if (res.status >= 400) throw new Error(res.json?.error ?? `Ollama HTTP ${res.status}`)
  const text = res.json.message?.content ?? ''
  onText?.(text)
  return text
}
