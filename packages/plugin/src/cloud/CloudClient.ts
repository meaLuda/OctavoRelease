import { App, Modal, Notice, Setting, TFile, normalizePath, requestUrl, type RequestUrlParam } from 'obsidian'
import { verifyToken, hasCloud, type Entitlement, type PublicKeys } from '@octavo/shared'
import type OctavoPlugin from '../main'
import { bookCache } from './cache'
import { makeStub, parseStub, STUB_MAX, type CloudStub } from './stub'
import { TextPromptModal } from '../reader/modals'
import { SignInModal } from './SignInModal'
import { TypeToConfirmModal } from '../reader/modals'
import { exportPath, planLine, planName, usageLine, usageMeters, type Me } from './account'
import { hostedRequest, type AiFeature, type AiInput, type HostedReply } from '../ai/hosted'
import { cloudLabelsKey, groupByCollection, labelsKey, mergeCloudLabels, noteLabels } from '../library/organise'
import { destructive } from '../platform'

export type CheckoutPlan = 'cloud_monthly' | 'cloud_yearly' | 'cloud_ai_monthly' | 'cloud_ai_yearly' | 'founder'

/** Public keys that sign entitlement tokens (rotated by `kid`). */
export const ENTITLEMENT_KEYS: PublicKeys = {
  // Production signing key (octavo.devformat.tools, kid prod-1). Rotate by adding the next kid here first.
  // A local dev server publishes its own key at /v1/keys; the client accepts that only for localhost.
  'prod-1': {"key_ops": ["verify"], "ext": true, "kty": "EC", "x": "MuDCjp3A4rAIzCdwIBX7iYPnwgzR8hZuWGsfIyb6G9E", "y": "FpGrbeSKGZvmAUf0hHLoaPQDzgZshRMb5dKdKRI5Wjs", "crv": "P-256"},
}

export interface CloudBook { id: string; title: string; author?: string; filename: string; size: number; format: string; ocr?: 'none' | 'queued' | 'done' | 'failed'; collections?: string[]; tags?: string[] }

/**
 * Octavo Cloud client. Every request is user-initiated (open a cloud book,
 * upload, sign in) — there is no background telemetry or scheduled phone-home.
 */
export class CloudClient {
  ent: Entitlement | null = null
  /** Last /v1/me response (plan, status, dates, usage); fields the server doesn't send stay undefined. */
  me: Me | null = null
  private keys: PublicKeys = { ...ENTITLEMENT_KEYS }
  constructor(private plugin: OctavoPlugin) {}

  get app(): App { return this.plugin.app }
  get s() { return this.plugin.settings.cloud }
  get signedIn() { return !!this.s.token }

