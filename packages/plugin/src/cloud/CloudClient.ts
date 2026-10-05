import { App, Modal, Notice, Setting, TFile, requestUrl, type RequestUrlParam } from 'obsidian'
import { verifyToken, hasCloud, type Entitlement, type PublicKeys } from '@octavo/shared'
import type OctavoPlugin from '../main'
import { bookCache } from './cache'
import { makeStub, parseStub, STUB_MAX, type CloudStub } from './stub'
import { TextPromptModal } from '../reader/modals'
import { SignInModal } from './SignInModal'

const planName = (tier?: string) => tier === 'cloud_ai' ? 'Cloud + AI' : tier === 'founder' ? 'Founder (lifetime)' : tier === 'cloud' ? 'Cloud' : 'Free'

/** Public keys that sign entitlement tokens (rotated by `kid`). */
export const ENTITLEMENT_KEYS: PublicKeys = {
  // Production signing key (octavo.devformat.tools, kid prod-1). Rotate by adding the next kid here first.
  // A local dev server publishes its own key at /v1/keys; the client accepts that only for localhost.
  'prod-1': {"key_ops": ["verify"], "ext": true, "kty": "EC", "x": "MuDCjp3A4rAIzCdwIBX7iYPnwgzR8hZuWGsfIyb6G9E", "y": "FpGrbeSKGZvmAUf0hHLoaPQDzgZshRMb5dKdKRI5Wjs", "crv": "P-256"},
}

export interface CloudBook { id: string; title: string; author?: string; filename: string; size: number; format: string; ocr?: 'none' | 'queued' | 'done' | 'failed' }

/**
 * Octavo Cloud client. Every request is user-initiated (open a cloud book,
 * upload, sign in) — there is no background telemetry or scheduled phone-home.
 */
export class CloudClient {
  ent: Entitlement | null = null
  private keys: PublicKeys = { ...ENTITLEMENT_KEYS }
  constructor(private plugin: OctavoPlugin) {}

  get app(): App { return this.plugin.app }
  get s() { return this.plugin.settings.cloud }
  get signedIn() { return !!this.s.token }

