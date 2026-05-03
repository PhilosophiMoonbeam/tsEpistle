const fs = require('fs')
const path = require('path')

describe('admin-webhooks stale mail GraphQL cleanup guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-webhooks.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-webhooks no longer carries broken mail config GraphQL scaffolding', () => {
    expect(script).not.toBeNull()
    expect(script).not.toContain('mail-query-config.gql')
    expect(script).not.toContain('mail-mutation-save-config.gql')
    expect(script).not.toContain('mailConfigQuery')
    expect(script).not.toContain('mailUpdateConfigMutation')
    expect(script).not.toContain('this.$apollo')
    expect(script).not.toContain('this.config.senderName')
    expect(script).not.toContain('data.mail.config')
    expect(source).not.toContain('@click=\'save\'')
  })
})
