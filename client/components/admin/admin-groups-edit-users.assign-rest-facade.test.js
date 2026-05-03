const fs = require('fs')
const path = require('path')

const componentPath = path.resolve(__dirname, 'admin-groups-edit-users.vue')

function readComponent () {
  return fs.readFileSync(componentPath, 'utf8')
}

describe('admin groups edit users assign REST facade', () => {
  test('assign user flow uses the REST helper instead of the GraphQL mutation', () => {
    const content = readComponent()

    expect(content).toContain("import { assignGroupUser, unassignGroupUser } from '../../helpers/groups-api'")
    expect(content).not.toContain('groups-mutation-assign.gql')
    expect(content).not.toContain('assignUserMutation')
    expect(content).not.toContain('this.$apollo.mutate')
    expect(content).toContain('await assignGroupUser(window.fetch.bind(window), this.group.id, id)')
  })

  test('assign user flow preserves loading, notification, refresh, and error facades', () => {
    const content = readComponent()

    expect(content).toContain("import { loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'")
    expect(content).toContain("loadingStart(this.$store, 'admin-groups-assign')")
    expect(content).toContain("loadingStop(this.$store, 'admin-groups-assign')")
    expect(content).toContain('message: `User has been assigned to $' + '{this.group.name}.`')
    expect(content).toContain("this.$emit('refresh')")
    expect(content).toContain("style: 'red'")
    expect(content).toContain("icon: 'warning'")
    expect(content).toMatch(/finally\s*{[\s\S]*loadingStop\(this\.\$store, 'admin-groups-assign'\)/)
  })
})
