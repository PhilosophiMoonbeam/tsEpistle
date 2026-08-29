import { describe, expect, it } from '../../server/test/bun-test.mts'
import { decodeBase64Json, decodeBase64Text } from './base64'

describe('browser base64 decoding', () => {
  it('decodes UTF-8 text without a Node Buffer global', () => {
    expect(decodeBase64Text('SGVsbG8sIPCfk4Q=')).toBe('Hello, 📄')
  })

  it('decodes typed JSON payloads', () => {
    expect(decodeBase64Json<{ pages: { write: boolean } }>('eyJwYWdlcyI6eyJ3cml0ZSI6dHJ1ZX19')).toEqual({
      pages: { write: true }
    })
  })
})