  private async api<T = any>(path: string, init: Partial<RequestUrlParam> = {}): Promise<T> {
    const res = await requestUrl({
      url: `${this.s.apiBase.replace(/\/$/, '')}${path}`,
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(this.s.token ? { authorization: `Bearer ${this.s.token}` } : {}), ...init.headers },
      body: init.body,
      throw: false,
    })
    if (res.status === 401) { this.s.token = ''; await this.plugin.saveSettings(); throw new Error('Signed out — please sign in again') }
    if (res.status >= 400) throw new Error(res.json?.error ?? `HTTP ${res.status}`)
    return res.json as T
  }

  /** Refresh and verify the entitlement token (signature checked offline with WebCrypto). */
  async refresh(): Promise<Entitlement | null> {
    if (!this.signedIn) return (this.ent = null)
    const me = await this.api<{ entitlement: string; email: string }>('/v1/me')
    // Release builds trust only the compiled-in keys. A local development server (localhost) may
    // supply its own key — safe because every limit is enforced server-side; the token only drives UI.
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(this.s.apiBase)
    if ((__OCTAVO_DEV__ || local) && !Object.keys(this.keys).some(k => me.entitlement.includes(k))) this.keys = { ...ENTITLEMENT_KEYS, ...(await this.api<{ keys: PublicKeys }>('/v1/keys')).keys }
    const v = await verifyToken(me.entitlement, this.keys)
    this.ent = v.ok ? v.ent : null
    return this.ent
  }

  async signIn(): Promise<void> {
    await new SignInModal(this.app, this.s.email, {
      start: async email => { await this.api('/v1/auth/start', { method: 'POST', body: JSON.stringify({ email }) }) },
      verify: async (email, code) => {
        const r = await this.api<{ session: string }>('/v1/auth/verify', { method: 'POST', body: JSON.stringify({ email, code }) })
        this.s.email = email
        this.s.token = r.session
        await this.plugin.saveSettings()
        return planName((await this.refresh())?.tier)
      },
    }).result()
  }

  async signOut() { this.s.token = ''; this.ent = null; await this.plugin.saveSettings() }

  async checkout(plan: 'cloud_monthly' | 'cloud_yearly' | 'cloud_ai_monthly' | 'cloud_ai_yearly' | 'founder', rail: 'card' | 'mpesa' = 'card') {
    const r = await this.api<{ url: string }>('/v1/billing/checkout', { method: 'POST', body: JSON.stringify({ plan, rail }) })
    window.open(r.url)
  }

  private requireCloud(): boolean {
    if (!this.signedIn) { new Notice('Sign in to Octavo Cloud first (Settings → Octavo).'); return false }
    if (!hasCloud(this.ent?.tier)) { new Notice('This needs an Octavo Cloud plan.'); return false }
    return true
  }

  /** Upload a vault book, then (after confirmation) replace it with a stub to free vault/sync space. */
  async uploadBook(file: TFile): Promise<void> {
    await this.refresh().catch(() => null)
    if (!this.requireCloud()) return
    const data = await this.app.vault.readBinary(file)
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('')
    const notice = new Notice(`Uploading ${file.name}…`, 0)
    try {
      const up = await this.api<{ id: string; putUrl: string }>('/v1/library/upload', { method: 'POST', body: JSON.stringify({ filename: file.name, size: data.byteLength, sha256: sha, title: file.basename, format: file.extension }) })
      const put = await requestUrl({ url: up.putUrl, method: 'PUT', body: data, contentType: 'application/octet-stream', throw: false })
      if (put.status >= 300) throw new Error(`Upload failed (${put.status})`)
      await this.api(`/v1/library/${up.id}/complete`, { method: 'POST', body: '{}' })
      await bookCache.put(up.id, new Blob([data]))
      notice.hide()
      new ConfirmModal(this.app, 'Free up space?', `“${file.name}” is safely in your cloud library. Replace the vault copy with a small placeholder? Links and highlights keep working; the book downloads when you open it on another device.`, async () => {
        await this.app.vault.modify(file, makeStub({ id: up.id, size: data.byteLength, title: file.basename, sha256: sha }))
        new Notice('Book moved to Octavo Cloud')
      }).open()
    } catch (e) { notice.hide(); new Notice(`Octavo Cloud: ${(e as Error).message}`) }
  }

  /** If `file` is a cloud stub, return the real book (device cache first, then download). */
  async resolveStub(file: TFile): Promise<Blob | null> {
    if (file.stat.size > STUB_MAX) return null
    const stub = parseStub(await this.app.vault.read(file))
    if (!stub) return null
    return this.fetchBook(stub)
  }

  async fetchBook(stub: CloudStub): Promise<Blob> {
    const cached = await bookCache.get(stub.id)
    if (cached) return cached
    if (!this.signedIn) throw new Error('This book is in Octavo Cloud — sign in to download it.')
    const notice = new Notice(`Downloading “${stub.title}”…`, 0)
    try {
      const { url } = await this.api<{ url: string }>(`/v1/library/${stub.id}/download`)
      const res = await requestUrl({ url, throw: false })
      if (res.status >= 300) throw new Error(`Download failed (${res.status})`)
      const blob = new Blob([res.arrayBuffer])
      await bookCache.put(stub.id, blob)
      return blob
    } finally { notice.hide() }
  }

  /** Neural read-aloud: returns a playable URL (cached server-side by text+voice). */
  async tts(text: string, voice: string, signal?: { cancelled: boolean }): Promise<string> {
    const r = await this.api<{ status: string; url?: string; job?: string }>('/v1/tts', { method: 'POST', body: JSON.stringify({ text, voice }) })
    if (r.url) return r.url
    for (let i = 0; i < 240 && !signal?.cancelled; i++) {
      await new Promise(res => window.setTimeout(res, i < 10 ? 400 : 1000))
      const j = await this.api<{ status: string; error?: string; result?: { url?: string } }>(`/v1/jobs/${r.job}`)
      if (j.status === 'done' && j.result?.url) return j.result.url
      if (j.status === 'failed') throw new Error(j.error ?? 'Read-aloud failed')
    }
    throw new Error('Read-aloud timed out')
  }

  async requestOcr(file: TFile): Promise<void> {
    await this.refresh().catch(() => null)
    if (!this.requireCloud()) return
    const stub = file.stat.size <= STUB_MAX ? parseStub(await this.app.vault.read(file)) : null
    if (!stub) { new Notice('Move the PDF to Octavo Cloud first, then run OCR.'); return }
    await this.api(`/v1/library/${stub.id}/ocr`, { method: 'POST', body: '{}' })
    new Notice('OCR queued — you’ll get a searchable copy in your cloud library.')
  }

  async browse(): Promise<void> {
    if (!this.signedIn) return this.signIn()
    const books = await this.api<{ books: CloudBook[] }>('/v1/library').then(r => r.books).catch(e => { new Notice((e as Error).message); return null })
    if (books) new CloudLibraryModal(this.app, this, books).open()
  }

  async addStubToVault(b: CloudBook): Promise<TFile> {
    const folder = 'Library'
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {})
    let path = `${folder}/${b.filename}`
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) return existing
    return this.app.vault.create(path, makeStub({ id: b.id, size: b.size, title: b.title }))
  }

  renderSettings(c: HTMLElement, redraw: () => void) {
    if (!this.signedIn) {
      new Setting(c).setName('Account').setDesc('Sign in with your email — no password.')
        .addButton(b => b.setButtonText('Sign in').setCta().onClick(async () => { await this.signIn(); redraw() }))
      return
    }
    const st = new Setting(c).setName(this.s.email || 'Signed in').setDesc('Checking plan…')
    st.addButton(b => b.setButtonText('Sign out').onClick(async () => { await this.signOut(); redraw() }))
    void this.refresh().then(ent => {
      st.setDesc(`Plan: ${planName(ent?.tier)}`)
      if (!hasCloud(ent?.tier)) {
        new Setting(c).setName('Upgrade').setDesc('$4/month or $36/year · Cloud + AI $9.99/month or $84/year')
          .addButton(b => b.setButtonText('Yearly').setCta().onClick(() => void this.checkout('cloud_yearly')))
          .addButton(b => b.setButtonText('Monthly').onClick(() => void this.checkout('cloud_monthly')))
          .addButton(b => b.setButtonText('M-Pesa').onClick(() => void this.checkout('cloud_yearly', 'mpesa')))
      }
    }).catch(e => st.setDesc(`Could not reach Octavo Cloud: ${(e as Error).message}`))
    new Setting(c).setName('Cloud library').setDesc('Browse books stored in your cloud library.')
      .addButton(b => b.setButtonText('Browse').onClick(() => void this.browse()))
    new Setting(c).setName('Device cache').setDesc('Cloud books you opened are cached on this device only.')
      .addButton(b => b.setButtonText('Clear cache').onClick(async () => { await bookCache.clear(); new Notice('Cache cleared') }))
    new Setting(c).setName('KOReader sync').setDesc(`Point KOReader's progress sync at ${this.s.apiBase.replace(/\/$/, '')}/kosync with your Octavo email and a sync password.`)
      .addButton(b => b.setButtonText('Set sync password').onClick(async () => {
        const pw = await new TextPromptModal(this.app, 'KOReader sync password', '', 'Choose a password for KOReader').result()
        if (pw) { await this.api('/v1/kosync/password', { method: 'POST', body: JSON.stringify({ password: pw }) }); new Notice('KOReader sync is ready') }
      }))
    new Setting(c).setName('Server').addText(t => t.setValue(this.s.apiBase).onChange(v => { this.s.apiBase = v.trim(); void this.plugin.saveSettings() }))
  }
}