  private async api<T = unknown>(path: string, init: Partial<RequestUrlParam> = {}): Promise<T> {
    const res = await requestUrl({
      url: `${this.s.apiBase.replace(/\/$/, '')}${path}`,
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(this.s.token ? { authorization: `Bearer ${this.s.token}` } : {}), ...init.headers },
      body: init.body,
      throw: false,
    })
    if (res.status === 401) { this.s.token = ''; await this.plugin.saveSettings(); throw new Error('Signed out — please sign in again') }
    if (res.status >= 400) throw new Error((res.json as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
    return res.json as T
  }

  /** Refresh and verify the entitlement token (signature checked offline with WebCrypto). */
  async refresh(): Promise<Entitlement | null> {
    if (!this.signedIn) { this.me = null; return (this.ent = null) }
    const me = await this.api<Me>('/v1/me')
    this.me = me
    // Release builds trust only the compiled-in keys. A local development server (localhost) may
    // supply its own key — safe because every limit is enforced server-side; the token only drives UI.
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(this.s.apiBase)
    if ((__OCTAVO_DEV__ || local) && !Object.keys(this.keys).some(k => me.entitlement.includes(k))) this.keys = { ...ENTITLEMENT_KEYS, ...(await this.api<{ keys: PublicKeys }>('/v1/keys')).keys }
    const v = await verifyToken(me.entitlement, this.keys)
    this.ent = v.ok ? v.ent : null
    await this.defaultToOctavoAi()
    return this.ent
  }

  /** Cloud + AI includes Octavo AI: make it the AI provider once, unless the user already set up their own. */
  private async defaultToOctavoAi() {
    const ai = this.plugin.settings.ai
    if (this.ent?.tier !== 'cloud_ai' || ai.octavoDefaulted) return
    ai.octavoDefaulted = true
    if (ai.provider === 'none') ai.provider = 'octavo'
    await this.plugin.saveSettings()
  }

  /** Octavo AI (Cloud + AI): one JSON request through requestUrl, no streaming. Server errors are user-readable. */
  async ai(feature: AiFeature, input: AiInput): Promise<HostedReply> {
    if (!this.signedIn) throw new Error('Sign in to Octavo Cloud (Settings → Octavo → Cloud) to use Octavo AI.')
    const req = hostedRequest(feature, input, this.plugin.settings.ai.allowFallback !== false)
    const r = await this.api<HostedReply>(req.path, { method: req.method, body: req.body })
    if (this.me && typeof r.creditsLeft === 'number') this.me.ai = { creditsLeft: r.creditsLeft, resetsAt: this.me.ai?.resetsAt ?? '' }
    return r
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

  async signOut() { this.s.token = ''; this.ent = null; this.me = null; await this.plugin.saveSettings() }

  /** Revoke every session for this account (all devices), then sign out here. */
  async signOutEverywhere() {
    await this.api('/v1/auth/signout-all', { method: 'POST', body: '{}' })
    await this.signOut()
    new Notice('Signed out on every device')
  }

  async checkout(plan: CheckoutPlan) {
    const r = await this.api<{ url?: string; soon?: boolean }>('/v1/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) })
    if (r?.url) window.open(r.url)
    else new Notice('Checkout is not open yet. Please try again soon.')
  }

  /** Opens the billing portal (cancel, change card or plan). The signed link expires, so fetch it on each click. */
  async manageSubscription() {
    const r = await this.api<{ url?: string }>('/v1/billing/portal', { method: 'POST', body: '{}' })
    if (!r?.url) throw new Error('The billing portal is not available right now')
    window.open(r.url)
  }

  /** Email me when Cloud + AI launches. */
  async notifyAi() {
    await this.api('/v1/notify', { method: 'POST', body: JSON.stringify({ email: this.s.email, topic: 'ai' }) })
    new Notice(`Thanks! We'll email ${this.s.email} when Cloud + AI launches.`)
  }

  /** Download everything Octavo Cloud stores about this account as JSON into the vault. */
  async exportData(): Promise<TFile> {
    const data = await this.api<unknown>('/v1/me/export')
    const path = normalizePath(exportPath(new Date()))
    const folder = path.slice(0, path.lastIndexOf('/'))
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {})
    const json = JSON.stringify(data, null, 2)
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) { await this.app.vault.modify(existing, json); return existing }
    return this.app.vault.create(path, json)
  }

  /** Permanently delete the account. The server refuses (409) while a subscription is active. */
  async deleteAccount(): Promise<boolean> {
    const ok = await new TypeToConfirmModal(this.app, 'Delete your Octavo Cloud account?',
      'This permanently deletes your account, your cloud library and your usage history. Books and highlights in your vault are not touched. If you have an active subscription, cancel it first under Manage subscription.',
      'DELETE', 'Delete account').result()
    if (!ok) return false
    await this.api('/v1/me', { method: 'DELETE' })
    await bookCache.clear().catch(() => {})
    await this.signOut()
    new Notice('Your Octavo Cloud account was deleted')
    return true
  }

  private requireCloud(): boolean {
    if (!this.signedIn) { new Notice('Sign in to Octavo Cloud first, in Octavo Reader settings.'); return false }
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

  /** Place a Cloud book's stub in the chosen folder (Settings → Library) and copy its Cloud collections/tags to the book note. */
  async addStubToVault(b: CloudBook): Promise<TFile> {
    const folder = normalizePath(this.plugin.settings.library.cloudFolder || 'Library')
    const parts = folder.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/')
      if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p).catch(() => {})
    }
    const path = normalizePath(`${folder}/${b.filename}`)
    const existing = this.app.vault.getAbstractFileByPath(path)
    const file = existing instanceof TFile ? existing : await this.app.vault.create(path, makeStub({ id: b.id, size: b.size, title: b.title }))
    if (b.collections?.length || b.tags?.length) await this.applyCloudLabels(file, b).catch(e => console.warn('Octavo: could not apply Cloud labels', e))
    return file
  }

  private async applyCloudLabels(file: TFile, b: CloudBook) {
    const lib = this.plugin.library
    const note = lib.noteFor(file) ?? await lib.ensureNote(file, { id: `cloud-${b.id}`, title: b.title, author: b.author, format: b.format || file.extension })
    const merged = mergeCloudLabels(lib.getProps(note), b)
    await lib.setProps(note, merged)
    // What the Cloud holds now (not the union): a note with local-only labels then differs, and the change event PATCHes them up.
    ;(this.s.labels ??= {})[b.id] = cloudLabelsKey(b)
    await this.plugin.saveSettings()
  }

