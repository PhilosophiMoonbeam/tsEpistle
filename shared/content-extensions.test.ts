import { describe, expect, it } from 'vitest'
import * as contentExtensions from './content-extensions.ts'
import {
  BUILTIN_CONTENT_EXTENSIONS,
  CONTENT_EXTENSION_HOST_VERSION,
  KROKI_DIAGRAM_TYPES,
  contentExtensionCompatibility,
  isContentExtensionKey,
  isSafeContentExtensionAssetPath,
  parseContentExtensionEnvelope,
  parseContentExtensionFence,
  serializeContentExtensionFence,
  type ContentExtensionDefinition
} from './content-extensions.ts'

const canonicalFence = '```wiki-extension\n{"key":"qr","version":1,"props":{"value":"https://example.com","label":"Example","size":512,"errorCorrection":"H"}}\n```\n'
const canonicalBody = '{"key":"qr","version":1,"props":{"value":"https://example.com","label":"Example","size":512,"errorCorrection":"H"}}'

const qr = (input: unknown) => {
  const envelope = parseContentExtensionEnvelope(input)
  if (envelope.key !== 'qr') throw new TypeError('Expected QR envelope.')
  return envelope
}

const gallery = (input: unknown) => {
  const envelope = parseContentExtensionEnvelope(input)
  if (envelope.key !== 'gallery') throw new TypeError('Expected gallery envelope.')
  return envelope
}

const index = (input: unknown) => {
  const envelope = parseContentExtensionEnvelope(input)
  if (envelope.key !== 'index') throw new TypeError('Expected index envelope.')
  return envelope
}

