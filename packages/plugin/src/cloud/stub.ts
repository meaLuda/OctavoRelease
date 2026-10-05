/**
 * A cloud book leaves a tiny stub in the vault under the book's own name, so
 * every link, highlight and backlink keeps working and the stub syncs under
 * any sync service's file-size limit. Octavo swaps in the real file from the
 * device cache or the cloud when the book is opened.
 */
export interface CloudStub { 'octavo-cloud': 1; id: string; size: number; title: string; sha256?: string; note: string }

export const STUB_MAX = 4096

export function makeStub(s: Omit<CloudStub, 'octavo-cloud' | 'note'>): string {
  const stub: CloudStub = { 'octavo-cloud': 1, ...s, note: 'This book is stored in Octavo Cloud. Open it in Obsidian with Octavo to read it.' }
  return JSON.stringify(stub, null, 2)
}

export function parseStub(text: string): CloudStub | null {
  if (text.length > STUB_MAX || !text.trimStart().startsWith('{')) return null
  try {
    const j = JSON.parse(text)
    return j && j['octavo-cloud'] === 1 && typeof j.id === 'string' ? j : null
  } catch { return null }
}
