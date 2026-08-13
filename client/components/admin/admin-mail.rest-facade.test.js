import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const repoRoot = path.resolve(__dirname, '../../..')
const sourcePath = path.join(repoRoot, 'client/components/admin/admin-mail.vue')

function scriptBlock () {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)
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
  test('uses mail REST helpers, typed wiki store, and no mail GraphQL documents', () => {
    const script = scriptBlock()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchMailConfig\b)(?=[^}]*\bsaveMailConfig\b)(?=[^}]*\bsendMailTest\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/mail-api['"]/)
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).not.toContain('mail-query-config.gql')
    expect(script).not.toContain('mail-mutation-save-config.gql')
    expect(script).not.toContain('mail-mutation-sendtest.gql')
    expect(script).not.toContain('mailConfigQuery')
    expect(script).not.toContain('mailUpdateConfigMutation')
    expect(script).not.toContain('mailTestMutation')
    expect(script).not.toContain('apollo:')
    expect(script).not.toContain('this.$apollo')
  })

  test('loadConfig uses REST helper and preserves loading/error behavior', () => {
    const loadConfig = methodBlock(scriptBlock(), 'loadConfig')

    expect(loadConfig).toContain("wikiStore.startLoading('admin-mail-refresh')")
    expect(loadConfig).toContain('this.config = _.cloneDeep(await fetchMailConfig(window.fetch.bind(window)))')
    expect(loadConfig).toContain('wikiStore.showError(err)')
    expect(loadConfig).toContain("wikiStore.stopLoading('admin-mail-refresh')")
    expect(loadConfig).not.toContain('$store.commit')
  })

  test('save uses REST helper and preserves payload, loading, notification, and error behavior', () => {
    const save = methodBlock(scriptBlock(), 'save')

    expect(save).toContain("wikiStore.startLoading('admin-mail-update')")
    expect(save).toContain('await saveMailConfig(window.fetch.bind(window), {')
    expect(save).toContain('port: _.toSafeInteger(this.config.port) || 0')
    expect(save).toContain('verifySSL: this.config.verifySSL || false')
    expect(save).toContain('wikiStore.showNotification({')
    expect(save).toContain("message: this.$t('admin:mail.saveSuccess')")
    expect(save).toContain('wikiStore.showError(err)')
    expect(save).toContain("wikiStore.stopLoading('admin-mail-update')")
    expect(save).not.toContain('this.$apollo.mutate')
    expect(save).not.toContain('$store.commit')
  })

  test('sendTest preserves loading, payload, success, cleanup, and error handling behavior', () => {
    const sendTest = methodBlock(scriptBlock(), 'sendTest')

    expect(sendTest).toContain("wikiStore.startLoading('admin-mail-test')")
    expect(sendTest).toContain("await sendMailTest(window.fetch.bind(window), this.testEmail, 'An unexpected error occurred.')")
    expect(sendTest).toContain("this.testEmail = ''")
    expect(sendTest).toContain('wikiStore.showNotification({')
    expect(sendTest).toContain("message: this.$t('admin:mail.sendTestSuccess')")
    expect(sendTest).toContain('wikiStore.showError(err)')
    expect(sendTest).toContain("wikiStore.stopLoading('admin-mail-test')")
    expect(sendTest).not.toContain('this.$apollo.mutate')
    expect(sendTest).not.toContain('data.mail.sendTest.responseResult')
    expect(sendTest).not.toContain('$store.commit')
  })
})
