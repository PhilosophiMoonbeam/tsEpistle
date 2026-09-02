import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-pages-visualize.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
const loadPagesStart = script.indexOf('async loadPages (): Promise<void> {')
const loadPagesEnd = script.indexOf('    goToPage', loadPagesStart)
const loadPagesBody = script.slice(loadPagesStart, loadPagesEnd)
const goToPageStart = script.indexOf('goToPage (event: MouseEvent | KeyboardEvent')
const goToPageEnd = script.indexOf('    bilink', goToPageStart)
const goToPageBody = script.slice(goToPageStart, goToPageEnd)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const executeLoadPages = new AsyncFunction(
  'fetchPageLinks',
  'wikiStore',
  'markRaw',
  'getErrorMessage',
  'window',
  loadPagesBody.slice(loadPagesBody.indexOf('{') + 1, loadPagesBody.lastIndexOf('}'))
)

describe('admin pages visualize REST facade', () => {
  it('loads page links through the pages REST helper instead of Apollo', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent, markRaw } from 'vue'")
    expect(loadPagesBody).toContain('this.pages = markRaw(pages)')
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toMatch(/apollo\s*:/)
    expect(script).not.toContain('this.$apollo')
    expect(script).not.toContain('pages {')
    expect(loadPagesBody).toContain('await fetchPageLinks(')
    expect(loadPagesBody).toContain('window.fetch.bind(window)')
    expect(loadPagesBody).toContain('this.currentLocale')
  })

  it('keeps the newest request rendered when older requests for the same or another locale resolve afterward', async () => {
    const pendingRequests = []
    const fetchPageLinks = (_fetch, locale) =>
      new Promise(resolve => {
        pendingRequests.push({ locale, resolve })
      })
    const wikiStore = {
      startLoading() {},
      stopLoading() {},
      showError() {}
    }
    const markedDatasets = []
    const markRaw = pages => {
      markedDatasets.push(pages)
      return pages
    }
    const getErrorMessage = err => err.message
    const browserWindow = { fetch() {} }
    const state = {
      currentLocale: 'A',
      pageLoadRequestId: 0,
      pages: [],
      loading: false,
      errorMessage: ''
    }
    const staleLocaleAPages = [{ id: 1, path: 'a-old', title: 'Old Locale A', links: [] }]
    const staleLocaleBPages = [{ id: 2, path: 'b', title: 'Locale B', links: [] }]
    const latestLocaleAPages = [{ id: 3, path: 'a-new', title: 'New Locale A', links: [] }]

    const staleLocaleARequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)
    state.currentLocale = 'B'
    const staleLocaleBRequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)
    state.currentLocale = 'A'
    const latestLocaleARequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)

    expect(pendingRequests.map(request => request.locale)).toEqual(['A', 'B', 'A'])
    pendingRequests[2].resolve(latestLocaleAPages)
    await latestLocaleARequest
    expect(state.pages).toBe(latestLocaleAPages)
    expect(markedDatasets).toHaveLength(1)
    expect(markedDatasets[0]).toBe(latestLocaleAPages)

    pendingRequests[0].resolve(staleLocaleAPages)
    await staleLocaleARequest
    pendingRequests[1].resolve(staleLocaleBPages)
    await staleLocaleBRequest
    expect(state.pages).toBe(latestLocaleAPages)
    expect(markedDatasets).toHaveLength(1)
    expect(markedDatasets[0]).toBe(latestLocaleAPages)
  })

  it('preserves keyboard-accessible graph navigation semantics', () => {
    expect(goToPageBody).toContain("event.key !== 'Enter' && event.key !== ' '")
    expect(goToPageBody).toContain('event.preventDefault()')
    expect(goToPageBody).toContain('event.ctrlKey || event.metaKey')
    expect(goToPageBody).toContain("window.open(href, '_blank', 'noopener')")
    expect(goToPageBody).toContain('this.$router.push(String(id))')
    expect(script.match(/\.on\('keydown'/g)).toHaveLength(3)
    expect(script.match(/\.on\('click'/g)).toHaveLength(3)
  })

  it('preserves loading and graph error behavior for page links loading', () => {
    expect(loadPagesBody).toContain("wikiStore.startLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain("wikiStore.stopLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain('wikiStore.showError(err)')
    expect(script).toMatch(/currentLocale\s*\(\)\s*\{\s*this\.loadPages\(\)\s*\}/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPages\(\)\s*\}/)
  })
})
