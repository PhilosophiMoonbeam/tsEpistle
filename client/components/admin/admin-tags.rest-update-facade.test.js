const fs = require('fs')
const path = require('path')

const componentPath = path.join(__dirname, 'admin-tags.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
const mountedStart = script.indexOf('mounted () {')
const mountedEnd = script.indexOf('  }', mountedStart)
const mountedBody = script.slice(mountedStart, mountedEnd)
const refreshStart = script.indexOf('async refresh(notify = true) {')
const refreshEnd = script.indexOf('  },', refreshStart)
const refreshBody = script.slice(refreshStart, refreshEnd)
const deleteTagStart = script.indexOf('async deleteTag(tag) {')
const deleteTagEnd = script.indexOf('    async saveTag', deleteTagStart)
const deleteTagBody = script.slice(deleteTagStart, deleteTagEnd)
const saveTagStart = script.indexOf('async saveTag(tag) {')
const saveTagEnd = script.indexOf('    async refresh', saveTagStart)
const saveTagBody = script.slice(saveTagStart, saveTagEnd)

describe('admin tags REST update facade', () => {
  it('routes tag updates through the pages REST helper instead of the updateTag GraphQL mutation', () => {
    expect(script).toContain("import { deletePageTag, fetchPageTags, updatePageTag } from '../../helpers/pages-api'")
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
    expect(saveTagBody).toContain("this.$store.commit(`loadingStart`, 'admin-tags-save')")
    expect(saveTagBody).toContain("this.$store.commit(`loadingStop`, 'admin-tags-save')")
    expect(saveTagBody).toContain("message: this.$t('tags.saveSuccess')")
    expect(saveTagBody).toContain("style: 'success'")
    expect(saveTagBody).toContain("icon: 'check'")
    expect(saveTagBody).toContain('this.current.updatedAt = new Date()')
    expect(saveTagBody).toContain("this.$store.commit('pushGraphError', err)")
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

  it('preserves tag delete loading, notification, refresh, dialog, and graph error behavior', () => {
    expect(deleteTagBody).toContain("this.$store.commit(`loadingStart`, 'admin-tags-delete')")
    expect(deleteTagBody).toContain("this.$store.commit(`loadingStop`, 'admin-tags-delete')")
    expect(deleteTagBody).toContain("message: this.$t('tags.deleteSuccess')")
    expect(deleteTagBody).toContain("style: 'success'")
    expect(deleteTagBody).toContain("icon: 'check'")
    expect(deleteTagBody).toContain('this.refresh()')
    expect(deleteTagBody).toContain('this.deleteTagDialog = false')
    expect(deleteTagBody).toContain("this.$store.commit('pushGraphError', err)")
  })
})

describe('admin tags REST query facade', () => {
  it('loads tags through the pages REST helper instead of Apollo', () => {
    expect(script).toContain("import { deletePageTag, fetchPageTags, updatePageTag } from '../../helpers/pages-api'")
    expect(script).not.toContain("import gql from 'graphql-tag'")
    expect(script).not.toContain('apollo:')
    expect(script).not.toContain('this.$apollo.queries.tags.refetch')
    expect(refreshBody).toContain('await fetchPageTags(window.fetch.bind(window))')
    expect(refreshBody).toContain('this.tags = _.cloneDeep(')
    expect(mountedBody).toContain('this.refresh(false)')
  })

  it('preserves tag refresh loading, notification, selection reset, and graph error behavior', () => {
    expect(refreshBody).toContain("this.$store.commit(`loadingStart`, 'admin-tags-refresh')")
    expect(refreshBody).toContain("this.$store.commit(`loadingStop`, 'admin-tags-refresh')")
    expect(refreshBody).toContain('this.current = {}')
    expect(refreshBody).toContain('if (notify)')
    expect(refreshBody).toContain("message: this.$t('tags.refreshSuccess')")
    expect(refreshBody).toContain("style: 'success'")
    expect(refreshBody).toContain("icon: 'cached'")
    expect(refreshBody).toContain("this.$store.commit('pushGraphError', err)")
  })
})
