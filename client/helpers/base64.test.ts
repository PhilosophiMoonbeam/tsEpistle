import { describe, expect, it } from '../../server/test/bun-test.mts'
import { decodeBase64Json, decodeBase64Text } from './base64'

describe('browser base64 decoding', () => {
  it('decodes UTF-8 text without a Node Buffer global', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
    Object.defineProperty(globalThis, 'Buffer', { configurable: true, writable: true, value: undefined })
    try {
      expect(decodeBase64Text('SGVsbG8sIPCfk4Q=')).toBe('Hello, 📄')
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'Buffer', descriptor)
      else Reflect.deleteProperty(globalThis, 'Buffer')
    }
  })

  it('decodes typed JSON payloads', () => {
    expect(decodeBase64Json<{ pages: { write: boolean } }>('eyJwYWdlcyI6eyJ3cml0ZSI6dHJ1ZX19')).toEqual({
      pages: { write: true }
    })
  })
})
