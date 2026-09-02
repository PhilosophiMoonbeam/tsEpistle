import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, methodName) => {
  const methodStart = script.search(new RegExp(`async\\s+${methodName}\\s*\\(`))
  if (methodStart === -1) {
    return null
  }

  const bodyStart = script.indexOf('{', methodStart)
  let depth = 0
  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--
      if (depth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-api-create REST mutation migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-api-create.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const generate = script && extractMethod(script, 'generate')
  const loadGroups = script && extractMethod(script, 'loadGroups')

  test('admin-api-create.vue imports the create-key REST helper and no longer uses inline GraphQL mutation', () => {
    expect(source).toMatch(/<script\s+lang=["']ts["']>/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bcreateAdminApiKey\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/auth-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchGroupOptions\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(script).toMatch(/import\s+\{\s*getErrorMessage\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/graphql-tag|this\.\$apollo\.mutate|mutation\s*:\s*gql`|createApiKey\s*\(/)
  })

  test('uses VForm validation, focuses the first invalid control, and submits the trimmed name only after validation', () => {
    expect(source).toMatch(/v-form\(\s*ref=['"]createForm['"]\s*,\s*@submit\.prevent=['"]generate['"]\s*\)/)
    expect(source).toMatch(/ref=['"]keyNameInput['"][\s\S]*?:rules=['"]nameRules['"]/)
    expect(source).toMatch(/ref=['"]expirationInput['"][\s\S]*?:rules=['"]\[requiredRule\]['"]/)
    expect(source).toMatch(/ref=['"]scopeInput['"][\s\S]*?:rules=['"]\[scopeRule\]['"]/)
    expect(source).toMatch(/ref=['"]groupInput['"][\s\S]*?:rules=['"]groupRules['"]/)

    expect(generate).not.toBeNull()
    expect(generate).toMatch(
      /const\s+form\s*=\s*this\.\$refs\.createForm[\s\S]*const\s+validation\s*=\s*await\s+form\?\.validate\?\.\(\s*\)[\s\S]*if\s*\(\s*!validation\?\.valid\s*\)/
    )
    expect(generate).toMatch(
      /let\s+firstInvalid\s*=\s*['"]keyNameInput['"][\s\S]*if\s*\(\s*normalizedName\.length\s*>=\s*2\s*&&\s*normalizedName\.length\s*<=\s*255\s*\)\s*\{[\s\S]*if\s*\(\s*!this\.expiration\s*\)\s*firstInvalid\s*=\s*['"]expirationInput['"][\s\S]*else\s+if\s*\(\s*!this\.scope\s*\)\s*firstInvalid\s*=\s*['"]scopeInput['"][\s\S]*else\s+if\s*\(\s*this\.scope\s*===\s*['"]group['"]\s*&&\s*\(\s*this\.group\s*===\s*null\s*\|\|\s*this\.group\s*===\s*2\s*\)\s*\)\s*firstInvalid\s*=\s*['"]groupInput['"]/
    )
    expect(generate).toMatch(
      /this\.\$nextTick\s*\(\s*\(\s*\)\s*=>\s*this\.focusFormControl\s*\(\s*firstInvalid\s*\)\s*\)\s*[\s\S]*return\s*\}[\s\S]*this\.name\s*=\s*this\.name\.trim\s*\(\s*\)/
    )

    const validateIndex = generate.indexOf('await form?.validate?.()')
    const trimIndex = generate.indexOf('this.name = this.name.trim()')
    const createIndex = generate.indexOf('await createAdminApiKey(')
    expect(validateIndex).toBeGreaterThan(-1)
    expect(trimIndex).toBeGreaterThan(validateIndex)
    expect(createIndex).toBeGreaterThan(trimIndex)
  })

  test('loads group options only when the open form needs them and keeps failures locally retryable', () => {
    expect(script).toMatch(
      /handler\s*\(\s*newValue:\s*boolean\s*\)\s*\{[\s\S]*if\s*\(\s*newValue\s*\)\s*\{[\s\S]*if\s*\(\s*this\.scope\s*===\s*['"]group['"]\s*\)\s*void\s+this\.loadGroups\s*\(\s*\)/
    )
    expect(script).toMatch(
      /scope\s*\(\s*newValue:[^)]*\)\s*\{[\s\S]*if\s*\(\s*newValue\s*===\s*['"]group['"]\s*&&\s*this\.modelValue\s*\)\s*void\s+this\.loadGroups\s*\(\s*\)/
    )

    expect(loadGroups).not.toBeNull()
    expect(loadGroups).toMatch(
      /if\s*\(\s*!this\.modelValue\s*\|\|\s*this\.scope\s*!==\s*['"]group['"]\s*\|\|\s*this\.groupLoadState\s*===\s*['"]loading['"]\s*\|\|\s*this\.groupLoadState\s*===\s*['"]success['"]\s*\)\s*return/
    )
    expect(loadGroups).toMatch(
      /this\.groupLoadState\s*=\s*['"]loading['"][\s\S]*this\.groupLoadError\s*=\s*['"]['"][\s\S]*wikiStore\.startLoading\s*\(\s*['"]admin-api-groups-refresh['"]\s*\)/
    )
    expect(loadGroups).toMatch(
      /this\.groups\s*=\s*await\s+fetchGroupOptions\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Groups response is invalid['"]\s*\)[\s\S]*this\.groupLoadState\s*=\s*['"]success['"]/
    )
    expect(loadGroups).toMatch(
      /async\s+loadGroups\s*\(\s*focusOnSuccess\s*=\s*false\s*\)[\s\S]*if\s*\(\s*focusOnSuccess\s*&&\s*this\.modelValue\s*&&\s*this\.scope\s*===\s*['"]group['"]\s*\)\s*\{[\s\S]*this\.\$nextTick\s*\(\s*\(\s*\)\s*=>\s*this\.focusFormControl\s*\(\s*['"]groupInput['"]\s*\)\s*\)/
    )
    expect(loadGroups).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*this\.groups\s*=\s*\[\][\s\S]*this\.groupLoadState\s*=\s*['"]error['"][\s\S]*this\.groupLoadError\s*=\s*getErrorMessage\s*\(\s*err\s*\)/
    )
    expect(loadGroups).toMatch(/finally\s*\{[\s\S]*wikiStore\.stopLoading\s*\(\s*['"]admin-api-groups-refresh['"]\s*\)/)
    expect(loadGroups).not.toMatch(/wikiStore\.(?:showError|showNotification)\s*\(/)

    expect(source).toMatch(
      /v-alert[\s\S]*?v-if=['"]scope === `group` && groupLoadState === `error`['"][\s\S]*?\{\{\s*groupLoadError\s*\}\}[\s\S]*?@click=['"]loadGroups\(true\)['"][\s\S]*?\)\s*Retry groups/
    )
    expect(source).toMatch(
      /v-select[\s\S]*?v-if=['"]scope === `group`['"][\s\S]*?:loading=['"]groupLoadState === `loading`['"][\s\S]*?:disabled=['"]loading \|\| groupLoadState !== `success`['"]/
    )
  })

  test('generate() preserves the scoped REST payload, refresh result, loading, and one-time key acknowledgement flow', () => {
    expect(generate).not.toBeNull()
    expect(generate).toMatch(/this\.loading\s*=\s*true\s*[\s\S]*wikiStore\.startLoading\s*\(\s*['"]admin-api-create['"]\s*\)/)
    expect(generate).toMatch(
      /const\s+resp\s*=\s*await\s+createAdminApiKey\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*\{[\s\S]*?name:\s*this\.name[\s\S]*?expiration:\s*this\.expiration[\s\S]*?fullAccess:\s*this\.scope\s*===\s*['"]full['"][\s\S]*?group:\s*this\.scope\s*===\s*['"]group['"]\s*\?\s*this\.group\s*:\s*null[\s\S]*?\}\s*\)/
    )
    expect(generate).toMatch(
      /const\s+refreshed\s*=\s*this\.refreshApiKeys\s*\?\s*await\s+\(\s*this\.refreshApiKeys\s+as\s+\(\s*notify:\s*boolean\s*\)\s*=>\s*Promise<boolean>\s*\)\s*\(\s*false\s*\)\s*:\s*true/
    )

    const createIndex = generate.indexOf('await createAdminApiKey(')
    const refreshIndex = generate.indexOf('await (this.refreshApiKeys')
    const keyIndex = generate.indexOf('this.key = resp.key')
    const dialogIndex = generate.indexOf('this.isCopyKeyDialogShown = true')
    expect(createIndex).toBeGreaterThan(-1)
    expect(refreshIndex).toBeGreaterThan(createIndex)
    expect(keyIndex).toBeGreaterThan(refreshIndex)
    expect(dialogIndex).toBeGreaterThan(keyIndex)
    const loadingIndex = generate.indexOf('this.loading = true')
    const startLoadingIndex = generate.indexOf("wikiStore.startLoading('admin-api-create')")
    expect(loadingIndex).toBeGreaterThan(-1)
    expect(startLoadingIndex).toBeGreaterThan(loadingIndex)
    expect(createIndex).toBeGreaterThan(startLoadingIndex)

    expect(generate).toMatch(
      /if\s*\(\s*refreshed\s*\)\s*\{[\s\S]*?wikiStore\.showNotification\s*\(\s*\{[\s\S]*?message:\s*this\.\$t\s*\(\s*['"]admin:api\.newKeySuccess['"]\s*\)[\s\S]*?\}\s*\)/
    )
    expect(generate).toMatch(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(generate).toMatch(/finally\s*\{[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-api-create['"]\s*\)[\s\S]*?this\.loading\s*=\s*false/)

    expect(source).toMatch(/v-dialog\([\s\S]*?v-model=['"]isCopyKeyDialogShown['"][\s\S]*?\bpersistent\b[\s\S]*?\)/)
    expect(source).toMatch(/@click=['"]copyKey['"][\s\S]*?\{\{\s*copied\s*\?\s*['"]Copied['"]\s*:\s*['"]Copy key['"]\s*\}\}/)
    expect(source).toMatch(/@click=['"]finishCopyKey['"][^)]*\)\s*I’ve saved this key/)
    expect(script).toMatch(
      /async\s+copyKey\s*\(\s*\)\s*\{[\s\S]*?await\s+navigator\.clipboard\.writeText\s*\(\s*this\.key\s*\)[\s\S]*?this\.copied\s*=\s*true[\s\S]*?catch\s*\{[\s\S]*?input\?\.select\?\.\(\s*\)[\s\S]*?wikiStore\.showNotification/
    )
    expect(script).toMatch(
      /finishCopyKey\s*\(\s*\)\s*\{[\s\S]*?this\.isCopyKeyDialogShown\s*=\s*false[\s\S]*?this\.copied\s*=\s*false[\s\S]*?this\.key\s*=\s*['"]['"]/
    )
  })
})
