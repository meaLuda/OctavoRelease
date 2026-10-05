/** Minimal Lua table-literal parser for KOReader sidecars (`return { … }`). */
export function parseLuaTable(src: string): unknown {
  let i = src.indexOf('return')
  i = i < 0 ? 0 : i + 6
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++
      if (src.startsWith('--', i)) { while (i < src.length && src[i] !== '\n') i++ } else break
    }
  }
  const str = (): string => {
    const q = src[i]!
    if (q === '[') { // long string [[…]] / [=[…]=]
      const m = /^\[(=*)\[/.exec(src.slice(i))!
      const close = `]${m[1]}]`
      const end = src.indexOf(close, i + m[0].length)
      const s = src.slice(i + m[0].length, end)
      i = end + close.length
      return s.replace(/^\n/, '')
    }
    i++
    let out = ''
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const n = src[++i]!
        const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '\n': '\n', a: '\x07', b: '\b', f: '\f', v: '\v' }
        if (/\d/.test(n)) { const m = /^\d{1,3}/.exec(src.slice(i))![0]; out += String.fromCharCode(+m); i += m.length; continue }
        out += esc[n] ?? n; i++
      } else out += src[i++]
    }
    i++
    // KOReader writes UTF-8 bytes as \ddd escapes; re-decode as UTF-8
    try { return decodeURIComponent(escape(out)) } catch { return out }
  }
  const value = (): unknown => {
    ws()
    const c = src[i]
    if (c === '{') return table()
    if (c === '"' || c === "'" || (c === '[' && /^\[=*\[/.test(src.slice(i)))) return str()
    const m = /^(-?0x[0-9a-f]+|-?\d+\.?\d*(?:e[+-]?\d+)?|true|false|nil)/i.exec(src.slice(i))
    if (!m) throw new Error(`lua: unexpected '${c}' at ${i}`)
    i += m[0].length
    const t = m[0]
    return t === 'true' ? true : t === 'false' ? false : t === 'nil' ? null : Number(t)
  }
  const table = (): unknown => {
    i++ // {
    const obj: Record<string, unknown> = {}
    const arr: unknown[] = []
    let isArr = true
    for (;;) {
      ws()
      if (src[i] === '}') { i++; break }
      let key: string | number | undefined
      if (src[i] === '[' && !/^\[=*\[/.test(src.slice(i))) {
        i++; const k = value(); ws(); i++ // ]
        ws(); i++ // =
        key = k as string | number
      } else {
        const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(src.slice(i))
        if (m) { key = m[1]!; i += m[0].length }
      }
      const v = value()
      if (key === undefined) arr.push(v)
      else { obj[String(key)] = v; if (typeof key !== 'number') isArr = false }
      ws()
      if (src[i] === ',' || src[i] === ';') i++
    }
    if (arr.length && !Object.keys(obj).length) return arr
    if (isArr && Object.keys(obj).length) {
      const keys = Object.keys(obj).map(Number).sort((a, b) => a - b)
      if (keys.every((k, j) => k === j + 1)) return keys.map(k => obj[k])
    }
    for (const [j, v] of arr.entries()) obj[j + 1] = v
    return obj
  }
  return value()
}
