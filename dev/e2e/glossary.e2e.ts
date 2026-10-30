import { expect, type Page } from '@playwright/test'
import type { GlossaryTerm, GlossaryTermInput } from '../../shared/glossary.ts'
import { authenticateAsAdmin, responsiveTest as base, openSearch, sameOriginHeaders } from './helpers'
import { waitForPageRender } from '../../client/helpers/pages-api.ts'

interface GlossaryFixture {
  first: GlossaryTerm
  second: GlossaryTerm
  query: string
  alias: string
}

const inputFor = (term: GlossaryTerm): GlossaryTermInput => ({
  locale: term.locale,
  term: term.term,
  expansion: term.expansion,
  definition: term.definition,
  aliases: term.aliases,
  relatedIds: term.relatedIds,
  documentationPageId: term.documentationPageId,
  documentationLabel: term.documentationLabel,
  references: term.references,
  caseSensitive: term.caseSensitive,
  autoLink: term.autoLink,
  category: term.category
})

const test = base.extend<{ glossaryTerms: GlossaryFixture }>({
  glossaryTerms: async ({ page }, use) => {
    const ids: number[] = []
    try {
      await authenticateAsAdmin(page)
      const query = crypto.randomUUID().slice(0, 8)
      const create = async (term: string, category: string, relatedIds: number[] = [], aliases: string[] = []) => {
        const response = await page.request.post('/_api/glossary/terms', {
          headers: sameOriginHeaders(),
          data: {
            locale: 'en',
            term,
            expansion: `${term} expansion`,
            definition: `A **verified** definition for ${term}.`,
            aliases,
            relatedIds,
            documentationPageId: null,
            documentationLabel: '',
            references: [{ label: 'Reference guide', url: 'https://example.com/glossary' }],
            caseSensitive: false,
            autoLink: false,
            category
          } satisfies GlossaryTermInput
        })
        expect(response.ok(), `Glossary fixture creation: HTTP ${response.status()}`).toBe(true)
        const created = (await response.json()) as GlossaryTerm
        ids.push(created.id)
        return created
      }
      const second = await create(`Cache queue ${query}`, 'Operations')
      const alias = `alias-${query}`
      const first = await create(`Glossary protocol ${query}`, 'Networks', [second.id], [alias])
      await use({ first, second, query, alias })
    } finally {
      await page.context().setOffline(false)
      await authenticateAsAdmin(page)
      for (const id of ids.reverse()) {
        const current = await page.request.get(`/_api/glossary/terms/${id}`)
        if (current.status() === 404) continue
        expect(current.ok()).toBe(true)
        const term = (await current.json()) as GlossaryTerm
        const removed = await page.request.delete(`/_api/glossary/terms/${id}`, {
          headers: sameOriginHeaders(),
          data: { expectedRevision: term.revision }
        })
        expect(removed.ok(), `Glossary fixture cleanup: HTTP ${removed.status()}`).toBe(true)
      }
    }
  }
})

test.use({ serviceWorkers: 'block' })

async function openGlossary(page: Page) {
  await page.goto('/en/home', { waitUntil: 'networkidle' })
  await openSearch(page)
  const search = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
  await search.getByRole('button', { name: 'Glossary', exact: true }).click()
  await expect(search.locator('.glossary-search')).toBeVisible()
  return search
}

