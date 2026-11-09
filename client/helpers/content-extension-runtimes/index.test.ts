import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { nextTick } from 'vue'
import moment from 'moment-timezone'
import { applyUserPresentation } from '../index.ts'
import { hydratePageIndex } from './index.ts'

const controllers: AbortController[] = []
const originalLocale = moment.locale()
afterEach(() => {
  controllers.splice(0).forEach(controller => { controller.abort() })
  applyUserPresentation({ timezone: '', dateFormat: '', timeFormat: 'locale' })
  moment.locale(originalLocale)
  document.body.replaceChildren()
})

const hydrate = async (updatedAt: string, showUpdatedAt?: boolean) => {
  const element = document.createElement('section')
  element.dataset.indexPath = 'guide'
  element.dataset.indexLocale = 'fr'
  element.dataset.indexOrder = 'updated'
  if (showUpdatedAt !== undefined) element.dataset.indexShowUpdatedAt = String(showUpdatedAt)
  element.innerHTML = '<p class="content-extension-index__status">Loading page index…</p>'
  document.body.append(element)
  const controller = new AbortController()
  controllers.push(controller)
  const request = vi.fn().mockResolvedValue(Response.json({ items: [{
    id: 1, title: 'Authorized page', description: null, path: 'guide/a',
    href: '/_private/fr/guide/a', updatedAt
  }] }))
  await hydratePageIndex(element, request, controller.signal)
  return { element, request, controller }
}

describe('page index update dates', () => {
  it.each([undefined, false])('keeps dates absent unless explicitly enabled (%s)', async enabled => {
    const { element } = await hydrate('2026-11-08T23:30:00.000Z', enabled)
    expect(element.querySelector('time')).toBeNull()
    expect(element.textContent).not.toContain('Update time unavailable')
  })

  it('renders an authorized machine instant and reacts to reader preferences without refetching or rebuilding hrefs', async () => {
    moment.locale('en')
    applyUserPresentation({ timezone: 'UTC', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })
    const { element, request, controller } = await hydrate('2026-11-08T23:30:00.000Z', true)
    const time = element.querySelector('time')!
    expect(time.dateTime).toBe('2026-11-08T23:30:00.000Z')
    expect(time.textContent).toBe('2026-11-08 23:30')
    expect(element.querySelector('a')?.getAttribute('href')).toBe('/_private/fr/guide/a')
    applyUserPresentation({ timezone: 'Asia/Tokyo', dateFormat: 'DD/MM/YYYY', timeFormat: '12h' })
    await nextTick()
    expect(time.textContent).toBe('09/11/2026 8:30 AM')
    expect(time.dateTime).toBe('2026-11-08T23:30:00.000Z')
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0][0])).toContain('order=updated')
    controller.abort()
    applyUserPresentation({ timezone: 'UTC', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })
    await nextTick()
    expect(time.textContent).toBe('09/11/2026 8:30 AM')
  })

  it.each(['', 'now', '2026-11-08', '2026-11-08T23:30:00', '2026-02-30T23:30:00Z'])('keeps the authorized link and honestly marks invalid instant %s', async value => {
    const { element, request } = await hydrate(value, true)
    expect(element.querySelector('time')).toBeNull()
    expect(element.textContent).toContain('Update time unavailable')
    expect(element.querySelector('a')?.getAttribute('href')).toBe('/_private/fr/guide/a')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('keeps empty and request-failure states usable with dates enabled (%s)', async ok => {
    const element = document.createElement('section')
    element.dataset.indexShowUpdatedAt = 'true'
    element.dataset.indexEmptyLabel = 'No readable pages.'
    element.innerHTML = '<p class="content-extension-index__status">Loading…</p>'
    const controller = new AbortController()
    controllers.push(controller)
    await hydratePageIndex(element, vi.fn().mockResolvedValue(Response.json({ items: [] }, { status: ok ? 200 : 503 })), controller.signal)
    expect(element.getAttribute('aria-busy')).toBe('false')
    expect(element.textContent).toBe(ok ? 'No readable pages.' : 'Page index is temporarily unavailable.')
    expect(element.querySelector('time, a')).toBeNull()
  })
})
