/**
 * 产物标记审计 —— build 与 verify 共用。
 *
 * 为什么要容忍 `\uXXXX`：如果哪天客户端改回走打包器，非 ASCII 会被转义成 `\u4E2D` 这种形态，
 * 于是 `includes('中文')` 会漏掉**正确产物**，报出假的"契约漂移"。
 * 判据要容忍两种形态，并把"只在转义形态下命中"这件事单独报出来，而不是静默通过。
 */

/** 把 `\uXXXX` / `\u{XXXXX}` 还原成字符（仅用于比对，不改产物）。 */
export function decodeEscapes(text) {
  return String(text ?? '')
    .replace(/\\u\{([0-9a-fA-F]+)\}/gu, (_whole, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _whole
    })
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_whole, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** 标记是否在场（明文或转义形态皆可）。 */
export function containsMarker(text, needle) {
  const source = String(text ?? '')
  if (source.includes(needle)) return true
  return decodeEscapes(source).includes(needle)
}

/**
 * 批量审计。
 * @param {string} text
 * @param {{label: string, needle: string}[]} required
 * @returns {{missing: {label: string, needle: string}[], escapedOnly: string[]}}
 */
export function auditMarkers(text, required) {
  const source = String(text ?? '')
  const decoded = decodeEscapes(source)
  const missing = []
  const escapedOnly = []
  for (const item of required) {
    if (source.includes(item.needle)) continue
    if (decoded.includes(item.needle)) {
      escapedOnly.push(`${item.label}「${item.needle}」`)
      continue
    }
    missing.push(item)
  }
  return { missing, escapedOnly }
}
