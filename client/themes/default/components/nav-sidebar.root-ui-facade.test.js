import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/themes/default/components/nav-sidebar.vue'), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]

describe('default nav-sidebar REST browse migration guard', () => {
  test('loads page trees through the REST helper and loading facades', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent, type PropType } from 'vue'")
    expect(script).toContain("import { fetchPageTree, type PageTreeRow } from '../../../helpers/pages-api'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { loadingStart, loadingStop } from '../../../helpers/root-ui-store'")
    expect(script).toMatch(/async fetchBrowseItems\s*\(\s*requestedItem\?\s*:\s*NavigationTreeItem\s*\)[\s\S]*?const item\s*=\s*requestedItem\s*\|\|\s*this\.currentParent[\s\S]*?fetchPageTree\(window\.fetch\.bind\(window\),\s*\{[\s\S]*parent: item\.id,[\s\S]*locale: this\.locale,[\s\S]*mode: 'ALL'/)
    expect(script).toMatch(/async loadFromCurrentPath\s*\(\)[\s\S]*fetchPageTree\(window\.fetch\.bind\(window\),\s*\{[\s\S]*path: this\.path,[\s\S]*locale: this\.locale,[\s\S]*mode: 'ALL',[\s\S]*includeAncestors: true/)
    expect(script).toMatch(/loadingStart\(wikiStore,\s*'browse-load'\)[\s\S]*loadingStop\(wikiStore,\s*'browse-load'\)/)
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves cache, ancestor, mode, and home navigation behavior', () => {
    expect(script).toContain('this.loadedCache = _.union(this.loadedCache, [item.id])')
    expect(script).toContain("const curPage = _.find(items, ['pageId', wikiStore.page.id])")
    expect(script).toContain('this.parents = [this.currentParent, ...invertedAncestors.reverse()]')
    expect(script).toContain("window.localStorage.setItem('navPref', mode)")
    expect(script).toMatch(/window\.location\.assign\(siteLangs\.length > 0 \? `\/\$\{this\.locale\}\/home` : '\/'\)/)
  })
})
