import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/themes/default/components/nav-sidebar.vue'), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]

describe('default nav-sidebar navigation mode and fixed Home behavior', () => {
  test('loads both page-tree flows through AbortController-owned REST requests and balanced loading facades', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent, markRaw, type PropType } from 'vue'")
    expect(script).toContain("import { fetchPageTree, type PageTreeRow } from '../../../helpers/pages-api'")
    expect(script).toContain("import { isWikiNavigationClick, navigateToWikiPage } from '../../../helpers/wiki-navigation'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { loadingStart, loadingStop } from '../../../helpers/root-ui-store'")
    expect(script.match(/const requestSequence = \+\+this\.browseRequestSequence/g)).toHaveLength(2)
    expect(script.match(/this\.browseRequestController\?\.abort\(\)/g)).toHaveLength(3)
    expect(script.match(/const requestController = markRaw\(new AbortController\(\)\)/g)).toHaveLength(2)
    expect(script.match(/this\.browseRequestController = requestController/g)).toHaveLength(2)
    expect(script.match(/\(url, init\) => window\.fetch\(url, \{ \.\.\.init, signal: requestController\.signal \}\)/g)).toHaveLength(2)
    expect(script).toMatch(
      /async fetchBrowseItems\s*\(\s*requestedItem\?\s*:\s*NavigationTreeItem\s*\)[\s\S]*?const locale\s*=\s*this\.locale[\s\S]*?const item\s*=\s*requestedItem\s*\|\|\s*this\.currentParent[\s\S]*?fetchPageTree\(\s*\(url, init\) => window\.fetch\(url, \{ \.\.\.init, signal: requestController\.signal \}\),\s*\{\s*parent: item\.id,\s*locale,\s*mode: 'ALL'/
    )
    expect(script).toMatch(
      /async loadFromCurrentPath\s*\(\)[\s\S]*?const locale\s*=\s*this\.locale[\s\S]*?const path\s*=\s*this\.path[\s\S]*?const pageId\s*=\s*wikiStore\.page\.id[\s\S]*?fetchPageTree\(\s*\(url, init\) => window\.fetch\(url, \{ \.\.\.init, signal: requestController\.signal \}\),\s*\{\s*path,\s*locale,\s*mode: 'ALL',\s*includeAncestors: true/
    )
    expect(script.match(/loadingStart\(wikiStore,\s*'browse-load'\)/g)).toHaveLength(2)
    expect(script.match(/loadingStop\(wikiStore,\s*'browse-load'\)/g)).toHaveLength(2)
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves cache, ancestor, page-location, mode, and home navigation behavior', () => {
    expect(script).toContain('this.loadedCache = _.union(this.loadedCache, [item.id])')
    expect(script).toContain("const curPage = _.find(items, ['pageId', pageId])")
    expect(script).toContain('this.parents = [this.currentParent, ...invertedAncestors.reverse()]')
    expect(script).toContain('this.loadedCache = [curPage.parent]')
    expect(script).toContain("window.localStorage.setItem('navPref', mode)")
    expect(script).toMatch(/navigateToWikiPage\(siteLangs\.length > 0 \? `\/\$\{this\.locale\}\/home` : '\/'\)/)
    expect(script).toMatch(
      /pageLocationKey \(value: string, previous: string\) \{\s*if \(value === previous \|\| this\.currentMode !== 'browse'\) return\s*this\.resetBrowseRoot\(\)\s*if \(this\.expandParentByDefault\) void this\.loadFromCurrentPath\(\)\s*else void this\.fetchBrowseItems\(this\.currentParent\)/
    )
    expect(script).toContain('if (this.expandParentByDefault) this.loadFromCurrentPath()')
    expect(script).toContain('else this.fetchBrowseItems()')
  })

  test('lets only the latest page-tree request mutate browse state and balances every started load', () => {
    expect(script).toContain('browseRequestSequence: 0')
    expect(script).toContain('browseRequestController: null as AbortController | null')
    expect(script.match(/if \(requestSequence !== this\.browseRequestSequence\) return/g)).toHaveLength(2)
    expect(script.match(/if \(!requestController\.signal\.aborted && requestSequence === this\.browseRequestSequence\) \{/g)).toHaveLength(2)
    expect(script.match(/if \(this\.browseRequestController === requestController\) this\.browseRequestController = null/g)).toHaveLength(2)
    expect(script.match(/if \(requestSequence === this\.browseRequestSequence\) this\.navLoading = false/g)).toHaveLength(2)
    expect(
      script.match(
        /finally\s*\{\s*if \(this\.browseRequestController === requestController\) this\.browseRequestController = null\s*if \(requestSequence === this\.browseRequestSequence\) this\.navLoading = false\s*loadingStop\(wikiStore, 'browse-load'\)\s*\}/g
      )
    ).toHaveLength(2)
    expect(script).toMatch(
      /async fetchBrowseItems[\s\S]*?const items = await fetchPageTree[\s\S]*?if \(requestSequence !== this\.browseRequestSequence\) return\s*this\.currentItems = items[\s\S]*?catch \(error\) \{\s*if \(!requestController\.signal\.aborted && requestSequence === this\.browseRequestSequence\) \{\s*this\.navError =/
    )
    expect(script).toMatch(
      /async loadFromCurrentPath[\s\S]*?const items = await fetchPageTree[\s\S]*?if \(requestSequence !== this\.browseRequestSequence\) return\s*const curPage[\s\S]*?this\.currentItems = _.filter\(items, \['parent', curPage\.parent\]\)[\s\S]*?catch \(error\) \{\s*if \(!requestController\.signal\.aborted && requestSequence === this\.browseRequestSequence\) \{\s*this\.navError =/
    )
    expect(script).toMatch(
      /beforeUnmount\s*\(\)\s*\{\s*this\.browseRequestSequence \+= 1\s*this\.browseRequestController\?\.abort\(\)\s*this\.browseRequestController = null\s*\}/
    )
  })

  test('retries the correct browse flow after a load error', () => {
    expect(source).toContain("@retry='retryBrowse'")
    expect(script).toMatch(
      /retryBrowse\s*\(\)\s*\{\s*if \(this\.currentParent\.id === 0 && this\.expandParentByDefault && this\.loadedCache\.length < 1\) \{\s*void this\.loadFromCurrentPath\(\)\s*\} else \{\s*void this\.fetchBrowseItems\(this\.currentParent\)\s*\}\s*\}/
    )
  })

  test('announces every SPA sidebar destination before navigation', () => {
    expect(script).toContain("emits: ['navigate']")
    expect(source.match(/@click='sidebarLinkClicked'/g)).toHaveLength(3)
    expect(source).toMatch(/v-if='item\.k === `link`'[\s\S]*?:href='item\.t'[\s\S]*?@click='sidebarLinkClicked'/)
    expect(source).toMatch(/v-list-item\.nav-sidebar-current-page\([\s\S]*?:href='pagePath\(currentParent\)'[\s\S]*?@click='sidebarLinkClicked'/)
    expect(source).toMatch(/v-list-item\.nav-sidebar-page\([^\n]+:href='[^']+item\.locale[^']+item\.path'[^\n]+@click='sidebarLinkClicked'/)
    expect(script).toMatch(/sidebarLinkClicked\s*\(event: MouseEvent\)\s*\{[\s\S]*?isWikiNavigationClick\(event, target\)[\s\S]*?this\.\$emit\('navigate'\)/)
    expect(script).toMatch(
      /goHome\s*\(\)\s*\{\s*this\.\$emit\('navigate'\)\s*navigateToWikiPage\(siteLangs\.length > 0 \? `\/\$\{this\.locale\}\/home` : '\/'\)/
    )
  })

  test('offers permission-scoped parent editing from a child page', () => {
    expect(source).toContain("v-if='canEditCurrentParent'")
    expect(source).toContain(":href='editPath(currentParent)'")
    expect(script).toContain('this.currentParent.canEdit === true && this.currentParent.pageId !== wikiStore.page.id')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this assertion intentionally matches source text.
    expect(script).toContain("return `/e${item.visibility === 'private' ? '/_private' : ''}/${item.locale}/${item.path}`")
  })
  test('renders a centered labeled structural Home control above STATIC options', () => {
    expect(source.match(/v-btn\.nav-sidebar-home\(/g)).toHaveLength(1)
    expect(source).toContain("v-if='navMode === `MIXED` || navMode === `STATIC`'")
    expect(source).toContain(':class=\'{ "nav-sidebar-switcher--static": navMode === `STATIC` }\'')
    expect(source).toContain(':class=\'{ "nav-sidebar-home--static": navMode === `STATIC` }\'')
    expect(source).toContain(":aria-label='$t(`common:header.home`)'")
    expect(source).toContain("v-icon(:start='navMode === `STATIC`', size='20') mdi-home")
    expect(source).toContain("span.nav-sidebar-home-label.text-body-medium.text-none(v-if='navMode === `STATIC`') {{$t('common:header.home')}}")
    expect(source).toMatch(
      /&\.nav-sidebar-switcher--static\s*\{[\s\S]*?justify-content: center;[\s\S]*?\.nav-sidebar-home--static\s*\{[\s\S]*?width: calc\(100% - \(var\(--wiki-space-6\) \* 2\)\);/
    )

    const structuralHomeIndex = source.indexOf('v-btn.nav-sidebar-home(')
    const optionsDividerIndex = source.indexOf('v-divider.nav-sidebar-edge')
    const customOptionsIndex = source.indexOf('v-list.nav-sidebar-list.py-2')
    expect(structuralHomeIndex).toBeGreaterThan(-1)
    expect(optionsDividerIndex).toBeGreaterThan(structuralHomeIndex)
    expect(customOptionsIndex).toBeGreaterThan(optionsDividerIndex)
    expect(source).toContain("template(v-for='(item, idx) of customItems'")
    expect(script).toContain("return this.items.filter(item => item.k !== 'link' || item.y !== 'home')")
  })

  test('keeps MIXED mode switching and TREE browsing structurally intact', () => {
    expect(source).toMatch(/v-btn\.nav-sidebar-mode[\s\S]*?v-if='navMode === `MIXED` && currentMode === `custom`'[\s\S]*?common:sidebar\.browse/)
    expect(source).toMatch(/v-btn\.nav-sidebar-mode[\s\S]*?v-else-if='navMode === `MIXED` && currentMode === `browse`'[\s\S]*?common:sidebar\.mainMenu/)
    expect(source).toMatch(/v-if='currentMode === `custom`'/)
    expect(source).toMatch(/v-else-if='currentMode === `browse`'/)
    expect(script).toMatch(/if \(this\.navMode === 'TREE'\) \{\s*this\.currentMode = 'browse'/)
    expect(script).toMatch(/else if \(this\.navMode === 'STATIC'\) \{\s*this\.currentMode = 'custom'/)
  })

  test('ignores invalid localStorage preferences and falls back to custom mode', () => {
    const mounted = script.match(/mounted\s*\(\s*\) \{[\s\S]*?\n {2}\}\n\}\)/)?.[0]
    expect(mounted).toBeDefined()
    expect(mounted).toMatch(/const \w+ = window\.localStorage\.getItem\('navPref'\)/)
    expect(mounted).toMatch(/(?:=== ['"]custom['"]|includes\(['"]custom['"]\))/)
    expect(mounted).toMatch(/(?:=== ['"]browse['"]|includes\(['"]browse['"]\))/)
    expect(mounted).toMatch(/:\s*['"]custom['"]/)
  })
})
