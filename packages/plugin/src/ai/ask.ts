import { requestUrl } from 'obsidian'
import type { OctavoSettings } from '../settings'

export const DEFAULT_MODELS = { openai: '', anthropic: 'claude-sonnet-5-5', ollama: '' } as const

export function aiConfigured(s: OctavoSettings): boolean {
  const a = s.ai
  if (a.provider === 'none') return false
  if (a.provider === 'octavo') return !!s.cloud.token // signed in; the server checks the plan
  if (a.provider === 'ollama') return true
  if (a.provider === 'openai') return !!a.apiKey && !!a.model
  return !!a.apiKey
}

/**
 * Bring-your-own-key AI. Network calls happen only when the user triggers an
 * AI action (Ask / Define), go straight to the provider the user configured,
 * and never through an Octavo server. Octavo AI (provider 'octavo', Cloud + AI)
 * goes through CloudClient.ai() instead: see ./hosted.ts.
 */
interface ApiError { error?: { message?: string } }
interface AnthropicRes extends ApiError { content?: Array<{ type: string; text?: string }> }
interface OpenAIRes extends ApiError { choices?: Array<{ message?: { content?: string } }> }
interface OllamaChat { error?: string; message?: { content?: string } }

const ollamaBase = (s: OctavoSettings) => (s.ai.baseUrl || 'http://localhost:11434').replace(/\/$/, '')

/** Models installed in the local Ollama (empty list if it isn't running). */
export async function listOllamaModels(s: OctavoSettings): Promise<string[]> {
  try {
    const res = await within(requestUrl({ url: `${ollamaBase(s)}/api/tags`, throw: false }), 5000)
    return res.status === 200 ? ((res.json as { models?: Array<{ name: string }> } | null)?.models ?? []).map(m => String(m.name)) : []
  } catch { return [] }
}

/**
 * Ask the configured model. `onText` receives the growing answer when the
 * provider streams (local Ollama streams token by token; cloud providers
 * return in one piece).
 */
/** A provider that never answers (a sleeping LAN host, a model still loading) must not leave a notice or modal up forever. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t = 0
  return Promise.race([p, new Promise<T>((_, reject) => { t = window.setTimeout(() => reject(new Error(`no answer after ${Math.round(ms / 1000)} seconds`)), ms) })]).finally(() => window.clearTimeout(t))
}
const AI_TIMEOUT_MS = 120_000
const OLLAMA_TIMEOUT_MS = 300_000 // a big local model can take minutes to load

/** `onText` gets the answer so far while it streams; returning false (its window was closed) stops it. */
export async function askAI(s: OctavoSettings, prompt: string, onText?: (soFar: string) => void | boolean): Promise<string> {
  const a = s.ai
  if (a.provider === 'octavo') throw new Error('Octavo AI answers through its own features (Define, Ask, Summarise)')
  if (a.provider === 'ollama') return askOllama(s, prompt, onText)
  if (a.provider === 'anthropic') {
    const res = await within(requestUrl({
      url: `${a.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': a.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: a.model || DEFAULT_MODELS.anthropic, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      throw: false,
    }), AI_TIMEOUT_MS)
    const j = res.json as AnthropicRes | null
    if (res.status >= 400) throw new Error(j?.error?.message ?? `HTTP ${res.status}`)
    return (j?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
  }
  if (a.provider === 'openai') {
    const res = await within(requestUrl({
      url: `${(a.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({ model: a.model, messages: [{ role: 'user', content: prompt }] }),
      throw: false,
    }), AI_TIMEOUT_MS)
    const j = res.json as OpenAIRes | null
    if (res.status >= 400) throw new Error(j?.error?.message ?? `HTTP ${res.status}`)
    return j?.choices?.[0]?.message?.content ?? ''
  }
  throw new Error('No AI provider configured')
}

async function askOllama(s: OctavoSettings, prompt: string, onText?: (soFar: string) => void | boolean): Promise<string> {
  let model = s.ai.model
  if (!model) model = (await listOllamaModels(s))[0] ?? DEFAULT_MODELS.ollama
  // Ollama's default context (2 to 8K tokens) drops the start of a long prompt, instructions included: size it to the prompt
  // (about 3.5 characters a token) plus room for the answer. A 300 word chapter summary needs more than 400 tokens.
  const num_predict = 1024
  const num_ctx = Math.min(32_768, Math.max(4096, Math.ceil((prompt.length / 3.5 + num_predict) / 2048) * 2048))
  const options = { num_predict, num_ctx, temperature: 0.3 }
  const body = JSON.stringify({ model, stream: !!onText, options, messages: [{ role: 'user', content: prompt }] })
  const url = `${ollamaBase(s)}/api/chat`
  if (onText) {
    // Ollama allows app:// origins by default, so the renderer can stream directly.
    // fetch, not requestUrl: token streaming needs a ReadableStream body and requestUrl buffers the whole response.
    try {
      const ac = new AbortController()
      const res = await within(activeWindow.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ac.signal }), OLLAMA_TIMEOUT_MS)
        .catch(e => { ac.abort(); throw e })
      if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = '', text = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
            if (!line) continue
            const j = JSON.parse(line) as OllamaChat
            if (j.error) throw new Error(j.error)
            text += j.message?.content ?? ''
            if (onText(text) === false) return text // closed: stop, and Ollama stops generating
          }
        }
      } finally { ac.abort() }
      return text
    } catch (e) {
      if (!(e instanceof TypeError)) throw e // TypeError = blocked by CORS/network: fall back below
    }
  }
  const res = await within(requestUrl({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, options, messages: [{ role: 'user', content: prompt }] }), throw: false }), OLLAMA_TIMEOUT_MS)
  const j = res.json as OllamaChat | null
  if (res.status >= 400) throw new Error(j?.error ?? `Ollama HTTP ${res.status}`)
  const text = j?.message?.content ?? ''
  onText?.(text)
  return text
}

type AiSettings = OctavoSettings['ai']
const OWN_KEY = ['openai', 'anthropic', 'ollama'] as const
const ownKey = (p: AiSettings['provider']): p is typeof OWN_KEY[number] => (OWN_KEY as readonly string[]).includes(p)

/** Change provider: the current key, model and base URL are kept for the old provider, and the new one gets its own (or none). */
export function switchAiProvider(a: AiSettings, to: AiSettings['provider']): void {
  if (to === a.provider) return
  if (ownKey(a.provider)) a.saved = { ...a.saved, [a.provider]: { apiKey: a.apiKey, model: a.model, baseUrl: a.baseUrl } }
  const next = ownKey(to) ? a.saved?.[to] : undefined
  a.apiKey = next?.apiKey ?? ''
  a.model = next?.model ?? ''
  a.baseUrl = next?.baseUrl ?? ''
  a.provider = to
}
