import { readFileSync } from 'node:fs'
import path from 'node:path'

const MAX_SOUL_BYTES = 4_096
const containsForbiddenControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) return true
  }
  return false
}
const ROLE_FENCE = /<\/?\s*(?:system|developer|assistant|tool)\b/iu

export const loadWikiAgentSoul = (source = readFileSync(path.resolve(process.cwd(), 'server/agents/SOUL.md'), 'utf8')): string => {
  const soul = source.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n').trim()
  if (soul.length === 0) throw new Error('Wiki Agent SOUL.md must not be empty')
  if (Buffer.byteLength(soul, 'utf8') > MAX_SOUL_BYTES) throw new Error(`Wiki Agent SOUL.md exceeds ${MAX_SOUL_BYTES} bytes`)
  if (containsForbiddenControl(soul) || ROLE_FENCE.test(soul)) throw new Error('Wiki Agent SOUL.md contains unsafe control text')
  return soul
}

export const WIKI_AGENT_SOUL = loadWikiAgentSoul()
