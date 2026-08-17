const MCP_PATH = '/mcp'

const parseExactOrigin = (value: string, label: string): string => {
  const candidate = value.trim()
  if (candidate.length === 0) throw new Error(`${label} must be configured`)

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`${label} must be an absolute URL origin`)
  }

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error(`${label} must use HTTPS except on loopback development hosts`)
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`)
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(`${label} must not contain a path, query, or fragment`)

  const normalized = parsed.origin
  if (candidate.replace(/\/$/, '') !== normalized) throw new Error(`${label} must use its canonical origin serialization`)
  return normalized
}

export const canonicalMcpResource = (wikiPublicOrigin: string): URL => new URL(MCP_PATH, parseExactOrigin(wikiPublicOrigin, 'wiki.publicOrigin'))


export const requestOriginMatches = (originHeader: string | undefined, expectedOrigin: string): boolean => {
  if (!originHeader) return false
  try {
    const supplied = new URL(originHeader)
    const expected = new URL(expectedOrigin)
    return originHeader === supplied.origin && supplied.origin === expected.origin
  } catch {
    return false
  }
}
