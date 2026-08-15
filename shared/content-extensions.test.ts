import { describe, expect, it } from 'vitest'
import * as contentExtensions from './content-extensions.ts'
import {
  BUILTIN_CONTENT_EXTENSIONS,
  CONTENT_EXTENSION_HOST_VERSION,
  contentExtensionCompatibility,
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
      'contentExtensionCompatibility',
      'isSafeContentExtensionAssetPath',
      'parseContentExtensionEnvelope',
      'parseContentExtensionFence',
      'serializeContentExtensionFence'
    ])
  })

  it('declares the complete built-in extension catalog', () => {
    expect(CONTENT_EXTENSION_HOST_VERSION).toBe(1)
    expect(BUILTIN_CONTENT_EXTENSIONS.map(extension => extension.key)).toEqual(['qr', 'gallery', 'index'])
    expect(BUILTIN_CONTENT_EXTENSIONS).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'qr', version: 1, icon: 'mdi-qrcode' }),
      expect.objectContaining({ key: 'gallery', version: 1, icon: 'mdi-view-gallery-outline' }),
      expect.objectContaining({ key: 'index', version: 1, icon: 'mdi-format-list-bulleted-square' })
    ]))
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
    [{ key: 'qr', version: 2, props: { value: 'x' } }, /require version 1/],
    [{ key: 'barcode', version: 1, props: { value: 'x' } }, /"qr", "gallery", or "index"/],
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
