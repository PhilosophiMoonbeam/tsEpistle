import { describe, it, expect, vi } from '../bun-test.mts'
import { fetchLocaleCatalog, fetchLocaleStrings } from '../../repositories/locale-packages.ts'
describe('bounded language source requests', () => {
  it('validates catalog responses and sends locale values as GraphQL variables', async () => {
    const mock = vi.fn(async () => Response.json({ data: { localization: { strings: [{ key: 'common:title', value: 'Bonjour' }] } } }))
    expect(JSON.parse(JSON.stringify(await fetchLocaleStrings('https://source.example', 'fr', undefined, mock as never)))).toEqual({
      common: { title: 'Bonjour' }
    })
    const options = mock.mock.calls[0]![1] as unknown as RequestInit
    expect(JSON.parse(String(options.body)).variables).toEqual({ code: 'fr' })
    expect(options.redirect).toBe('error')
  })
  it('rejects GraphQL errors, duplicate catalog codes, oversized bodies and aborted requests', async () => {
    const locale = { code: 'en', name: 'English', nativeName: 'English', isRTL: false, availability: 100 }
    const catalog = JSON.stringify({ data: { localization: { locales: [locale] } } })
    for (const response of [
      Response.json({ errors: [{ message: 'secret' }] }),
      Response.json({ data: { localization: { locales: [locale, locale] } } }),
      new Response(catalog, { headers: { 'content-length': String(9 * 1024 * 1024) } }),
      new Response(catalog.padEnd(8 * 1024 * 1024 + 1, ' '))
    ])
      await expect(fetchLocaleCatalog('https://source.example', undefined, (async () => response) as never)).rejects.toThrow()
    const controller = new AbortController()
    const reason = new Error('Caller canceled the language request')
    controller.abort(reason)
    await expect(fetchLocaleStrings('https://source.example', 'fr', controller.signal, (async () => Response.json({
      data: { localization: { strings: [{ key: 'common:title', value: 'Bonjour' }] } }
    })) as never)).rejects.toBe(reason)
  })
})
