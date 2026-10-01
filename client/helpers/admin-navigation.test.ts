import { describe, expect, test } from '../../server/test/bun-test.mts'
import { buildAdminNavigation, filterAdminNavigation } from './admin-navigation'
import type { SystemSummary } from './system-api'

const summary = { pagesTotal: 15, tagsTotal: 23, usersTotal: 4, groupsTotal: 3 } as SystemSummary
const translate = (key: string) => key.replace('admin:', '').replace('.title', '')
const catalog = (permissions = ['manage:system']) => buildAdminNavigation(translate, permissions, summary)

describe('administration settings discovery', () => {
  test('keeps each setting in one domain and preserves existing destinations', () => {
    const items = catalog().flatMap(group => group.items)
    expect(new Set(items.map(item => item.key)).size).toBe(items.length)
    expect(items.find(item => item.key === 'agents')?.to).toBe('/agents')
    expect(items.find(item => item.key === 'graphql')?.href).toBe('/graphql')
    expect(items.find(item => item.key === 'pages')?.count).toBe(15)
  })
  test('discovers page recovery and integrity only for system administrators', () => {
    const adminPaths = catalog(['manage:system']).flatMap(group => group.items.map(item => item.to))
    const pageWriterPaths = catalog(['write:pages']).flatMap(group => group.items.map(item => item.to))
    expect(adminPaths).toContain('/pages/recycle-bin')
    expect(adminPaths).toContain('/pages/integrity')
    expect(pageWriterPaths).not.toContain('/pages/recycle-bin')
    expect(pageWriterPaths).not.toContain('/pages/integrity')
  })

  test('filters before searching so restricted settings cannot leak into results', () => {
    expect(catalog([])).toEqual([])
    const scoped = catalog(['write:pages'])
    expect(scoped.flatMap(group => group.items.map(item => item.key))).toEqual(['pages'])
    expect(filterAdminNavigation(scoped, 'MCP')).toEqual([])
    expect(catalog(['manage:api']).flatMap(group => group.items.map(item => item.key))).toEqual(['api', 'dev-flags', 'graphql'])
  })

  test('finds settings by synonyms and combined terms without changing the catalog', () => {
    const groups = catalog()
    const originalGroups = structuredClone(groups)
    expect(filterAdminNavigation(groups, '  mCp  ').flatMap(group => group.items.map(item => item.key))).toEqual(['agents', 'api'])
    expect(filterAdminNavigation(groups, 'members')[0].items[0].key).toBe('users')
    expect(filterAdminNavigation(groups, 'backup sync')[0].items[0].key).toBe('storage')
    expect(filterAdminNavigation(groups, 'not-a-setting')).toEqual([])
    expect(filterAdminNavigation(groups, '')).toEqual(originalGroups)
    expect(groups).toEqual(originalGroups)
  })
})
