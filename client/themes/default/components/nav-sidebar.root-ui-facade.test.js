const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(process.cwd(), 'client/themes/default/components/nav-sidebar.vue'), 'utf8')
const script = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)[1]

describe('default nav-sidebar REST browse migration guard', () => {
  test('loads page trees through the REST helper and loading facades', () => {
    expect(script).toContain("import { fetchPageTree } from '../../../helpers/pages-api'")
    expect(script).toContain("import { loadingStart, loadingStop } from '../../../helpers/root-ui-store'")
    expect(script).toMatch(/async fetchBrowseItems\s*\(item\)[\s\S]*fetchPageTree\(window\.fetch\.bind\(window\),\s*\{[\s\S]*parent: item\.id,[\s\S]*locale: this\.locale,[\s\S]*mode: 'ALL'/)
    expect(script).toMatch(/async loadFromCurrentPath\s*\(\)[\s\S]*fetchPageTree\(window\.fetch\.bind\(window\),\s*\{[\s\S]*path: this\.path,[\s\S]*includeAncestors: true/)
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves cache, ancestor, mode, and home navigation behavior', () => {
    expect(script).toContain('this.loadedCache = _.union(this.loadedCache, [item.id])')
    expect(script).toContain("const curPage = _.find(items, ['pageId', this.$store.get('page/id')])")
    expect(script).toContain('this.parents = [this.currentParent, ...invertedAncestors.reverse()]')
    expect(script).toContain("window.localStorage.setItem('navPref', mode)")
    expect(script).toMatch(/window\.location\.assign\(siteLangs\.length > 0 \? `\/\$\{this\.locale\}\/home` : '\/'\)/)
  })
})
