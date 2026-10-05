import { App, Modal, setIcon } from 'obsidian'

export interface SignInSteps {
  start(email: string): Promise<void>
  /** Verifies the code and returns a plan label, e.g. "Cloud" or "Free". */
  verify(email: string, code: string): Promise<string>
}

/**
 * One dialog for the whole sign-in: email → 6-digit code → done.
 * Enter submits, the code auto-submits at 6 digits, errors show inline.
 */
export class SignInModal extends Modal {
  private email: string
  private resolve!: (signedIn: boolean) => void
  private promise = new Promise<boolean>(r => (this.resolve = r))
  private ok = false

  constructor(app: App, email: string, private steps: SignInSteps) {
    super(app)
    this.email = email
    this.modalEl.addClass('octavo-signin')
  }

  result() { this.open(); return this.promise }
  onOpen() { this.emailStep() }
  onClose() { this.resolve(this.ok); this.contentEl.empty() }

  private frame(title: string, lede: string) {
    this.contentEl.empty()
    this.setTitle(title)
    this.contentEl.createEl('p', { cls: 'octavo-signin-lede', text: lede })
    const form = this.contentEl.createEl('form', { cls: 'octavo-signin-form' })
    const err = this.contentEl.createDiv({ cls: 'octavo-signin-err', attr: { role: 'alert' } })
    return { form, err }
  }

  private busy(btn: HTMLButtonElement, on: boolean, label: string) {
    btn.disabled = on
    btn.setText(on ? label : btn.dataset.label ?? '')
  }

  private emailStep(error = '') {
    const { form, err } = this.frame('Sign in to Octavo Cloud', 'We’ll email you a 6-digit code. No password. Bought Octavo on the website? Use the same email.')
    const input = form.createEl('input', { type: 'email', value: this.email, attr: { placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email', required: 'true' } })
    const btn = form.createEl('button', { cls: 'mod-cta', text: 'Send code', attr: { type: 'submit', 'data-label': 'Send code' } })
    err.setText(error)
    form.addEventListener('submit', async e => {
      e.preventDefault()
      const email = input.value.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.setText('Enter a valid email address.'); input.focus(); return }
      err.setText(''); this.busy(btn, true, 'Sending…')
      try { await this.steps.start(email); this.email = email; this.codeStep() }
      catch (x) { this.busy(btn, false, ''); err.setText((x as Error).message) }
    })
    window.setTimeout(() => { input.focus(); input.select() })
  }

  private codeStep() {
    const { form, err } = this.frame('Check your email', `We sent a 6-digit code to ${this.email}. It expires in 15 minutes.`)
    const input = form.createEl('input', { cls: 'octavo-signin-code', type: 'text', attr: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '123456', 'aria-label': '6-digit code' } })
    const btn = form.createEl('button', { cls: 'mod-cta', text: 'Sign in', attr: { type: 'submit', 'data-label': 'Sign in' } })
    const links = this.contentEl.createDiv({ cls: 'octavo-signin-links' })
    const resend = links.createEl('a', { text: 'Resend code', href: '#' })
    links.createEl('a', { text: 'Use a different email', href: '#' }).addEventListener('click', e => { e.preventDefault(); this.emailStep() })
    resend.addEventListener('click', async e => {
      e.preventDefault()
      try { await this.steps.start(this.email); err.setText(''); resend.setText('Code sent ✓') }
      catch (x) { err.setText((x as Error).message) }
    })
    const submit = async () => {
      const code = input.value.replace(/\D/g, '')
      if (code.length !== 6) { err.setText('Enter the 6 digits from the email.'); return }
      err.setText(''); this.busy(btn, true, 'Checking…')
      try { this.doneStep(await this.steps.verify(this.email, code)) }
      catch (x) { this.busy(btn, false, ''); err.setText((x as Error).message); input.select() }
    }
    form.addEventListener('submit', e => { e.preventDefault(); void submit() })
    input.addEventListener('input', () => { if (input.value.replace(/\D/g, '').length === 6 && !btn.disabled) void submit() })
    window.setTimeout(() => input.focus())
  }

  private doneStep(plan: string) {
    this.ok = true
    this.contentEl.empty()
    this.setTitle('You’re signed in')
    const box = this.contentEl.createDiv({ cls: 'octavo-signin-done' })
    setIcon(box.createDiv({ cls: 'octavo-signin-tick' }), 'check')
    box.createEl('p', { text: this.email })
    box.createEl('p', { cls: 'octavo-signin-plan', text: plan === 'Free' ? 'Plan: Free' : `Plan: ${plan} — active` })
    if (plan === 'Free') box.createEl('p', { cls: 'octavo-signin-lede', text: 'Paid on the website with another email? Sign out and use that one.' })
    const btn = this.contentEl.createDiv({ cls: 'octavo-signin-form' }).createEl('button', { cls: 'mod-cta', text: 'Done' })
    btn.addEventListener('click', () => this.close())
    window.setTimeout(() => btn.focus())
  }
}
