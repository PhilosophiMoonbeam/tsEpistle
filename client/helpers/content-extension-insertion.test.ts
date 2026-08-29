import { describe, expect, it } from '../../server/test/bun-test.mts'
import { contentExtensionFenceBody } from './content-extension-insertion.ts'

const body = '{"key":"qr","version":1,"props":{"value":"https://example.test","size":256,"errorCorrection":"M"}}'

describe('content extension insertion', () => {
  it('returns only the JSON body from a canonical fence', () => {
    expect(contentExtensionFenceBody(`\`\`\`wiki-extension\n${body}\n\`\`\`\n`)).toBe(body)
  })

  it('rejects non-canonical fences', () => {
    expect(() => contentExtensionFenceBody(`\`\`\`wiki-extension\n${body}\n\`\`\``)).toThrow(/canonical/)
    expect(() => contentExtensionFenceBody(`\`\`\`json\n${body}\n\`\`\`\n`)).toThrow(/canonical/)
  })
})
