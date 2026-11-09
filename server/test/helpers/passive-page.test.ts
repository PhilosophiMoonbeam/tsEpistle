import { describe, expect, it } from '../bun-test.mts'
import { load } from 'cheerio'
import { projectPassivePage } from '../../helpers/passive-page.ts'

const index = (extra = '') => `<section class="content-extension--index" data-index-path="guides" data-index-locale="fr" data-index-depth="1" data-index-limit="50" ${extra}><p>Loading page index…</p></section>`
const item = { id: 7, title: 'Authorized guide', description: 'Visible description', path: 'guides/one', href: '/_private/fr/guides/one', updatedAt: '2026-11-08T16:30:00.000Z', tags: [], pageAccent: null }

describe('passive stored-render projection', () => {
  it('retains prose, headings and canonical grid links without active markup or duplicate IDs', async () => {
    const html = await projectPassivePage({ render: '<h2 id="live">Guide</h2><p onclick="alert(1)" style="display:none">Read <a href="/fr/guides/one">one</a></p><script>alert(1)</script><iframe src="/admin"></iframe><img src="https://remote.example/track"><a href="javascript:alert(1)">bad</a><div data-remote-src="https://remote.example">Consent required</div>', sourceRevision: 3, locale: 'fr', listIndex: async () => [] })
    const $ = load(html)
    expect($('h2').text()).toBe('Guide')
    expect($('a[href="/fr/guides/one"]').text()).toBe('one')
    expect($('script,iframe,img,[id],[style],[onclick],[data-remote-src]').length).toBe(0)
    expect($('a[href^="javascript:"]').length).toBe(0)
    expect($.text()).toContain('Consent required')
  })

  it('uses only supplied authorized routes and request-local results, with optional localized dates', async () => {
    const calls: unknown[] = []
    const html = await projectPassivePage({ render: index('data-index-show-updated-at="true"'), sourceRevision: 9, locale: 'fr', presentation: { timezone: 'America/New_York', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' }, listIndex: async args => { calls.push(args); return [item] } })
    const $ = load(html)
    expect(calls).toEqual([{ path: 'guides', locale: 'fr', depth: 1, limit: 50, order: 'path' }])
    expect($('a').attr('href')).toBe('/_private/fr/guides/one')
    expect($('time').attr('datetime')).toBe('2026-11-08T16:30:00.000Z')
    expect($('time').text()).toBe('2026-11-08 11:30')
    const next = await projectPassivePage({ render: index(), sourceRevision: 9, locale: 'fr', listIndex: async () => [] })
    expect(next).not.toContain('Authorized guide')
    expect(next).toContain('No pages are available')
    const absent = await projectPassivePage({ render: index(), sourceRevision: 9, locale: 'fr', listIndex: async () => [item] })
    expect(absent).not.toContain('<time')
  })

  it('reports unavailable indexes and invalid timestamps honestly', async () => {
    const failed = await projectPassivePage({ render: index(), sourceRevision: 1, locale: 'en', listIndex: async () => { throw new Error('denied') } })
    expect(failed).toContain('Page index is unavailable.')
    expect(failed).not.toContain('denied')
    for (const updatedAt of ['invalid', '2026-11-08', '2026-11-08T16:30:00']) {
      const html = await projectPassivePage({ render: index('data-index-show-updated-at="true"'), sourceRevision: 1, locale: 'en', listIndex: async () => [{ ...item, updatedAt }] })
      expect(html).toContain('Update time unavailable')
      expect(html).not.toContain('<time')
    }
  })

  it('leaves an empty stored render empty and rejects forged index destinations', async () => {
    const empty = await projectPassivePage({ render: '', sourceRevision: 2, locale: 'en', listIndex: async () => { throw new Error('must not list without an index') } })
    expect(empty).toBe('')
    const unsafe = await projectPassivePage({ render: index(), sourceRevision: 2, locale: 'en', listIndex: async () => [{ ...item, href: '//foreign.example/private' }] })
    expect(unsafe).toContain('Page index is unavailable.')
    expect(unsafe).not.toContain('foreign.example')
  })
  it('bounds index work independently of stored extension counts', async () => {

    let calls = 0
    const html = await projectPassivePage({ render: index().repeat(100), sourceRevision: 1, locale: 'en', listIndex: async () => { calls++; return [] } })
    expect(calls).toBe(8)
    expect(html).toContain('Page index is unavailable.')
  })
})
