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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const executeLoadPages = new AsyncFunction(
  'fetchPageLinks',
  'wikiStore',
  'window',
  loadPagesBody.slice(loadPagesBody.indexOf('{') + 1, loadPagesBody.lastIndexOf('}'))
)

describe('admin pages visualize REST facade', () => {
  it('loads page links through the pages REST helper instead of Apollo', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { fetchPageLinks, type PageLinkRow } from '../../helpers/pages-api'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toMatch(/apollo\s*:/)
    expect(script).not.toContain('this.$apollo')
    expect(script).not.toContain('pages {')
    expect(loadPagesBody).toContain('await fetchPageLinks(')
    expect(loadPagesBody).toContain('window.fetch.bind(window)')
    expect(loadPagesBody).toContain('this.currentLocale')
  })

  it('keeps the latest locale rendered when an older locale resolves afterward', async () => {
    const pendingRequests = new Map()
    const fetchPageLinks = (_fetch, locale) =>
      new Promise(resolve => {
        pendingRequests.set(locale, resolve)
      })
    const wikiStore = {
      startLoading() {},
      stopLoading() {},
      showError() {}
    }
    const browserWindow = { fetch() {} }
    const state = {
      currentLocale: 'A',
      pageLoadRequestId: 0,
      pages: []
    }
    const localeAPages = [{ id: 1, path: 'a', title: 'Locale A', links: [] }]
    const localeBPages = [{ id: 2, path: 'b', title: 'Locale B', links: [] }]

    const localeARequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, browserWindow)
    state.currentLocale = 'B'
    const localeBRequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, browserWindow)

    pendingRequests.get('B')(localeBPages)
    await localeBRequest
    expect(state.pages).toBe(localeBPages)

    pendingRequests.get('A')(localeAPages)
    await localeARequest
    expect(state.pages).toBe(localeBPages)
  })

  it('preserves loading and graph error behavior for page links loading', () => {
    expect(loadPagesBody).toContain("wikiStore.startLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain("wikiStore.stopLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain('wikiStore.showError(err)')
    expect(script).toMatch(/currentLocale\s*\(\)\s*\{\s*this\.loadPages\(\)\s*\}/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPages\(\)\s*\}/)
  })
})