test('filters the selected catalogue and follows term definitions and history', async ({ page, glossaryTerms: terms }) => {
  const search = await openGlossary(page)
  const pane = search.locator('.glossary-search')
  const types = search.locator('.search-results-scope-actions')
  await expect(types.getByRole('button', { name: 'Glossary', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const input = page.locator('.nav-header-search-control input:visible').first()
  await expect(input).toHaveAttribute('role', 'searchbox')
  await input.fill(terms.query)
  await expect(pane.getByRole('link', { name: new RegExp(terms.first.term) })).toBeVisible()
  await expect(pane.getByRole('link', { name: new RegExp(terms.second.term) })).toBeVisible()

  await pane.getByRole('combobox', { name: 'Category', exact: true }).press('ArrowDown')
  await page.getByRole('option', { name: 'Networks', exact: true }).click()
  await expect(pane.locator('.glossary-search__term')).toHaveCount(1)
  await expect(pane.locator('.glossary-search__term')).toContainText(terms.first.term)
  await pane.getByRole('combobox', { name: 'Category', exact: true }).press('ArrowDown')
  await page.getByRole('option', { name: 'All categories', exact: true }).click()
  await pane.getByRole('combobox', { name: 'A–Z / initial', exact: true }).press('ArrowDown')
  await page.getByRole('option', { name: 'C', exact: true }).click()
  await expect(pane.locator('.glossary-search__term')).toHaveCount(1)
  await expect(pane.locator('.glossary-search__term')).toContainText(terms.second.term)

  await input.fill(terms.alias)
  await pane.getByRole('textbox', { name: 'Catalog locale', exact: true }).fill('fr')
  await expect(pane.locator('.glossary-search__term')).toHaveCount(0)
  await pane.getByRole('textbox', { name: 'Catalog locale', exact: true }).fill('en')
  const term = pane.getByRole('link', { name: new RegExp(terms.first.term) })
  await expect(pane.locator('.glossary-search__term')).toHaveCount(1)
  await term.focus()
  await term.press('Enter')
  await expect(pane.getByRole('heading', { name: terms.first.term, exact: true })).toBeVisible()
  await expect(pane.getByRole('heading', { name: terms.first.term, exact: true })).toBeFocused()
  await expect(pane.locator('.contents')).toContainText(`A verified definition for ${terms.first.term}.`)
  await expect(pane.getByRole('link', { name: 'Reference guide', exact: true })).toHaveAttribute('rel', 'noopener noreferrer')
  await pane.getByRole('link', { name: terms.second.term, exact: true }).click()
  await expect(pane.getByRole('heading', { name: terms.second.term, exact: true })).toBeVisible()
  await page.goBack()
  await expect(pane.getByRole('heading', { name: terms.first.term, exact: true })).toBeVisible()

  const oneLetter = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/_api/glossary/' && url.searchParams.get('query') === 'G'
  })
  await input.fill('G')
  expect((await oneLetter).ok()).toBe(true)
  await expect(pane.locator('.glossary-search__term').filter({ hasText: terms.first.term })).toBeVisible()
  await expect(pane.locator('.glossary-search__term').filter({ hasText: terms.second.term })).toHaveCount(0)
  await search.getByRole('button', { name: 'Saved offline', exact: true }).click()
  await expect(search.getByRole('button', { name: 'Saved offline', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await search.getByRole('button', { name: 'Wiki', exact: true }).click()
  await expect(input).toHaveAttribute('role', 'combobox')
  await search.getByRole('button', { name: 'Close search', exact: true }).click()
  await openSearch(page)
  await expect(search.getByRole('button', { name: 'Wiki', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await search.getByRole('button', { name: 'Close search', exact: true }).click()
  await page.goto(`/en/home?glossary=${encodeURIComponent(terms.first.term)}`, { waitUntil: 'networkidle' })
  await expect(pane.getByRole('heading', { name: terms.first.term, exact: true })).toBeVisible()
  await expect(page.locator('.v-dialog .glossary-search')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()
  expect(new URL(page.url()).searchParams.has('glossary')).toBe(false)
})

test('preserves unsaved manager edits across type and close attempts, picker dismissal and revision conflicts', async ({ page, glossaryTerms: terms }) => {
  const search = await openGlossary(page)
  const pane = search.locator('.glossary-search')
  await pane.getByRole('button', { name: 'New term', exact: true }).click()
  await expect(pane.locator('form')).toBeVisible()
  await pane.getByRole('button', { name: 'Cancel editing', exact: true }).click()
  await expect(pane.getByRole('heading', { name: 'Glossary', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()
  await openGlossary(page)
  const input = page.locator('.nav-header-search-control input:visible').first()
  await input.fill(terms.alias)
  await pane.getByRole('link', { name: new RegExp(terms.first.term) }).click()
  await pane.getByRole('button', { name: 'Edit', exact: true }).click()
  const expansion = pane.getByRole('textbox', { name: 'Expansion', exact: true })
  await expansion.fill('Retained manager draft')
  for (const action of ['Wiki', 'Close search']) {
    page.once('dialog', dialog => dialog.dismiss())
    await search.getByRole('button', { name: action, exact: true }).click()
    await expect(expansion).toHaveValue('Retained manager draft')
    await expect(search.getByRole('button', { name: 'Glossary', exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  const restoredAccess = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/_api/glossary/access' && url.searchParams.get('locale') === 'en'
  })
  page.once('dialog', dialog => dialog.dismiss())
  await page.goBack()
  await (await restoredAccess).finished()
  await expect(expansion).toHaveValue('Retained manager draft')
  await expect.poll(() => new URL(page.url()).searchParams.get('glossary')).toBe(terms.first.term)
  if ((page.viewportSize()?.width ?? 1280) < 600) await page.locator('.nav-header-mobile-actions').click()
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Open Wiki Agent', exact: true }).click()
  await expect(expansion).toHaveValue('Retained manager draft')
  await expect(page.getByRole('dialog', { name: 'Wiki Agent workspace', exact: true })).toHaveCount(0)
  await input.fill(`${terms.query} changed while editing`)
  await expect(expansion).toHaveValue('Retained manager draft')
  await pane.getByRole('button', { name: 'Choose readable page', exact: true }).click()
  const picker = page.locator('.v-overlay--active .page-selector')
  await expect(picker).toBeVisible()
  await expect.poll(() => picker.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()
  await expect(expansion).toHaveValue('Retained manager draft')
  await pane.getByRole('button', { name: 'Save term', exact: true }).click()
  await expect(pane.getByRole('heading', { name: terms.first.term, exact: true })).toBeVisible()
  await expect(pane).toContainText('Retained manager draft')

  await pane.getByRole('button', { name: 'Edit', exact: true }).click()
  await expansion.fill('My conflict-resolved draft')
  const currentResponse = await page.request.get(`/_api/glossary/terms/${terms.first.id}`)
  const current = (await currentResponse.json()) as GlossaryTerm
  const peer = await page.request.put(`/_api/glossary/terms/${current.id}`, {
    headers: sameOriginHeaders(),
    data: { ...inputFor(current), expansion: 'Concurrent server version', expectedRevision: current.revision }
  })
  expect(peer.ok()).toBe(true)
  await pane.getByRole('button', { name: 'Save term', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'Save term', exact: true })).toBeDisabled()
  await expect(expansion).toHaveValue('My conflict-resolved draft')
  await pane.getByRole('button', { name: 'Load current revision', exact: true }).click()
  await expect(pane.getByRole('region', { name: 'Current server version', exact: true })).toContainText('Concurrent server version')
  await pane.getByRole('button', { name: 'Keep my draft against this revision', exact: true }).click()
  await pane.getByRole('button', { name: 'Save term', exact: true }).click()
  await expect(pane.getByRole('heading', { name: terms.first.term, exact: true })).toBeVisible()
  await expect(pane).toContainText('My conflict-resolved draft')
  const saved = await page.request.get(`/_api/glossary/terms/${current.id}`)
  expect(((await saved.json()) as GlossaryTerm).expansion).toBe('My conflict-resolved draft')
})

test('keeps Glossary distinct from Saved offline, retries catalog failures and enforces real guest access', async ({ page, glossaryTerms: terms }) => {
  const search = await openGlossary(page)
  const pane = search.locator('.glossary-search')
  const input = page.locator('.nav-header-search-control input:visible').first()
  await input.fill(terms.alias)
  await expect(pane.locator('.glossary-search__term').filter({ hasText: terms.first.term })).toBeVisible()
  await page.context().setOffline(true)
  await expect(pane.getByRole('alert')).toBeVisible()
  await expect(search.getByRole('button', { name: 'Glossary', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(pane.locator('.glossary-search__term')).toHaveCount(0)
  await search.getByRole('button', { name: 'Saved offline', exact: true }).click()
  await expect(search.getByRole('button', { name: 'Saved offline', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.context().setOffline(false)
  await search.getByRole('button', { name: 'Glossary', exact: true }).click()
  await expect(pane.locator('.glossary-search__term').filter({ hasText: terms.first.term })).toBeVisible()

  const catalog = (url: URL) => url.pathname === '/_api/glossary/'
  await page.route(catalog, route => route.fulfill({ status: 503, json: { error: 'Controlled catalog outage.' } }))
  await input.fill(terms.query)
  await expect(pane.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await page.unroute(catalog)
  await pane.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(pane.locator('.glossary-search__term').filter({ hasText: terms.first.term })).toBeVisible()

  await page.context().clearCookies()
  await page.goto('/en/home', { waitUntil: 'networkidle' })
  await openSearch(page)
  await search.getByRole('button', { name: 'Glossary', exact: true }).click()
  const access = await page.request.get('/_api/glossary/access?locale=en')
  const guest = (await access.json()) as { enabled: boolean; canRead: boolean; canManage: boolean }
  expect(guest.canManage).toBe(false)
  await expect(pane.getByRole('button', { name: 'New term', exact: true })).toHaveCount(0)
  if (!guest.canRead) {
    await expect(pane.locator('.glossary-search__term')).toHaveCount(0)
  }
})

test('dismisses a tall definition without covering or reactivating its trigger', async ({ page, glossaryTerms: terms }) => {
  const updated = await page.request.put(`/_api/glossary/terms/${terms.first.id}`, {
    headers: sameOriginHeaders(),
    data: {
      ...inputFor(terms.first),
      autoLink: true,
      definition: 'A long visible definition. '.repeat(80),
      expectedRevision: terms.first.revision
    }
  })
  expect(updated.ok(), `Tall glossary definition: HTTP ${updated.status()}`).toBe(true)
  const path = `e2e-glossary-hover-${crypto.randomUUID()}`
  let pageId: number | undefined
  let sourceRevision: string | undefined
  try {
    const created = await page.request.post('/_api/pages', {
      headers: { ...sameOriginHeaders(), Accept: 'application/json' },
      data: {
        content: `# Tall glossary aid\n\n${terms.first.term} appears in this paragraph.\n\n[Continue reading](#continue)\n\n## Continue\n\nThe rest of the article remains reachable.\n`,
        description: 'Isolated tall glossary card regression',
        editor: 'markdown',
        visibility: 'public',
        isPublished: true,
        isSearchable: false,
        locale: 'en',
        path,
        publishEndDate: '',
        publishStartDate: '',
        scriptCss: '',
        scriptJs: '',
        tags: [],
        title: 'Tall glossary aid'
      }
    })
    expect(created.ok(), `Tall glossary article: HTTP ${created.status()}`).toBe(true)
    const payload = (await created.json()) as { page: { id: number; sourceRevision: string } }
    pageId = payload.page.id
    sourceRevision = payload.page.sourceRevision
    await waitForPageRender(async url => {
      const response = await page.request.get(url)
      return new Response(await response.body(), { status: response.status(), headers: response.headers() })
    }, { id: pageId, sourceRevision, locale: 'en', path, visibility: 'public' }, AbortSignal.timeout(15_000))

    await page.goto(`/en/${path}`, { waitUntil: 'domcontentloaded' })
    const reader = page.locator('article.contents')
    const trigger = reader.locator('a[data-glossary-term]').filter({ hasText: terms.first.term })
    await expect(trigger).toBeVisible()
    await trigger.hover()
    const card = page.getByRole('dialog', { name: terms.first.term, exact: true })
    await expect(card.locator('.glossary-hover-card__definition')).toBeVisible()
    const [cardBox, triggerBox] = await Promise.all([card.boundingBox(), trigger.boundingBox()])
    if (!cardBox || !triggerBox) throw new Error('Glossary card and trigger must have visible geometry.')
    expect(cardBox.y >= triggerBox.y + triggerBox.height || cardBox.y + cardBox.height <= triggerBox.y).toBe(true)
    expect(await card.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)

    await page.keyboard.press('Escape')
    await expect(card).toBeHidden()
    await reader.getByRole('link', { name: 'Continue reading', exact: true }).hover({ timeout: 5_000 })
    await expect(card).toBeHidden()
  } finally {
    if (pageId !== undefined && sourceRevision !== undefined) {
      const removed = await page.request.delete(`/_api/pages/${pageId}`, {
        headers: sameOriginHeaders(),
        data: { expectedSourceRevision: sourceRevision }
      })
      expect(removed.ok(), `Tall glossary article cleanup: HTTP ${removed.status()}`).toBe(true)
    }
  }
})
