const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '../../..')
const sourcePath = path.join(repoRoot, 'client/components/admin/admin-mail.vue')

function scriptBlock () {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const match = source.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) {
    throw new Error('admin-mail script block not found')
  }
  return match[1]
}

function methodBlock (script, methodName) {
  const start = script.indexOf(`async ${methodName} (`)
  if (start === -1) {
    throw new Error(`${methodName} method not found`)
  }
  const nextMethod = script.indexOf('\n    async ', start + 1)
  const end = nextMethod === -1 ? script.indexOf('\n  },', start) : nextMethod
  return script.slice(start, end)
}

describe('admin mail REST facade', () => {
  test('uses mail REST helper for test emails and no mail send GraphQL document', () => {
    const script = scriptBlock()

    expect(script).toMatch(/import\s+\{\s*sendMailTest\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/mail-api['"]/)
    expect(script).not.toContain('mail-mutation-sendtest.gql')
    expect(script).not.toContain('mailTestMutation')
  })

  test('sendTest preserves loading, payload, success, cleanup, and error handling behavior', () => {
    const sendTest = methodBlock(scriptBlock(), 'sendTest')

    expect(sendTest).toContain("this.$store.commit(`loadingStart`, 'admin-mail-test')")
    expect(sendTest).toContain("await sendMailTest(window.fetch.bind(window), this.testEmail, 'An unexpected error occurred.')")
    expect(sendTest).toContain("this.testEmail = ''")
    expect(sendTest).toContain("message: this.$t('admin:mail.sendTestSuccess')")
    expect(sendTest).toContain("this.$store.commit('pushGraphError', err)")
    expect(sendTest).toContain("this.$store.commit(`loadingStop`, 'admin-mail-test')")
    expect(sendTest).not.toContain('this.$apollo.mutate')
    expect(sendTest).not.toContain('data.mail.sendTest.responseResult')
  })
})