  // ───────────── collections & tags → Cloud ─────────────

  private labelTimers = new Map<string, number>()

  /** When a Cloud book's note changes, send its collections/tags (debounced, and only when they changed). */
  watchLabels() {
    this.plugin.registerEvent(this.app.metadataCache.on('changed', note => {
      if (!this.signedIn || note.extension !== 'md') return
      const book = this.plugin.library.bookForNote(note)
      if (!book || book.stat.size > STUB_MAX) return
      const prev = this.labelTimers.get(note.path)
      if (prev) window.clearTimeout(prev)
      this.labelTimers.set(note.path, window.setTimeout(() => {
        this.labelTimers.delete(note.path)
        void this.syncLabels(book, note).catch(e => console.warn('Octavo: Cloud label sync failed', e))
      }, 1500))
    }))
    this.plugin.register(() => { for (const t of this.labelTimers.values()) window.clearTimeout(t); this.labelTimers.clear() })
  }

  /** PATCH the note's collections/tags to the Cloud book. Returns true when a request was sent. */
  async syncLabels(book: TFile, note: TFile): Promise<boolean> {
    if (!this.signedIn || book.stat.size > STUB_MAX) return false
    const stub = parseStub(await this.app.vault.read(book))
    if (!stub) return false
    const labels = noteLabels(this.plugin.library.getProps(note))
    const key = labelsKey(labels)
    const sent = (this.s.labels ??= {})
    if (sent[stub.id] === key) return false
    // Never seen this book here: don't wipe labels another device set by sending empty lists.
    if (sent[stub.id] === undefined && !labels.collections.length && !labels.tags.length) { sent[stub.id] = key; return false }
    await this.api(`/v1/library/${stub.id}`, { method: 'PATCH', body: JSON.stringify(labels) })
    sent[stub.id] = key
    await this.plugin.saveSettings()
    return true
  }

