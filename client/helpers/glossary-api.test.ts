import { afterEach, describe, expect, it } from '../../server/test/bun-test.mts'
import { fetchGlossaryAutolinks } from './glossary-api.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('authorized glossary continuation', () => {
  it('follows every returned continuation, including terms beyond the first payload', async () => {
    const urls: string[] = []
    const pages = [
      { items: [{ id: 1, term: 'First', aliases: [], caseSensitive: false }], complete: false, nextCursor: 'opaque-first' },
      { items: [{ id: 2, term: 'Second', aliases: ['Alias'], caseSensitive: true }], complete: false, nextCursor: 'opaque-next' },
      { items: [{ id: 3, term: 'Last', aliases: [], caseSensitive: false }], complete: true, nextCursor: null }
    ]
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input))
      expect(init?.cache).toBe('no-store')
      return new Response(JSON.stringify(pages[urls.length - 1]), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const result = await fetchGlossaryAutolinks('en', new AbortController().signal)
    expect(result.map(item => item.term)).toEqual(['First', 'Second', 'Last'])
    expect(new URL(urls[1]!, 'https://wiki.test').searchParams.get('cursor')).toBe('opaque-first')
    expect(new URL(urls[2]!, 'https://wiki.test').searchParams.get('cursor')).toBe('opaque-next')
  })

  it('rejects a looping continuation instead of presenting a silently incomplete catalog', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ items: [], complete: false, nextCursor: 'loop' }))
    }) as typeof fetch
    await expect(fetchGlossaryAutolinks('en', new AbortController().signal)).rejects.toThrow('did not advance')
    expect(calls).toBe(2)
  })

  it('stops continuation immediately when its owner lifetime is aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      controller.abort()
      return new Response(JSON.stringify({ items: [], complete: false, nextCursor: 'next' }))
    }) as typeof fetch
    await expect(fetchGlossaryAutolinks('en', controller.signal)).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
