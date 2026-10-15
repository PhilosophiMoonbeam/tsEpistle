import MarkdownIt from 'markdown-it'
import markdownAttrs from 'markdown-it-attrs'
import { convert } from '@asciidoctor/core'
import { JSDOM } from 'jsdom'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from '../../server/test/bun-test.mts'
import imageSize from '../../shared/markdown-it-image-size'
import { findSourceImage, serializeSourceImage } from './editor-image-source'
import { isSafeEditorImageSource, normalizeEditorImageDimension } from './editor-image-properties'

const markdown = new MarkdownIt().use(imageSize).use(markdownAttrs, { allowedAttributes: ['id', 'class', 'target'] })

describe('source image dirty-field round trips', () => {
  it('retains opaque Markdown title, attrs, escaped label and the untouched dimension', () => {
    const source = '![a \\[bracket\\]](<picture(2).png> "kept title" =320x41%){#figure .custom data-opaque="a b" .align-left}'
    const image = findSourceImage(source, 4, 4, 'markdown')!
    expect(image.title).toBe('kept title')
    expect(image.patch({})).toBe(source)
    const changed = image.patch({ width: '50%', styles: ['rounded'] })!
    expect(changed).toContain('"kept title" =50%x41%')
    expect(changed).toContain('data-opaque="a b"')
    const rendered = JSDOM.fragment(markdown.render(changed)).querySelector('img')!
    expect(rendered.getAttribute('width')).toBe('50%')
    expect(rendered.getAttribute('height')).toBe('41%')
    expect(rendered.classList.contains('custom')).toBe(true)
    expect(rendered.classList.contains('align-left')).toBe(true)
    expect(rendered.classList.contains('wiki-image-rounded')).toBe(true)
  })

  it('edits supported HTML dimensions without losing unknown attrs/classes or allowing old CSS to win', () => {
    const source =
      '<img data-custom=opaque src="/asset.png" alt="a &amp;amp; b" width="80" class="private wiki-image-border align-right" style="width:12px!important;height:40%;--private:kept" title="keep">'
    const image = findSourceImage(source, source.indexOf('asset'), source.indexOf('asset'), 'html')!
    expect(image.properties.alt).toBe('a &amp; b')
    expect(image.properties.align).toBe('right')
    expect(image.patch({})).toBe(source)
    const changed = image.patch({ width: '60%', styles: ['shadow'], alt: '' })!
    expect(changed).toContain('data-custom=opaque')
    expect(changed).toContain('title="keep"')
    const rendered = JSDOM.fragment(changed).querySelector('img')!
    expect(rendered.getAttribute('alt')).toBe('')
    expect(rendered.style.width).toBe('60%')
    expect(rendered.style.height).toBe('40%')
    expect(rendered.style.getPropertyValue('--private')).toBe('kept')
    expect(rendered.className).toBe('private align-right wiki-image-shadow')
  })

  it('keeps opaque CSS intact and refuses a dimension rewrite it cannot represent losslessly', () => {
    const source = '<img src="/a" style="width:var(--private);filter:url(&quot;a;b&quot;)" data-custom="x">'
    const image = findSourceImage(source, 2, 2, 'html')!
    expect(image.patch({ width: '100' })).toBeNull()
    expect(image.patch({ alt: 'label' })).toContain('style="width:var(--private);filter:url(&quot;a;b&quot;)"')
  })

  it('honors named and positional AsciiDoc dimensions while retaining unrelated options', async () => {
    const source = 'image::/asset.png["A, label",320,40%,link="/target",role="private wiki-image-border",align="left"]'
    const image = findSourceImage(source, 12, 12, 'asciidoc')!
    expect(image.patch({})).toBe(source)
    const changed = image.patch({ width: '50%', align: 'center', styles: ['rounded'] })!
    expect(changed).toContain('link="/target"')
    expect(changed).toContain(',40%,')
    const rendered = JSDOM.fragment(String(await convert(changed))).querySelector('img')!
    expect(rendered.getAttribute('width')).toBe('50%')
    expect(rendered.getAttribute('height')).toBe('40%')
    expect(rendered.getAttribute('alt')).toBe('A, label')
    expect(rendered.closest('.imageblock')?.classList.contains('private')).toBe(true)
    expect(rendered.closest('.imageblock')?.classList.contains('wiki-image-rounded')).toBe(true)
  })

  it('inserts all shared image properties and preserves a deliberately empty alt in every mode', async () => {
    const payload = { path: '/asset.png', text: '', width: 'auto', height: '12.5%', align: 'abstopright', styles: ['border', 'shadow'] as const }
    for (const mode of ['markdown', 'html', 'asciidoc'] as const) {
      const source = serializeSourceImage(mode, payload)!
      const image = findSourceImage(source, 0, 0, mode)!
      expect(image.properties).toEqual({ src: '/asset.png', alt: '', width: 'auto', height: '12.5%', align: 'abstopright', styles: ['border', 'shadow'] })
      const rendered = JSDOM.fragment(
        mode === 'markdown' ? markdown.render(source) : mode === 'asciidoc' ? String(await convert(source)) : source
      ).querySelector('img')!
      expect(rendered.getAttribute('alt')).toBe('')
      expect(rendered.getAttribute('width')).toBe('auto')
      expect(rendered.getAttribute('height')).toBe('12.5%')
    }
  })

  it('does not mistake foreign quoted attributes, comments or script text for HTML images', () => {
    for (const source of ['<div title="<img src=\'/a\'>">text</div>', '<!-- <img src="/a"> -->', '<script>const a = \'<img src="/a">\'</script>']) {
      const position = source.indexOf('/a')
      expect(findSourceImage(source, position, position, 'html')).toBeNull()
    }
  })

  it('terminates on malformed opaque closing tags before Visual Markdown can classify the source', () => {
    const moduleUrl = new URL('./editor-image-source.ts', import.meta.url).href
    const child = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      import { findSourceImage } from ${JSON.stringify(moduleUrl)};
      const results = ['<script></script', '<style></style'].map(source =>
        findSourceImage(source, 0, 0, 'markdown'));
      console.log(JSON.stringify(results));
    `
      ],
      { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8' }
    )
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe('[null,null]')
  })

  it('keeps newly authored AsciiDoc attribute references literal instead of creating image links', async () => {
    const attributes = ':label: Photo",link="https://attacker.invalid/\n:target: /replaced.png\n\n'
    const source = 'image::/safe.png["Original",role="private"]'
    const image = findSourceImage(source, 0, 0, 'asciidoc')!
    const patched = image.patch({ alt: '{label}' })!
    const rendered = JSDOM.fragment(String(await convert(attributes + patched, { safe: 'secure', standalone: false })))
    expect(rendered.querySelector('img')?.getAttribute('alt')).toBe('{label}')
    expect(rendered.querySelector('a')).toBeNull()
    expect(rendered.querySelector('img')?.closest('.imageblock')?.classList.contains('private')).toBe(true)
    const inserted = serializeSourceImage('asciidoc', { path: '/{target}.png', text: '{label}' })!
    const insertedDom = JSDOM.fragment(String(await convert(attributes + inserted, { safe: 'secure', standalone: false })))
    expect(insertedDom.querySelector('img')?.getAttribute('alt')).toBe('{label}')
    expect(insertedDom.querySelector('img')?.getAttribute('src')).toBe('/{target}.png')
    expect(insertedDom.querySelector('a')).toBeNull()
    expect(findSourceImage(inserted, 0, 0, 'asciidoc')?.properties).toMatchObject({ src: '/{target}.png', alt: '{label}' })
    const native = 'image::{target}["{label}",role="private"]'
    expect(findSourceImage(native, 0, 0, 'asciidoc')!.patch({})).toBe(native)
  })

  it('bounds new source input without rejecting opaque existing values on unrelated patches', () => {
    for (const source of ['javascript:alert(1)', 'data:image/svg+xml,x', 'https://user:pass@example.test/a', '/a\n.png'])
      expect(isSafeEditorImageSource(source)).toBe(false)
    for (const dimension of ['0', '-1', '16385', '101%', 'calc(1px)', '1.5px']) expect(normalizeEditorImageDimension(dimension)).toBeNull()
    expect(normalizeEditorImageDimension(' 120px ')).toBe('120')
    const image = findSourceImage('<img src="opaque:existing" width="unrepresentable" data-private="x">', 2, 2, 'html')!
    expect(image.patch({ alt: 'label' })).toContain('src="opaque:existing" width="unrepresentable" data-private="x"')
  })
})
