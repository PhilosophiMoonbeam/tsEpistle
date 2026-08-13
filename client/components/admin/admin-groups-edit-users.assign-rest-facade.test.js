import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.resolve(__dirname, 'admin-groups-edit-users.vue')

function readComponent () {
  return fs.readFileSync(componentPath, 'utf8')
}

describe('admin groups edit users assign REST facade', () => {
  test('assign user flow uses the REST helper instead of the GraphQL mutation', () => {
    const content = readComponent()

    expect(content).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(content).toMatch(/import\s+\{(?=[^}]*\bassignGroupUser\b)(?=[^}]*\bunassignGroupUser\b)(?=[^}]*\bcreateEmptyGroupEditorState\b)(?=[^}]*\bGroupEditorState\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(content).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(content).not.toContain('groups-mutation-assign.gql')
    expect(content).not.toContain('assignUserMutation')
    expect(content).not.toContain('this.$apollo.mutate')
    expect(content).toContain('async assignUser(user: UserSearchRow)')
    expect(content).toContain('await assignGroupUser(window.fetch.bind(window), this.group.id, user.id)')
  })

  test('assign user flow preserves loading, notification, refresh, and error facades', () => {
    const content = readComponent()

    expect(content).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(content).toContain("wikiStore.startLoading('admin-groups-assign')")
    expect(content).toContain("wikiStore.stopLoading('admin-groups-assign')")
    expect(content).toContain('message: `User has been assigned to $' + '{this.group.name}.`')
    expect(content).toContain("this.$emit('refresh')")
    expect(content).toContain("style: 'red'")
    expect(content).toContain('message: getErrorMessage(err)')
    expect(content).toContain("icon: 'warning'")
    expect(content).toMatch(/finally\s*{[\s\S]*wikiStore\.stopLoading\('admin-groups-assign'\)/)
  })
})
