import type { MarkdownIt, Token } from 'markdown-it'

import {
  parseContentExtensionFence,
  serializeContentExtensionFence,
  type ContentExtensionEnvelope
} from '../../shared/content-extensions.ts'
import { listContentExtensions } from './operations.ts'
import { getContentExtensionRegistration } from './registry.ts'

export type PreparedContentExtensionFences = ReadonlyMap<string, string>

const canonicalBody = (body: string): ContentExtensionEnvelope | null => {
  try {
    const envelope = parseContentExtensionFence(body)
    const canonicalLine = serializeContentExtensionFence(envelope).split('\n')[1]
    return canonicalLine !== undefined && body === `${canonicalLine}\n` ? envelope : null
  } catch {
    return null
  }
}

export const prepareContentExtensionFences = async (tokens: readonly Token[]): Promise<PreparedContentExtensionFences> => {
  const bodies = new Set(
    tokens
      .filter(token => token.type === 'fence' && token.info.trim() === 'wiki-extension')
      .map(token => token.content)
  )
  if (bodies.size === 0) return new Map()

  const status = await listContentExtensions()
  const statusByKey = new Map(status.extensions.map(extension => [extension.key, extension]))
  const prepared = new Map<string, string>()
  for (const body of bodies) {
    const envelope = canonicalBody(body)
    if (!envelope) continue
    const extensionStatus = statusByKey.get(envelope.key)
    const registration = getContentExtensionRegistration(envelope.key)
    if (!extensionStatus?.isEnabled || !extensionStatus.compatible || !registration) continue
    if (registration.definition.version !== envelope.version) continue
    try {
      prepared.set(body, `${await registration.render(envelope)}\n`)
    } catch {
      // A renderer failure is fail-closed: the original escaped source remains visible.
    }
  }
  return prepared
}

export const installContentExtensionFenceRule = (
  markdown: MarkdownIt,
  prepared: PreparedContentExtensionFences
): void => {
  const ordinaryFence = markdown.renderer.rules.fence
  if (!ordinaryFence) throw new TypeError('markdown-it fence renderer is unavailable')
  markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index]
    if (token?.info.trim() === 'wiki-extension') {
      const rendered = prepared.get(token.content)
      if (rendered !== undefined) return rendered
    }
    return ordinaryFence(tokens, index, options, env, renderer)
  }
}