class ConfirmModal extends Modal {
  constructor(app: App, private heading: string, private message: string, private onYes: () => void | Promise<void>) { super(app) }
  onOpen() {
    this.setTitle(this.heading)
    this.contentEl.createEl('p', { text: this.message })
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Keep both').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Replace with placeholder').setCta().onClick(async () => { await this.onYes(); this.close() }))
  }
  onClose() { this.contentEl.empty() }
}

class CloudLibraryModal extends Modal {
  constructor(app: App, private client: CloudClient, private books: CloudBook[]) { super(app) }
  onOpen() {
    this.setTitle('Octavo Cloud library')
    if (!this.books.length) this.contentEl.createEl('p', { text: 'Your cloud library is empty. Right-click a book in the file explorer → “Move to Octavo Cloud library”, or email books to your inbox address.' })
    for (const b of this.books) {
      new Setting(this.contentEl).setName(b.title).setDesc(`${b.author ?? ''} · ${(b.size / 1024 / 1024).toFixed(1)} MB${b.ocr === 'done' ? ' · OCR ✓' : b.ocr === 'queued' ? ' · OCR running' : ''}`)
        .addButton(x => x.setButtonText('Open').setCta().onClick(async () => {
          const f = await this.client.addStubToVault(b)
          this.close()
          await this.client['plugin'].openInOctavo(f, this.app.workspace.getLeaf('tab'))
        }))
    }
  }
  onClose() { this.contentEl.empty() }
}
