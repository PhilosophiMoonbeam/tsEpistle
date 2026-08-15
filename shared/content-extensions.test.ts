import { describe, expect, it } from 'vitest'
import * as contentExtensions from './content-extensions.ts'
import {
  BUILTIN_CONTENT_EXTENSIONS,
  CONTENT_EXTENSION_HOST_VERSION,
  contentExtensionCompatibility,
  parseContentExtensionEnvelope,
  parseContentExtensionFence,
  serializeContentExtensionFence
} from './content-extensions.ts'

const canonicalFence = '```wiki-extension\n{"key":"qr","version":1,"props":{"value":"https://example.com","label":"Example","size":512,"errorCorrection":"H"}}\n```\n'
const canonicalBody = '{"key":"qr","version":1,"props":{"value":"https://example.com","label":"Example","size":512,"errorCorrection":"H"}}'

describe('content extension contract', () => {
  it('exports only the shared runtime contract', () => {
    expect(Object.keys(contentExtensions).sort()).toEqual([
      'BUILTIN_CONTENT_EXTENSIONS',
      'CONTENT_EXTENSION_HOST_VERSION',
      'contentExtensionCompatibility',
      'parseContentExtensionEnvelope',
      'parseContentExtensionFence',
      'serializeContentExtensionFence'
    ])
  })

  it('declares the deterministic built-in QR definition', () => {
    expect(CONTENT_EXTENSION_HOST_VERSION).toBe(1)
    expect(BUILTIN_CONTENT_EXTENSIONS).toEqual([
      {
        key: 'qr',
        version: 1,
        title: 'QR code',
        description: 'Encode text or a link as a deterministic QR code.',
        icon: 'mdi-qrcode'
      }
    ])
  })

  it('serializes in canonical property order and round trips the JSON fence body', () => {
    const envelope = parseContentExtensionFence(canonicalBody)

    expect(serializeContentExtensionFence(envelope)).toBe(canonicalFence)
    expect(parseContentExtensionFence(canonicalBody)).toEqual(envelope)
    expect(serializeContentExtensionFence(envelope).endsWith('\n')).toBe(true)
  })

  it('applies QR defaults and writes them into canonical source', () => {
    const envelope = parseContentExtensionEnvelope({
      props: { value: 'hello' },
      version: 1,
      key: 'qr'
    })

    expect(envelope).toEqual({
      key: 'qr',
      version: 1,
      props: { value: 'hello', size: 256, errorCorrection: 'M' }
    })
    expect(serializeContentExtensionFence(envelope)).toBe(
      '```wiki-extension\n{"key":"qr","version":1,"props":{"value":"hello","size":256,"errorCorrection":"M"}}\n```\n'
    )
  })

  it('parses the JSON body independently and preserves the observable source bytes', () => {
    const source = `  ${canonicalBody}\n`
    const original = source

    expect(parseContentExtensionFence(source).props.value).toBe('https://example.com')
    expect(source).toBe(original)
    expect(() => parseContentExtensionFence(canonicalFence)).toThrow(/exactly one valid JSON object/)
  })

  it.each([1, 2048])('accepts value boundary length %s', (length) => {
    const value = 'x'.repeat(length)
    expect(parseContentExtensionEnvelope({
      key: 'qr',
      version: 1,
      props: { value }
    }).props.value).toBe(value)
  })

  it.each([
    ['', '1 and 2048'],
    ['x'.repeat(2049), '1 and 2048']
  ])('rejects an invalid value boundary', (value, diagnostic) => {
    expect(() => parseContentExtensionEnvelope({
      key: 'qr',
      version: 1,
      props: { value }
    })).toThrow(diagnostic)
  })

  it.each([128, 1024])('accepts size boundary %s', (size) => {
    expect(parseContentExtensionEnvelope({ key: 'qr', version: 1, props: { value: 'x', size } }).props.size).toBe(size)
  })

  it.each([127, 1025, Number.NaN])('rejects invalid size %s', (size) => {
    expect(() => parseContentExtensionEnvelope({
      key: 'qr',
      version: 1,
      props: { value: 'x', size }
    })).toThrow(/128 and 1024/)
  })

  it('accepts the label boundary and rejects the first character beyond it', () => {
    expect(parseContentExtensionEnvelope({
      key: 'qr',
      version: 1,
      props: { value: 'x', label: 'a'.repeat(200) }
    }).props.label).toHaveLength(200)
    expect(() => parseContentExtensionEnvelope({
      key: 'qr',
      version: 1,
      props: { value: 'x', label: 'a'.repeat(201) }
    })).toThrow(/200 characters/)
  })

  it.each(['L', 'M', 'Q', 'H'])('accepts error correction %s', (errorCorrection) => {
    expect(parseContentExtensionEnvelope({
      key: 'qr',
      version: 1,
      props: { value: 'x', errorCorrection }
    }).props.errorCorrection).toBe(errorCorrection)
  })

  it('rejects non-enum error correction', () => {
    expect(() => parseContentExtensionEnvelope({
      key: 'qr',
      version: 1,
      props: { value: 'x', errorCorrection: 'medium' }
    })).toThrow(/one of "L", "M", "Q", or "H"/)
  })

  it.each([
    [{ key: 'qr', version: 2, props: { value: 'x' } }, /requires version 1/],
    [{ key: 'barcode', version: 1, props: { value: 'x' } }, /key must be "qr"/],
    [{ key: 'qr', version: 1, props: { value: 1 } }, /props.value/],
    [{ key: 'qr', version: 1, props: { value: 'x', label: 1 } }, /props.label/],
    [{ key: 'qr', version: 1, props: { value: 'x', size: '256' } }, /props.size/],
    [{ key: 'qr', version: 1 }, /props must be an object/],
    [null, /must be an object/],
    [[], /must be an object/]
  ])('rejects invalid external envelope data without casting it permissively', (input, diagnostic) => {
    expect(() => parseContentExtensionEnvelope(input)).toThrow(diagnostic)
  })

  it.each([
    [{ key: 'qr', version: 1, props: { value: 'x' }, enabled: true }, 'enabled'],
    [{ key: 'qr', version: 1, props: { value: 'x', color: 'red' } }, 'color']
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

  it('reports the supported definition as compatible', () => {
    expect(contentExtensionCompatibility(qrDefinition)).toEqual({ compatible: true, diagnostic: null })
  })

  it('returns an actionable extension version mismatch', () => {
    expect(contentExtensionCompatibility({ ...qrDefinition, version: 2 })).toEqual({
      compatible: false,
      diagnostic: 'Extension "qr" version 2 is incompatible with content extension host version 1; install extension version 1.'
    })
  })

  it('returns an actionable unsupported-extension diagnostic', () => {
    expect(contentExtensionCompatibility({ ...qrDefinition, key: 'future' })).toEqual({
      compatible: false,
      diagnostic: 'Extension "future" is not supported by content extension host version 1.'
    })
  })
})
