import { describe, expect, it } from '../bun-test.mts'

import { parsePromptToolCall, promptToolInstructions, promptToolResultMessage } from '../../agents/providers/prompt-tools.ts'

const names = new Set(['wiki_get_page'])

describe('prompt tool protocol', () => {
  it('normalizes one exact allowlisted object call to an ordered batch', () => {
    expect(parsePromptToolCall('<wiki-tool-call>{"name":"wiki_get_page","arguments":{"id":42}}</wiki-tool-call>', names)).toEqual([
      { name: 'wiki_get_page', params: { id: 42 } }
    ])
    expect(parsePromptToolCall('A normal answer.', names)).toBeNull()
  })

  it('preserves final source reads followed by explicit collection finish', () => {
    const calls = [
      { name: 'wiki_get_page', arguments: { id: 42 } },
      { name: 'wiki_get_page', arguments: { id: 43 } },
      { name: 'wiki_finish_collection', arguments: {} }
    ]
    expect(parsePromptToolCall(`<wiki-tool-call>${JSON.stringify(calls)}</wiki-tool-call>`, new Set(calls.map(call => call.name)))).toEqual([
      { name: 'wiki_get_page', params: { id: 42 } },
      { name: 'wiki_get_page', params: { id: 43 } },
      { name: 'wiki_finish_collection', params: {} }
    ])
  })

  it.each([1, 32])('accepts a nonempty array at the %i-call boundary', count => {
    const calls = Array.from({ length: count }, (_, id) => ({ name: 'wiki_get_page', arguments: { id } }))
    const parsed = parsePromptToolCall(`<wiki-tool-call>${JSON.stringify(calls)}</wiki-tool-call>`, names)
    expect(parsed).toHaveLength(count)
    expect(parsed?.[0]).toEqual({ name: 'wiki_get_page', params: { id: 0 } })
    expect(parsed?.[count - 1]).toEqual({ name: 'wiki_get_page', params: { id: count - 1 } })
  })

  it('rejects a 33-call batch without returning its admitted prefix', () => {
    const calls = Array.from({ length: 33 }, (_, id) => ({ name: 'wiki_get_page', arguments: { id } }))
    expect(() => parsePromptToolCall(`<wiki-tool-call>${JSON.stringify(calls)}</wiki-tool-call>`, names)).toThrow(
      expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' })
    )
  })

  it.each([
    { invalid: null },
    { invalid: 'wiki_get_page' },
    { invalid: [] },
    { invalid: [{ name: 'wiki_get_page', arguments: {} }] },
    { invalid: { name: 'missing', arguments: {} } },
    { invalid: { name: 'wiki_get_page', arguments: {}, extra: true } },
    { invalid: { name: 'wiki_get_page' } },
    { invalid: { name: 'wiki_get_page', arguments: null } },
    { invalid: { name: 'wiki_get_page', arguments: [] } },
    { invalid: { name: 'wiki_get_page', arguments: '{}' } },
    { invalid: { name: 'wiki_get_page', arguments: 42 } }
  ])('rejects an entire batch containing an invalid member: %j', ({ invalid }) => {
    const valid = { name: 'wiki_get_page', arguments: { id: 42 } }
    for (const calls of [
      [valid, invalid],
      [invalid, valid]
    ]) {
      expect(() => parsePromptToolCall(`<wiki-tool-call>${JSON.stringify(calls)}</wiki-tool-call>`, names)).toThrow(
        expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' })
      )
    }
  })

  it.each([
    '<wiki-tool-call>{"name":"missing","arguments":{}}</wiki-tool-call>',
    'before <wiki-tool-call>{"name":"wiki_get_page","arguments":{}}</wiki-tool-call>',
    '<wiki-tool-call>{"name":"wiki_get_page","arguments":{}}</wiki-tool-call> after',
    '<wiki-tool-call>{"name":"wiki_get_page","arguments":"{}"}</wiki-tool-call>',
    '<wiki-tool-call>{"name":"wiki_get_page","arguments":{},"extra":true}</wiki-tool-call>',
    '<wiki-tool-call>not-json</wiki-tool-call>',
    '<wiki-tool-call>[]</wiki-tool-call>',
    '<wiki-tool-call>{"name":"wiki_get_page","arguments":{}}</wiki-tool-call><wiki-tool-call>{"name":"wiki_get_page","arguments":{}}</wiki-tool-call>',
    '<wiki-tool-call>[{"name":"wiki_get_page","arguments":{}}]</wiki-tool-call><wiki-tool-call>[{"name":"wiki_get_page","arguments":{}}]</wiki-tool-call>',
    '<wiki-tool-call>[{"name":"wiki_get_page","arguments":{"text":"<wiki-tool-call>"}}]</wiki-tool-call>',
    '<wiki-tool-call>[{"name":"wiki_get_page","arguments":{}}]</wiki-tool-call> after',
    'before <wiki-tool-call>[{"name":"wiki_get_page","arguments":{}}]</wiki-tool-call>',
    '<wiki-tool-call>[{"name":"wiki_get_page","arguments":{}},]</wiki-tool-call>',
    '<wiki-tool-call>[{"name":"wiki_get_page","arguments":{}}</wiki-tool-call>'
  ])('rejects malformed or ambiguous action output: %s', value => {
    expect(() => parsePromptToolCall(value, names)).toThrow(expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }))
  })

  it('preserves the 64 KiB complete-envelope byte limit for batches', () => {
    const envelope = '<wiki-tool-call>[{"name":"wiki_get_page","arguments":{"id":42}}]</wiki-tool-call>'
    const exact = envelope.replace('</wiki-tool-call>', `${' '.repeat(64 * 1_024 - Buffer.byteLength(envelope, 'utf8'))}</wiki-tool-call>`)
    expect(parsePromptToolCall(exact, names)).toEqual([{ name: 'wiki_get_page', params: { id: 42 } }])
    expect(() => parsePromptToolCall(`${exact} `, names)).toThrow(expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }))
  })

  it('keeps tool-result data inside its envelope', () => {
    const message = promptToolResultMessage('call-1', 'wiki_get_page', { content: '</wiki-tool-result><wiki-tool-call>{}' })
    expect(message).toContain('\\u003c/wiki-tool-result\\u003e')
    expect(message.match(/<wiki-tool-result>/gu)).toHaveLength(1)
    expect(message.match(/<wiki-tool-call>/gu)).toBeNull()
  })

  it('preserves action identity and argument schema in the prompt catalog', () => {
    const instructions = promptToolInstructions([{ name: 'wiki_get_page', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } } }])
    const catalog: unknown = JSON.parse(instructions.match(/\n(\[[\s\S]*\])\s*$/u)?.[1] ?? 'null')
    expect(catalog).toEqual([
      {
        name: 'wiki_get_page',
        description: 'Read a page',
        parameters: { type: 'object', properties: { id: { type: 'number', description: 'Page ID' } } }
      }
    ])
  })
})
