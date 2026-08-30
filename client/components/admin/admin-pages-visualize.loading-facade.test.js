import fs from 'node:fs'
import path from 'node:path'

describe('admin-pages-visualize loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages-visualize.vue')
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

  test('admin-pages-visualize.vue uses the typed wiki store facade for page visualization refresh loading', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")

    expect(loadPagesBody).toContain("wikiStore.startLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain("wikiStore.stopLoading('admin-pages-refresh')")

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*(?:`loading|['"]loading(?:Start|Stop)['"])/)

    const startLoadingCalls = source.match(/\bwikiStore\.startLoading\s*\(/g) || []
    const stopLoadingCalls = source.match(/\bwikiStore\.stopLoading\s*\(/g) || []
    expect(startLoadingCalls).toHaveLength(1)
    expect(stopLoadingCalls).toHaveLength(1)
  })

  test('only the latest locale request presents errors while every request releases refresh loading', async () => {
    const pendingRequests = new Map()
    const fetchPageLinks = (_fetch, locale) =>
      new Promise((resolve, reject) => {
        pendingRequests.set(locale, { resolve, reject })
      })
    const loadingEvents = []
    const errors = []
    const wikiStore = {
      startLoading(key) {
        loadingEvents.push(['start', key])
      },
      stopLoading(key) {
        loadingEvents.push(['stop', key])
      },
      showError(err) {
        errors.push(err)
      }
    }
    const browserWindow = { fetch() {} }
    const state = {
      currentLocale: 'A',
      pageLoadRequestId: 0,
      pages: []
    }

    const localeARequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, browserWindow)
    state.currentLocale = 'B'
    const localeBRequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, browserWindow)

    pendingRequests.get('B').resolve([{ id: 2, path: 'b', title: 'Locale B', links: [] }])
    await localeBRequest
    expect(loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])

    pendingRequests.get('A').reject(new Error('stale locale A failure'))
    await localeARequest
    expect(errors).toEqual([])
    expect(loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])
  })
})
