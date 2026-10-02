import { describe, expect, it } from '../../server/test/bun-test.mts'
import { keyTranslator, renderTemplate } from '../test/render-template.mts'

describe('page rating card', () => {
  const thumbs = { kind: 'thumbs', count: 3, score: null, ownVote: 1, distribution: { '1': 2, '-1': 1 } }

  it('explains the icon-only remove button with a tooltip', async () => {
    const { document } = await renderTemplate('client/components/wiki-page-ratings.vue', {
      $t: keyTranslator, isHuman: true, view: thumbs, loading: false, stale: false, error: '', canVote: true, summary: '3 votes', starValues: [1, 2, 3, 4, 5]
    })
    const remove = document.querySelector('.wiki-page-ratings__remove')
    expect(remove?.getAttribute('aria-label')).toBe('common:pageRatings.removeMine')
    expect(remove?.closest('[data-stub="v-tooltip"]')?.textContent).toContain('common:pageRatings.removeMine')
    expect(document.querySelector('.wiki-page-ratings__choice')?.getAttribute('aria-label')).toBe('common:pageRatings.rateHelpful(count=2)')
  })

  it('uses the shared loading state', async () => {
    const { document } = await renderTemplate('client/components/wiki-page-ratings.vue', {
      $t: keyTranslator, isHuman: true, view: null, loading: true, stale: false, error: '', starValues: []
    })
    const loading = document.querySelector('[data-stub="async-state"]')
    expect(loading?.getAttribute('state')).toBe('loading')
    expect(loading?.getAttribute('title')).toBe('common:pageRatings.loading')
  })
})

describe('page links panel', () => {
  it('labels its chrome through translations', async () => {
    const { document } = await renderTemplate('client/components/wiki-page-links.vue', {
      $t: keyTranslator, direction: 'incoming', items: [], hasMore: false, stale: false, loading: false, error: '', emptyTitle: 'empty', emptyMessage: 'none'
    })
    expect(document.querySelector('#wiki-page-links-title')?.textContent).toBe('common:pageLinks.title')
    expect(document.querySelector('.wiki-page-links__directions')?.getAttribute('aria-label')).toBe('common:pageLinks.direction')
    expect(document.body.textContent).not.toMatch(/Incoming|Outgoing/)
  })
})

describe('tag library states', () => {
  it('shows a filtered-out tag index with the shared empty state and its action', async () => {
    const { document, html } = await renderTemplate('client/components/tags.vue', {
      $t: keyTranslator,
      $vuetify: { display: { mdAndUp: true }, locale: { isRtl: false } },
      tagsSelected: [], hasSelection: false, tagsLoading: false, tags: [{ tag: 'alpha' }], tagsError: '', filteredTags: [], indexIsVisible: true,
      tagsGrouped: [], locales: [], resultPages: [], pagination: { itemsPerPage: 10, page: 1, sortBy: [] }
    })
    expect(html).not.toContain('v-empty-state')
    const empty = document.querySelector('.tags-index-empty')
    expect(empty?.getAttribute('data-stub')).toBe('async-state')
    expect(empty?.getAttribute('title')).toBe('tags:noMatchingTags')
    expect(empty?.textContent).toContain('tags:clearSearch')
  })
})
