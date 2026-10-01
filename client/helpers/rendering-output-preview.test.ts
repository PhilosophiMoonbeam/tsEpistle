import { describe, expect, it } from '../../server/test/bun-test.mts'
import { buildStoredOutputPreview } from './rendering-output-preview.ts'
describe('isolated stored-output document', () => {
  it('retains document structure while removing active content and resource URLs', () => {
    const html = buildStoredOutputPreview('<h2 id="section">Heading</h2><script>alert(1)</script><img src="https://receiver.test/image" onerror="alert(1)"><a href="https://receiver.test/">Link</a><form action="https://receiver.test/"><input name="secret"></form><iframe src="https://receiver.test/"></iframe><style>body{background:url(https://receiver.test/)}</style><div style="background:url(https://receiver.test/)">Text</div>')
    expect(html).toContain('<h2 id="section">Heading</h2>'); expect(html).toContain('Link'); expect(html).toContain('Text')
    for (const forbidden of ['receiver.test', '<script', '<iframe', '<form', '<input', 'onerror=', 'style="']) expect(html).not.toContain(forbidden)
    expect(html).toContain("default-src 'none'"); expect(html).toContain("form-action 'none'")
  })
})