describe('content extension contract', () => {
  it('exports only the shared runtime contract', () => {
    expect(Object.keys(contentExtensions).sort()).toEqual([
      'BUILTIN_CONTENT_EXTENSIONS',
      'CONTENT_EXTENSION_HOST_VERSION',
      'KROKI_DIAGRAM_TYPES',
      'contentExtensionCompatibility',
      'isContentExtensionKey',
      'isSafeContentExtensionAssetPath',
      'parseContentExtensionEnvelope',
      'parseContentExtensionFence',
      'serializeContentExtensionFence'
    ])
  })

  it('declares the complete built-in extension catalog', () => {
    expect(CONTENT_EXTENSION_HOST_VERSION).toBe(1)
    expect(BUILTIN_CONTENT_EXTENSIONS.map(extension => extension.key)).toEqual([
      'qr', 'gallery', 'index', 'tabs', 'spoiler', 'infobox', 'pdf', 'media', 'youtube', 'diagram', 'kroki', 'plantuml', 'map'
    ])
    expect(new Set(BUILTIN_CONTENT_EXTENSIONS.map(extension => extension.icon)).size).toBeGreaterThan(8)
    expect(BUILTIN_CONTENT_EXTENSIONS.every(extension => extension.version === 1)).toBe(true)
    expect(isContentExtensionKey('plantuml')).toBe(true)
    expect(isContentExtensionKey('future')).toBe(false)
    expect(KROKI_DIAGRAM_TYPES).toContain('graphviz')
  })

  it('serializes in canonical property order and round trips the JSON fence body', () => {
    const envelope = parseContentExtensionFence(canonicalBody)
    expect(serializeContentExtensionFence(envelope)).toBe(canonicalFence)
    expect(parseContentExtensionFence(canonicalBody)).toEqual(envelope)
    expect(serializeContentExtensionFence(envelope).endsWith('\n')).toBe(true)
  })

  it('applies QR defaults and writes them into canonical source', () => {
    const envelope = qr({ props: { value: 'hello' }, version: 1, key: 'qr' })
    expect(envelope).toEqual({ key: 'qr', version: 1, props: { value: 'hello', size: 256, errorCorrection: 'M' } })
    expect(serializeContentExtensionFence(envelope)).toBe(
      '```wiki-extension\n{"key":"qr","version":1,"props":{"value":"hello","size":256,"errorCorrection":"M"}}\n```\n'
    )
  })

  it('parses the JSON body independently and preserves the observable source bytes', () => {
    const source = `  ${canonicalBody}\n`
    const original = source
    const envelope = parseContentExtensionFence(source)
    expect(envelope.key).toBe('qr')
    if (envelope.key === 'qr') expect(envelope.props.value).toBe('https://example.com')
    expect(source).toBe(original)
    expect(() => parseContentExtensionFence(canonicalFence)).toThrow(/exactly one valid JSON object/)
  })

  it.each([1, 2048])('accepts QR value boundary length %s', (length) => {
    const value = 'x'.repeat(length)
    expect(qr({ key: 'qr', version: 1, props: { value } }).props.value).toBe(value)
  })

  it.each([128, 1024])('accepts QR size boundary %s', (size) => {
    expect(qr({ key: 'qr', version: 1, props: { value: 'x', size } }).props.size).toBe(size)
  })

  it.each([127, 1025, Number.NaN])('rejects invalid QR size %s', (size) => {
    expect(() => qr({ key: 'qr', version: 1, props: { value: 'x', size } })).toThrow(/128 to 1024/)
  })

  it('accepts QR label and correction boundaries', () => {
    expect(qr({ key: 'qr', version: 1, props: { value: 'x', label: 'a'.repeat(200), errorCorrection: 'H' } }).props)
      .toMatchObject({ label: 'a'.repeat(200), errorCorrection: 'H' })
    expect(() => qr({ key: 'qr', version: 1, props: { value: 'x', label: 'a'.repeat(201) } })).toThrow(/200 characters/)
    expect(() => qr({ key: 'qr', version: 1, props: { value: 'x', errorCorrection: 'medium' } })).toThrow(/one of "L", "M", "Q", or "H"/)
  })

  it('normalizes gallery defaults and preserves natural aspect ratio explicitly', () => {
    const envelope = gallery({
      key: 'gallery',
      version: 1,
      props: { images: [{ src: '/uploads/launch.jpg', alt: 'Launch', caption: 'First flight' }], aspectRatio: 'natural' }
    })
    expect(envelope.props).toEqual({
      images: [{ src: '/uploads/launch.jpg', alt: 'Launch', caption: 'First flight' }],
      columns: 3,
      fit: 'cover',
      aspectRatio: 'natural'
    })
    expect(serializeContentExtensionFence(envelope)).toBe(
      '```wiki-extension\n{"key":"gallery","version":1,"props":{"images":[{"src":"/uploads/launch.jpg","alt":"Launch","caption":"First flight"}],"columns":3,"fit":"cover","aspectRatio":"natural"}}\n```\n'
    )
  })

  it('enforces gallery count, text, enum, and internal-asset boundaries', () => {
    const image = { src: '/uploads/a.jpg', alt: 'A' }
    expect(gallery({ key: 'gallery', version: 1, props: { images: Array.from({ length: 50 }, () => image), columns: 4, fit: 'contain' } }).props.images).toHaveLength(50)
    expect(() => gallery({ key: 'gallery', version: 1, props: { images: [] } })).toThrow(/between 1 and 50/)
    expect(() => gallery({ key: 'gallery', version: 1, props: { images: [image], columns: 5 } })).toThrow(/1 to 4/)
    expect(() => gallery({ key: 'gallery', version: 1, props: { images: [{ src: 'https://example.test/a.jpg', alt: 'A' }] } })).toThrow(/same-origin/)
    expect(() => gallery({ key: 'gallery', version: 1, props: { images: [{ src: '/uploads/a.jpg', alt: '' }] } })).toThrow(/between 1 and 200/)
    expect(() => gallery({ key: 'gallery', version: 1, props: { images: [image], aspectRatio: false } })).toThrow(/square.*natural/)
  })

  it.each([
    ['/uploads/a.jpg', true],
    ['/_assets/svg/icon-image.svg', true],
    ['/folder/a%20b.png', true],
    ['https://example.test/a.jpg', false],
    ['//example.test/a.jpg', false],
    ['/_api/assets/1', false],
    ['/uploads/../secret', false],
    ['/uploads/%2e%2e/secret', false],
    ['/uploads/a.jpg?token=secret', false],
    ['/uploads/a.jpg#fragment', false]
  ])('classifies gallery asset path %s', (value, safe) => {
    expect(isSafeContentExtensionAssetPath(value)).toBe(safe)
  })

  it('normalizes a policy-filtered page index and serializes its responsive column ceiling', () => {
    const envelope = index({ key: 'index', version: 1, props: { path: 'guide', locale: 'en', columns: 3, showIcons: true } })
    expect(envelope.props).toEqual({
      path: 'guide',
      locale: 'en',
      depth: 0,
      columns: 3,
      showIcons: true,
      order: 'path',
      limit: 50
    })
    expect(serializeContentExtensionFence(envelope)).toContain('"columns":3,"showIcons":true,"order":"path","limit":50')
  })

  it('enforces page index path, depth, order, limit, and boolean boundaries', () => {
    expect(index({ key: 'index', version: 1, props: { path: '', locale: 'en', depth: 5, limit: 200 } }).props.path).toBe('')
    expect(() => index({ key: 'index', version: 1, props: { path: '/guide', locale: 'en' } })).toThrow(/normalized page path/)
    expect(() => index({ key: 'index', version: 1, props: { path: 'guide/', locale: 'en' } })).toThrow(/normalized page path/)
    expect(() => index({ key: 'index', version: 1, props: { path: 'guide', locale: 'e' } })).toThrow(/locale code/)
    expect(() => index({ key: 'index', version: 1, props: { path: 'guide', locale: 'en', depth: 6 } })).toThrow(/0 to 5/)
    expect(() => index({ key: 'index', version: 1, props: { path: 'guide', locale: 'en', order: 'random' } })).toThrow(/path.*title.*updated/)
    expect(() => index({ key: 'index', version: 1, props: { path: 'guide', locale: 'en', limit: 201 } })).toThrow(/1 to 200/)
    expect(() => index({ key: 'index', version: 1, props: { path: 'guide', locale: 'en', showIcons: 'false' } })).toThrow(/boolean/)
  })

  it.each([
    {
      key: 'tabs',
      props: { tabs: [{ label: 'First', content: 'Alpha' }, { label: 'Second', content: 'Beta' }] },
      expected: { active: 0 }
    },
    {
      key: 'spoiler',
      props: { content: 'Hidden' },
      expected: { label: 'Spoiler', hint: 'Show hidden content' }
    },
    {
      key: 'infobox',
      props: { title: 'City', facts: [{ label: 'Metro', value: true }] },
      expected: { facts: [{ label: 'Metro', value: true }] }
    },
    {
      key: 'pdf',
      props: { src: '/uploads/guide.pdf' },
      expected: { title: 'PDF document', page: 1, height: 720 }
    },
    {
      key: 'media',
      props: { kind: 'video', src: '/uploads/demo.mp4' },
      expected: { title: 'Video player' }
    },
    {
      key: 'youtube',
      props: { videoId: 'abc123_DEF' },
      expected: { title: 'YouTube video', start: 0, controls: true }
    },
    {
      key: 'diagram',
      props: { source: 'flowchart LR\nA-->B' },
      expected: { theme: 'auto', align: 'left' }
    },
    {
      key: 'kroki',
      props: { type: 'graphviz', source: 'digraph{a->b}' },
      expected: { format: 'svg', align: 'left' }
    },
    {
      key: 'plantuml',
      props: { source: '@startuml\nA->B\n@enduml' },
      expected: { format: 'svg', align: 'left' }
    },
    {
      key: 'map',
      props: { latitude: 45.5, longitude: -73.5 },
      expected: { zoom: 13, height: 400 }
    }
  ])('normalizes and canonically round trips the $key extension', ({ key, props, expected }) => {
    const envelope = parseContentExtensionEnvelope({ key, version: 1, props })
    expect(envelope.props).toMatchObject(expected)
    const canonical = serializeContentExtensionFence(envelope)
    expect(parseContentExtensionFence(canonical.split('\n')[1]!)).toEqual(envelope)
  })

  it('enforces static, media, diagram, and map security boundaries', () => {
    expect(() => parseContentExtensionEnvelope({
      key: 'tabs',
      version: 1,
      props: { tabs: [{ label: 'Only', content: 'one' }] }
    })).toThrow(/between 2 and 12/)
    expect(() => parseContentExtensionEnvelope({
      key: 'infobox',
      version: 1,
      props: { title: 'Unsafe', image: 'https://evil.test/a.jpg', imageAlt: 'A', facts: [{ label: 'A', value: 'B' }] }
    })).toThrow(/same-origin/)
    expect(() => parseContentExtensionEnvelope({ key: 'pdf', version: 1, props: { src: '/uploads/not-pdf.txt' } })).toThrow(/PDF asset/)
    expect(() => parseContentExtensionEnvelope({ key: 'media', version: 1, props: { kind: 'audio', src: '/a.mp3', poster: '/poster.jpg' } })).toThrow(/only for video/)
    expect(() => parseContentExtensionEnvelope({ key: 'youtube', version: 1, props: { videoId: 'javascript:alert(1)' } })).toThrow(/identifier characters/)
    expect(() => parseContentExtensionEnvelope({ key: 'kroki', version: 1, props: { type: 'unknown', source: 'x' } })).toThrow(/supported Kroki/)
    expect(() => parseContentExtensionEnvelope({
      key: 'plantuml',
      version: 1,
      props: { source: 'x', server: 'https://evil.test' }
    })).toThrow(/unknown property "server"/)
    expect(() => parseContentExtensionEnvelope({ key: 'map', version: 1, props: { latitude: 91, longitude: 0 } })).toThrow(/-90 to 90/)
  })

  it.each([
    [{ key: 'qr', version: 2, props: { value: 'x' } }, /require version 1/],
    [{ key: 'barcode', version: 1, props: { value: 'x' } }, /must be one of/],
    [{ key: 'qr', version: 1, props: { value: 1 } }, /props.value/],
    [{ key: 'qr', version: 1, props: { value: 'x', label: 1 } }, /props.label/],
    [{ key: 'qr', version: 1 }, /props must be an object/],
    [null, /must be an object/],
    [[], /must be an object/]
  ])('rejects invalid external envelope data without permissive casting', (input, diagnostic) => {
    expect(() => parseContentExtensionEnvelope(input)).toThrow(diagnostic)
  })

  it.each([
    [{ key: 'qr', version: 1, props: { value: 'x' }, enabled: true }, 'enabled'],
    [{ key: 'qr', version: 1, props: { value: 'x', color: 'red' } }, 'color'],
    [{ key: 'gallery', version: 1, props: { images: [{ src: '/a.jpg', alt: 'A', width: 3 }] } }, 'width']
  ])('rejects unknown fields', (input, field) => {
    expect(() => parseContentExtensionEnvelope(input)).toThrow(`unknown property "${field}"`)
  })

  it('rejects malformed JSON and trailing JSON values', () => {
    expect(() => parseContentExtensionFence('{')).toThrow(/exactly one valid JSON object/)
    expect(() => parseContentExtensionFence(`${canonicalBody}{}`)).toThrow(/exactly one valid JSON object/)
  })
})

describe('content extension compatibility', () => {
  const qrDefinition = BUILTIN_CONTENT_EXTENSIONS[0]!

  it('reports every bundled definition as compatible', () => {
    for (const definition of BUILTIN_CONTENT_EXTENSIONS) {
      expect(contentExtensionCompatibility(definition)).toEqual({ compatible: true, diagnostic: null })
    }
  })

  it('returns an actionable extension version mismatch', () => {
    expect(contentExtensionCompatibility({ ...qrDefinition, version: 2 })).toEqual({
      compatible: false,
      diagnostic: 'Extension "qr" version 2 is incompatible with content extension host version 1; install extension version 1.'
    })
  })

  it('returns an actionable unsupported-extension diagnostic', () => {
    const future = { ...qrDefinition, key: 'future' } as unknown as ContentExtensionDefinition
    expect(contentExtensionCompatibility(future)).toEqual({
      compatible: false,
      diagnostic: 'Extension "future" is not supported by content extension host version 1.'
    })
  })
})
