/** AsciiDoc listing, literal, passthrough and comment blocks must never become authoring targets. */
export function isAsciiDocLiteralPosition(source: string, position: number): boolean {
  let delimiter = ''
  for (const line of source.slice(0, position).split('\n')) {
    const trimmed = line.trim()
    if (delimiter) {
      if (trimmed === delimiter) delimiter = ''
    } else if (/^(?:-{4,}|\.{4,}|\+{4,}|\/{4,})$/.test(trimmed)) delimiter = trimmed
  }
  if (delimiter) return true
  const current = source.slice(source.lastIndexOf('\n', position - 1) + 1, position)
  if (/^(?:[ \t]|\/\/)/.test(current)) return true
  let ticks = 0
  for (let index = 0; index < current.length; index++) {
    if (current[index] === '\\') index++
    else if (current[index] === '`') ticks++
  }
  return ticks % 2 === 1
}
