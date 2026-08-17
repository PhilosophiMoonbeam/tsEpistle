export interface AgentOriginConfiguration {
  readonly wikiPublicOrigin: string
  readonly mcpPublicOrigin: string
}

export interface NormalizedAgentOrigins {
  readonly wikiPublicOrigin: string
  readonly mcpPublicOrigin: string | null
}

const parseExactOrigin = (value: string, label: string, required: boolean): string | null => {
  const candidate = value.trim()
  if (candidate.length === 0) {
    if (required) throw new Error(`${label} must be configured`)
    return null
  }

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

export const normalizeAgentOrigins = (configuration: AgentOriginConfiguration): NormalizedAgentOrigins => {
  const wikiPublicOrigin = parseExactOrigin(configuration.wikiPublicOrigin, 'wiki.publicOrigin', true)
  if (wikiPublicOrigin === null) throw new Error('wiki.publicOrigin must be configured')
  const mcpPublicOrigin = parseExactOrigin(configuration.mcpPublicOrigin, 'mcp.publicOrigin', false)

  const configured = [wikiPublicOrigin, mcpPublicOrigin].filter((value): value is string => value !== null)
  if (new Set(configured).size !== configured.length) {
    throw new Error('Wiki and MCP public origins must be distinct')
  }

  return { wikiPublicOrigin, mcpPublicOrigin }
}

export const requestMatchesOriginHost = (hostHeader: string | undefined, origin: string): boolean => {
  if (!hostHeader) return false
  const expected = new URL(origin).host.toLowerCase()
  return hostHeader.trim().toLowerCase() === expected
}

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
