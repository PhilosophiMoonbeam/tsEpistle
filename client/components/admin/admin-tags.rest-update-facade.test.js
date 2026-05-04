const fs = require('fs')
const path = require('path')

const componentPath = path.join(__dirname, 'admin-tags.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
const saveTagStart = script.indexOf('async saveTag(tag) {')
const saveTagEnd = script.indexOf('    async refresh', saveTagStart)
const saveTagBody = script.slice(saveTagStart, saveTagEnd)

describe('admin tags REST update facade', () => {
  it('routes tag updates through the pages REST helper instead of the updateTag GraphQL mutation', () => {
    expect(script).toContain("import { updatePageTag } from '../../helpers/pages-api'")
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