  renderSettings(c: HTMLElement, redraw: () => void) {
    if (!this.signedIn) {
      new Setting(c).setName('Account').setDesc('Sign in with your email, no password.')
        .addButton(b => b.setButtonText('Sign in').setCta().onClick(async () => { await this.signIn(); redraw() }))
      return
    }
    const fail = (e: unknown) => new Notice(`Octavo Cloud: ${(e as Error).message}`)
    const st = new Setting(c).setName(this.s.email || 'Signed in').setDesc('Checking plan…')
    st.addButton(b => b.setButtonText('Sign out').onClick(async () => { await this.signOut(); redraw() }))
    const usage = c.createDiv({ cls: 'octavo-account-usage' })
    const plans = c.createDiv()
    const manage = c.createDiv()
    void this.refresh().then(ent => {
      const me = this.me
      st.setDesc(me ? planLine({ ...me, tier: ent?.tier ?? me.tier }) : `Plan: ${planName(ent?.tier)}`)
      if (me) this.renderUsage(usage, me)
      if (!hasCloud(ent?.tier)) this.renderUpgrade(plans)
      else if (me?.isFounder || ent?.tier === 'founder') new Setting(manage).setName('Founder (lifetime)').setDesc('Thank you for backing Octavo. Receipts and billing details are in your receipt email.')
      else new Setting(manage).setName('Manage subscription').setDesc('Cancel, change card or switch between monthly and yearly.')
        .addButton(b => b.setButtonText('Manage subscription').onClick(() => this.manageSubscription().catch(fail)))
      if (ent?.tier === 'cloud' || ent?.tier === 'founder') this.renderAiUpgrade(manage, !!me?.aiForSale)
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
    new Setting(c).setName('Your data').setDesc('Save a copy of everything Octavo Cloud stores about you (JSON) into this vault, under Octavo/.')
      .addButton(b => b.setButtonText('Export my data').onClick(async () => {
        b.setDisabled(true)
        try { const f = await this.exportData(); new Notice(`Saved ${f.path}`) } catch (e) { fail(e) }
        b.setDisabled(false)
      }))
    new Setting(c).setName('Sign out everywhere').setDesc('Ends every Octavo Cloud session on all your devices, including this one.')
      .addButton(b => b.setButtonText('Sign out everywhere').onClick(async () => { try { await this.signOutEverywhere(); redraw() } catch (e) { fail(e) } }))
    new Setting(c).setName('Delete account').setDesc('Permanently delete your Octavo Cloud account and cloud library. Your vault is not touched.')
      .addButton(b => destructive(b.setButtonText('Delete account')).onClick(async () => { try { if (await this.deleteAccount()) redraw() } catch (e) { fail(e) } }))
    new Setting(c).setName('Server').addText(t => t.setValue(this.s.apiBase).onChange(v => { this.s.apiBase = v.trim(); void this.plugin.saveSettings() }))
  }

  /** One-line usage summary plus a small bar per quota. */
  private renderUsage(el: HTMLElement, me: Me) {
    el.empty()
    const meters = usageMeters(me)
    if (!meters.length) return el.remove()
    el.createDiv({ cls: 'setting-item-description', text: `Usage: ${usageLine(me)}` })
    const grid = el.createDiv({ cls: 'octavo-meters' })
    for (const m of meters) {
      const row = grid.createDiv({ cls: 'octavo-meter' })
      row.createSpan({ cls: 'octavo-meter-label', text: m.label })
      const bar = row.createDiv({ cls: 'octavo-meter-bar', attr: { role: 'meter', 'aria-label': m.label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(m.fraction * 100)) } })
      const fill = bar.createDiv({ cls: 'octavo-meter-fill' })
      fill.setCssProps({ '--octavo-meter': `${(m.fraction * 100).toFixed(1)}%` })
      fill.toggleClass('is-high', m.fraction >= 0.9)
      row.createSpan({ cls: 'octavo-meter-value', text: `${m.used} / ${m.limit}` })
    }
  }

  private renderUpgrade(el: HTMLElement) {
    const fail = (e: unknown) => new Notice(`Octavo Cloud: ${(e as Error).message}`)
    new Setting(el).setName('Octavo Cloud').setDesc('$4/month or $36/year. 25 GB library, 500 OCR pages and 300 voice minutes a month, KOReader sync.')
      .addButton(b => b.setButtonText('Yearly').setCta().onClick(() => this.checkout('cloud_yearly').catch(fail)))
      .addButton(b => b.setButtonText('Monthly').onClick(() => this.checkout('cloud_monthly').catch(fail)))
    new Setting(el).setName('Founder (lifetime)').setDesc('$79.99 once. Octavo Cloud for life with a 10 GB library, same OCR and voice limits.')
      .addButton(b => b.setButtonText('Become a founder').onClick(() => this.checkout('founder').catch(fail)))
    this.renderAiUpgrade(el, !!this.me?.aiForSale)
  }

  /** Cloud + AI: buyable once the server has it on sale, otherwise "Notify me". */
  private renderAiUpgrade(el: HTMLElement, forSale: boolean) {
    const fail = (e: unknown) => new Notice(`Octavo Cloud: ${(e as Error).message}`)
    if (!forSale) {
      new Setting(el).setName('Cloud + AI').setDesc('Coming soon. Ask and explain passages, chapter summaries and flashcards, no API key needed.')
        .addButton(b => b.setButtonText('Notify me').onClick(() => this.notifyAi().catch(fail)))
      return
    }
    new Setting(el).setName('Cloud + AI').setDesc('Everything in Octavo Cloud, plus Octavo AI: explain and ask about passages, summaries, chapter notes and flashcards. No API key needed.')
      .addButton(b => b.setButtonText('Yearly').setCta().onClick(() => this.checkout('cloud_ai_yearly').catch(fail)))
      .addButton(b => b.setButtonText('Monthly').onClick(() => this.checkout('cloud_ai_monthly').catch(fail)))
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
    this.modalEl.addClass('octavo-cloud-library')
    if (!this.books.length) this.contentEl.createEl('p', { text: 'Your cloud library is empty. Right-click a book in the file explorer → “Move to Octavo Cloud library”, or email books to your inbox address.' })
    const groups = groupByCollection(this.books)
    const grouped = groups.length > 1 || (groups[0] && groups[0].name !== 'Not in a collection')
    for (const g of groups) {
      if (grouped) {
        const h = new Setting(this.contentEl).setName(g.name).setHeading()
        h.settingEl.addClass('octavo-cloud-group')
        h.setDesc(`${g.books.length} book${g.books.length === 1 ? '' : 's'}`)
      }
      for (const b of g.books) {
        const desc = [b.author, `${(b.size / 1024 / 1024).toFixed(1)} MB`, b.ocr === 'done' ? 'OCR ✓' : b.ocr === 'queued' ? 'OCR running' : null,
          b.tags?.length ? b.tags.map(t => `#${t}`).join(' ') : null].filter(Boolean).join(' · ')
        new Setting(this.contentEl).setName(b.title).setDesc(desc)
          .addButton(x => x.setButtonText('Open').setCta().onClick(async () => {
            const f = await this.client.addStubToVault(b)
            this.close()
            await this.client['plugin'].openInOctavo(f, this.app.workspace.getLeaf('tab'))
          }))
      }
    }
  }
  onClose() { this.contentEl.empty() }
}
