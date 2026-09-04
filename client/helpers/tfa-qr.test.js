import { sanitizeTfaQrImage } from './tfa-qr.ts'

const validQrSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 3"><path d="M0 0h3v3H0z"/></svg>'

describe('TFA QR image sanitization', () => {
  it('preserves the single-path square SVG emitted by the QR generator', () => {
    const sanitized = sanitizeTfaQrImage(validQrSvg)

    expect(sanitized).toContain('<svg')
    expect(sanitized).toContain('viewBox="0 0 3 3"')
    expect(sanitized).toContain('<path d="M0 0h3v3H0z"')
  })

  it('removes executable SVG content and attributes', () => {
    const sanitized = sanitizeTfaQrImage(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 3"><script>alert(1)</script><path d="M0 0h3v3H0z" onclick="alert(1)" data-payload="unsafe"/></svg>'
    )

    expect(sanitized).not.toContain('script')
    expect(sanitized).not.toContain('onclick')
    expect(sanitized).not.toContain('data-payload')
  })

  it('rejects malformed or structurally unexpected QR images', () => {
    expect(sanitizeTfaQrImage('')).toBe('')
    expect(sanitizeTfaQrImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 4"><path d="M0 0h3v3H0z"/></svg>')).toBe('')
    expect(sanitizeTfaQrImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 3"><path d="a"/><path d="b"/></svg>')).toBe('')
    expect(sanitizeTfaQrImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 3"><path/></svg>')).toBe('')
  })
})
