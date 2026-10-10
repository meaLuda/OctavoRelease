/** In-app Octavo Cloud hints: pure "show at most once per book" logic (unit-tested; no Obsidian imports). */

export type PromptKind = 'big' | 'scan' | 'voice'

/** Obsidian Sync Standard's per-file limit. */
export const SYNC_LIMIT_BYTES = 5 * 1024 * 1024
/** Keep the remembered list bounded; the oldest entries fall off. */
export const MAX_SEEN = 500

export interface PromptSettings { cloudPrompts: boolean; promptsSeen: string[] }

export interface PromptContext {
  /** File size in bytes (the vault copy; a cloud placeholder is tiny). */
  size?: number
  /** The file is already a cloud placeholder. */
  isStub?: boolean
  /** Read-aloud is about to use the system voice. */
  systemVoice?: boolean
}

export const promptKey = (kind: PromptKind, bookId: string) => `${kind}:${bookId}`

export function shouldPrompt(s: PromptSettings, kind: PromptKind, bookId: string, ctx: PromptContext = {}): boolean {
  if (!s.cloudPrompts || !bookId) return false
  if (s.promptsSeen.includes(promptKey(kind, bookId))) return false
  if (kind === 'big') return !ctx.isStub && (ctx.size ?? 0) > SYNC_LIMIT_BYTES
  if (kind === 'voice') return ctx.systemVoice === true
  return true
}

/** Records a prompt as shown; returns the new list (deduplicated, bounded). */
export function markPrompted(seen: string[], kind: PromptKind, bookId: string): string[] {
  const key = promptKey(kind, bookId)
  const next = seen.filter(k => k !== key)
  next.push(key)
  return next.length > MAX_SEEN ? next.slice(next.length - MAX_SEEN) : next
}

export interface PromptCopy { text: string; action: string }

/** Banner text and main action for each moment, depending on whether the reader has Cloud. */
export function promptCopy(kind: PromptKind, onCloud: boolean, isStub = false): PromptCopy {
  if (kind === 'big') return onCloud
    ? { text: 'Over Obsidian Sync\'s 5 MB limit? Keep this book in Octavo Cloud.', action: 'Move to Octavo Cloud' }
    : { text: 'Over Obsidian Sync\'s 5 MB limit? Keep it in Octavo Cloud.', action: 'Learn more' }
  if (kind === 'scan') return onCloud
    ? (isStub ? { text: 'This looks like a scan. Make it searchable with OCR.', action: 'Run OCR' }
      : { text: 'This looks like a scan. Move it to Octavo Cloud to make it searchable with OCR.', action: 'Move to Octavo Cloud' })
    : { text: 'Make this scan searchable with OCR (Cloud).', action: 'Learn more' }
  return onCloud
    ? { text: 'Natural voices are included in your Octavo Cloud plan.', action: 'Use natural voices' }
    : { text: 'Natural voices with Octavo Cloud.', action: 'Learn more' }
}
