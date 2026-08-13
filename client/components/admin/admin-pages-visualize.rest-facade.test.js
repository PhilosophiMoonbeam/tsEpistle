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

  it('preserves loading and graph error behavior for page links loading', () => {
    expect(loadPagesBody).toContain("wikiStore.startLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain("wikiStore.stopLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain('wikiStore.showError(err)')
    expect(script).toMatch(/currentLocale\s*\(\)\s*\{\s*this\.loadPages\(\)\s*\}/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPages\(\)\s*\}/)
  })
})
