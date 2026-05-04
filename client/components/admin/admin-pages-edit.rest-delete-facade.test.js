const fs = require('fs')
const path = require('path')

const componentPath = path.join(__dirname, 'admin-pages-edit.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
const deletePageStart = script.indexOf('async deletePage() {')
const deletePageEnd = script.indexOf('    async rerenderPage', deletePageStart)
const deletePageBody = script.slice(deletePageStart, deletePageEnd)

describe('admin pages edit REST delete facade', () => {
  it('routes page deletes through the pages REST helper instead of the common GraphQL mutation', () => {
    expect(script).toContain("import { deletePage as deletePageById } from '../../helpers/pages-api'")
    expect(script).not.toContain('common-pages-mutation-delete.gql')
    expect(script).not.toContain('deletePageMutation')
    expect(deletePageBody).toContain('await deletePageById(')
    expect(deletePageBody).toContain('window.fetch.bind(window)')
    expect(deletePageBody).toContain('this.page.id')
    expect(deletePageBody).not.toContain('this.$apollo.mutate')
    expect(deletePageBody).not.toContain('data.pages.delete.responseResult')
  })

  it('preserves page delete loading, notification, navigation, and graph error behavior', () => {
    expect(deletePageBody).toContain('this.loading = true')
    expect(deletePageBody).toContain("this.$store.commit(`loadingStart`, 'page-delete')")
    expect(deletePageBody).toContain("this.$store.commit(`loadingStop`, 'page-delete')")
    expect(deletePageBody).toContain("style: 'green'")
    expect(deletePageBody).toContain('message: `Page deleted successfully.`')
    expect(deletePageBody).toContain("icon: 'check'")
    expect(deletePageBody).toContain("this.$router.replace('/pages')")
    expect(deletePageBody).toContain("this.$store.commit('pushGraphError', err)")
  })
})
