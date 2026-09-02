import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-tags.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
const mountedStart = script.indexOf('mounted () {')
const mountedEnd = script.indexOf('  }', mountedStart)
const mountedBody = script.slice(mountedStart, mountedEnd)
const refreshStart = script.indexOf('async refresh(notify = true) {')
const refreshEnd = script.indexOf('  },', refreshStart)
const refreshBody = script.slice(refreshStart, refreshEnd)
const deleteTagStart = script.indexOf('async deleteTag(tag: EditablePageTagRow) {')
const deleteTagEnd = script.indexOf('    async saveTag', deleteTagStart)
const deleteTagBody = script.slice(deleteTagStart, deleteTagEnd)
const saveTagStart = script.indexOf('async saveTag(tag: EditablePageTagRow) {')
const saveTagEnd = script.indexOf('    async refresh', saveTagStart)
const saveTagBody = script.slice(saveTagStart, saveTagEnd)
const filteredTagsStart = script.indexOf('filteredTags (): EditablePageTagRow[] {')
const filteredTagsEnd = script.indexOf('    tagValid', filteredTagsStart)
const filteredTagsBody = script.slice(filteredTagsStart, filteredTagsEnd)
const selectTagStart = script.indexOf('selectTag(tag: EditablePageTagRow) {')
const selectTagEnd = script.indexOf('    async deleteTag', selectTagStart)
const selectTagBody = script.slice(selectTagStart, selectTagEnd)

describe('admin tags REST update facade', () => {
  it('routes tag updates through the pages REST helper instead of the updateTag GraphQL mutation', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { deletePageTag, fetchPageTags, updatePageTag } from '../../helpers/pages-api'")
    expect(script).toContain("import type { PageTagRow } from '../../helpers/pages-api'")
    expect(script).toContain("type EditablePageTagRow = Omit<PageTagRow, 'updatedAt'>")
    expect(saveTagBody).toContain('await updatePageTag(')
    expect(saveTagBody).toContain('window.fetch.bind(window)')
    expect(saveTagBody).toContain('tag.id')
    expect(saveTagBody).toContain('tag.tag')
    expect(saveTagBody).toContain('tag.title')
    expect(saveTagBody).not.toContain('this.$apollo.mutate')
    expect(saveTagBody).not.toContain('updateTag')
    expect(saveTagBody).not.toContain('data.pages.updateTag')
  })

  it('preserves tag update loading, notification, timestamp, and graph error behavior', () => {
    expect(saveTagBody).toContain("wikiStore.startLoading('admin-tags-save')")
    expect(saveTagBody).toContain("wikiStore.stopLoading('admin-tags-save')")
    expect(saveTagBody).toContain("message: this.$t('admin:tags.saveSuccess')")
    expect(saveTagBody).toContain("style: 'success'")
    expect(saveTagBody).toContain("icon: 'check'")
    expect(saveTagBody).toContain('this.current.updatedAt = new Date()')
    expect(saveTagBody).toContain('wikiStore.showError(err)')
  })
})

describe('admin tags REST delete facade', () => {
  it('routes tag deletes through the pages REST helper instead of the deleteTag GraphQL mutation', () => {
    expect(script).toContain("import { deletePageTag, fetchPageTags, updatePageTag } from '../../helpers/pages-api'")
    expect(deleteTagBody).toContain('await deletePageTag(')
    expect(deleteTagBody).toContain('window.fetch.bind(window)')
    expect(deleteTagBody).toContain('tag.id')
    expect(deleteTagBody).not.toContain('this.$apollo.mutate')
    expect(deleteTagBody).not.toContain('deleteTag (id: $id)')
    expect(deleteTagBody).not.toContain('data.pages.deleteTag')
  })

  it('preserves confirmation, exclusive loading, success notification, post-delete refresh, and error behavior', () => {
    expect(source).toMatch(
      /v-dialog\(v-model=['"]deleteTagDialog['"][^)]*\)[\s\S]*?admin:tags\.deleteConfirmText[\s\S]*?@click=['"]deleteTag\(current\)['"][^)]*:loading=['"]deleting['"]/
    )
    expect(deleteTagBody).toMatch(/if\s*\(\s*this\.deleting\s*\)\s*return/)
    expect(deleteTagBody).toContain("wikiStore.startLoading('admin-tags-delete')")
    expect(deleteTagBody).toContain("wikiStore.stopLoading('admin-tags-delete')")
    expect(deleteTagBody).toContain("message: this.$t('admin:tags.deleteSuccess')")
    expect(deleteTagBody).toContain("style: 'success'")
    expect(deleteTagBody).toContain("icon: 'check'")
    expect(deleteTagBody).toContain('this.deleteTagDialog = false')
    expect(deleteTagBody).toContain('wikiStore.showError(err)')
    expect(deleteTagBody).toMatch(/if\s*\(\s*deleted\s*\)\s*await\s+this\.refresh\s*\(\s*false\s*\)/)

    const deleteIndex = deleteTagBody.indexOf('await deletePageTag(')
    const closeIndex = deleteTagBody.indexOf('this.deleteTagDialog = false')
    const stopIndex = deleteTagBody.indexOf("wikiStore.stopLoading('admin-tags-delete')")
    const refreshIndex = deleteTagBody.indexOf('await this.refresh(false)')
    expect(closeIndex).toBeGreaterThan(deleteIndex)
    expect(stopIndex).toBeGreaterThan(closeIndex)
    expect(refreshIndex).toBeGreaterThan(stopIndex)
  })
})

describe('admin tags REST query facade', () => {
  it('loads tags through the pages REST helper instead of Apollo', () => {
    expect(script).toContain("import { deletePageTag, fetchPageTags, updatePageTag } from '../../helpers/pages-api'")
    expect(script).not.toContain("import gql from 'graphql-tag'")
    expect(script).not.toContain('apollo:')
    expect(script).not.toContain('this.$apollo.queries.tags.refetch')
    expect(refreshBody).toContain('this.tags = await fetchPageTags(window.fetch.bind(window))')
    expect(refreshBody).not.toContain('cloneDeep')
    expect(script).not.toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(mountedBody).toContain('this.refresh(false)')
  })

  it('uses native filtering and keeps the selected tag as the directly editable list row', () => {
    expect(filteredTagsBody).toContain('this.tags.filter(t =>')
    expect(filteredTagsBody).toContain('t.tag.toLocaleLowerCase().includes(query)')
    expect(filteredTagsBody).toContain('t.title?.toLocaleLowerCase().includes(query)')
    expect(filteredTagsBody).not.toContain('_.filter')
    expect(selectTagBody).toContain('this.current = tag')
    expect(selectTagBody).not.toContain('cloneDeep')
    expect(source).toContain("@keydown.enter.prevent='selectTag(tag)'")
    expect(source).toContain("@keydown.space.prevent='selectTag(tag)'")
  })

  it('preserves tag refresh loading, notification, selection reset, and graph error behavior', () => {
    expect(refreshBody).toContain("wikiStore.startLoading('admin-tags-refresh')")
    expect(refreshBody).toContain("wikiStore.stopLoading('admin-tags-refresh')")
    expect(refreshBody).toContain('this.current = makeEmptyTag()')
    expect(refreshBody).toContain('if (notify)')
    expect(refreshBody).toContain("message: this.$t('admin:tags.refreshSuccess')")
    expect(refreshBody).toContain("style: 'success'")
    expect(refreshBody).toContain("icon: 'cached'")
    expect(refreshBody).toContain('wikiStore.showError(err)')
  })
})
