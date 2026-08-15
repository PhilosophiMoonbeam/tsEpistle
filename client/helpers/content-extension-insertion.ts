import {
  parseContentExtensionFence,
  serializeContentExtensionFence
} from '../../shared/content-extensions.ts'

const FENCE_START = '```wiki-extension\n'
const FENCE_END = '\n```\n'

export function contentExtensionFenceBody (fence: string): string {
  if (!fence.startsWith(FENCE_START) || !fence.endsWith(FENCE_END)) {
    throw new Error('Content extension insertion must be a canonical wiki-extension fence.')
  }

  const body = fence.slice(FENCE_START.length, -FENCE_END.length)
  const envelope = parseContentExtensionFence(body)
  const canonicalFence = serializeContentExtensionFence(envelope)
  if (canonicalFence !== fence) {
    throw new Error('Content extension insertion must use the canonical fence format.')
  }
  return body
}
