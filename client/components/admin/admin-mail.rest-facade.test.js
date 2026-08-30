import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const repoRoot = path.resolve(__dirname, '../../..')
const sourcePath = path.join(repoRoot, 'client/components/admin/admin-mail.vue')

function scriptBlock() {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)
  if (!match) {
    throw new Error('admin-mail script block not found')
  }
  return match[1]
}

function methodBlock(script, methodName) {
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

    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchMailConfig\b)(?=[^}]*\bsaveMailConfig\b)(?=[^}]*\bsendMailTest\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/mail-api['"]/
    )
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

  test('loadConfig separates stored secrets from editable values and always balances loading', () => {
    const loadConfig = methodBlock(scriptBlock(), 'loadConfig')

    expect(loadConfig).toContain("wikiStore.startLoading('admin-mail-refresh')")
    expect(loadConfig).toContain('const loaded = _.cloneDeep(await fetchMailConfig(window.fetch.bind(window)))')
    expect(loadConfig).toContain("this.smtpPasswordStored = loaded.pass === '********'")
    expect(loadConfig).toContain("this.smtpPasswordMode = this.smtpPasswordStored ? 'keep' : 'replace'")
    expect(loadConfig).toContain('this.storedDkimPrivateKey = loaded.dkimPrivateKey')
    expect(loadConfig).toContain("this.dkimKeyMode = loaded.dkimPrivateKey ? 'keep' : 'replace'")
    expect(loadConfig).toMatch(/this\.config\s*=\s*\{\s*\.\.\.loaded,\s*pass:\s*'',\s*dkimPrivateKey:\s*''\s*\}/)
    expect(loadConfig).toMatch(
      /catch\s*\(err\)\s*\{[\s\S]*?wikiStore\.showError\(err\)[\s\S]*?\}\s*finally\s*\{[\s\S]*?wikiStore\.stopLoading\('admin-mail-refresh'\)/
    )
    expect(loadConfig.match(/\bwikiStore\.(?:start|stop)Loading\s*\(/g) || []).toHaveLength(2)
    expect(loadConfig).not.toContain('$store.commit')
  })

  test('save preserves the complete helper payload, stored-secret choices, and balanced cleanup', () => {
    const save = methodBlock(scriptBlock(), 'save')

    expect(save).toMatch(
      /const pass\s*=\s*this\.smtpPasswordMode === 'keep'[\s\S]*?this\.smtpPasswordStored \? '\*{8}' : ''[\s\S]*?this\.smtpPasswordMode === 'replace' \? this\.config\.pass : ''/
    )
    expect(save).toMatch(
      /const dkimPrivateKey\s*=\s*this\.dkimKeyMode === 'keep'[\s\S]*?this\.storedDkimPrivateKey[\s\S]*?this\.dkimKeyMode === 'replace' \? this\.config\.dkimPrivateKey : ''/
    )
    expect(save).toContain("wikiStore.startLoading('admin-mail-update')")
    expect(save).toMatch(
      /await saveMailConfig\(window\.fetch\.bind\(window\),\s*\{\s*senderName: this\.config\.senderName\.trim\(\),\s*senderEmail: this\.config\.senderEmail\.trim\(\),\s*host: this\.config\.host\.trim\(\),\s*port: _\.toSafeInteger\(this\.config\.port\),\s*name: this\.config\.name\.trim\(\),\s*secure: Boolean\(this\.config\.secure\),\s*verifySSL: Boolean\(this\.config\.verifySSL\),\s*user: this\.config\.user\.trim\(\),\s*pass,\s*useDKIM: Boolean\(this\.config\.useDKIM\),\s*dkimDomainName: this\.config\.dkimDomainName\.trim\(\),\s*dkimKeySelector: this\.config\.dkimKeySelector\.trim\(\),\s*dkimPrivateKey\s*\}, 'Mail configuration update failed'\)/
    )
    expect(save).toMatch(
      /this\.smtpPasswordStored = Boolean\(pass\)[\s\S]*?this\.config\.pass = ''[\s\S]*?this\.storedDkimPrivateKey = dkimPrivateKey[\s\S]*?this\.config\.dkimPrivateKey = ''/
    )
    expect(save).toContain('wikiStore.showNotification({')
    expect(save).toContain("message: this.$t('admin:mail.saveSuccess')")
    expect(save).toMatch(
      /catch\s*\(err\)\s*\{\s*wikiStore\.showError\(err\)\s*\}\s*finally\s*\{[\s\S]*?wikiStore\.stopLoading\('admin-mail-update'\)[\s\S]*?\}/
    )
    expect(save.match(/\bwikiStore\.(?:start|stop)Loading\s*\(/g) || []).toHaveLength(2)
    expect(save).not.toContain('this.$apollo.mutate')
    expect(save).not.toContain('$store.commit')
  })

  test('sendTest trims the recipient, records the outcome, and always balances loading', () => {
    const sendTest = methodBlock(scriptBlock(), 'sendTest')

    expect(sendTest).toContain("wikiStore.startLoading('admin-mail-test')")
    expect(sendTest).toContain("await sendMailTest(window.fetch.bind(window), this.testEmail.trim(), 'An unexpected error occurred.')")
    expect(sendTest).toMatch(/this\.testEmail = ''\s*this\.testState = 'passed'/)
    expect(sendTest).toContain('wikiStore.showNotification({')
    expect(sendTest).toContain("message: this.$t('admin:mail.sendTestSuccess')")
    expect(sendTest).toMatch(
      /catch\s*\(err\)\s*\{\s*this\.testState = 'failed'\s*wikiStore\.showError\(err\)\s*\}\s*finally\s*\{[\s\S]*?wikiStore\.stopLoading\('admin-mail-test'\)[\s\S]*?\}/
    )
    expect(sendTest.match(/\bwikiStore\.(?:start|stop)Loading\s*\(/g) || []).toHaveLength(2)
    expect(sendTest).not.toContain('this.$apollo.mutate')
    expect(sendTest).not.toContain('data.mail.sendTest.responseResult')
    expect(sendTest).not.toContain('$store.commit')
  })
})
