const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`async\\s+${name}\\s*\\(`))

  if (methodStart === -1) {
    return null
  }

  const paramsStart = script.indexOf('(', methodStart)
  let paramsDepth = 0
  let bodyStart = -1

  for (let idx = paramsStart; idx < script.length; idx++) {
    if (script[idx] === '(') {
      paramsDepth++
    } else if (script[idx] === ')') {
      paramsDepth--

      if (paramsDepth === 0) {
        bodyStart = script.indexOf('{', idx)
        break
      }
    }
  }

  if (bodyStart === -1) {
    return null
  }

  let bodyDepth = 0

  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      bodyDepth++
    } else if (script[idx] === '}') {
      bodyDepth--

      if (bodyDepth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-locale loadBootstrap root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-locale.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadBootstrap = script && extractMethod(script, 'loadBootstrap')
  const download = script && extractMethod(script, 'download')
  const save = script && extractMethod(script, 'save')
  const directLoadBootstrapRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:['"]loadingStart['"]|['"]loadingStop['"]|['"]showNotification['"]|`loadingStart`|`loadingStop`|`showNotification`)\s*,/

  test('admin-locale.vue imports REST helpers and root UI facades', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchLocales\b)(?=[^}]*\bfetchLocaleConfig\b)(?=[^}]*\bsaveLocaleConfig\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/locales-api['"]/
    )
    expect(script).not.toMatch(/locale-mutation-save\.gql|localesSaveMutation/)
  })

  test('loadBootstrap() routes loading and fetch error notifications through the root UI facade', () => {
    expect(loadBootstrap).not.toBeNull()

    expect(loadBootstrap).toMatch(/async\s+loadBootstrap\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-locale-refresh['"]\s*\)/)
    expect(loadBootstrap).toMatch(/Promise\.allSettled\s*\(\s*\[\s*fetchLocales\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Locales response is invalid['"]\s*\)\s*,\s*fetchLocaleConfig\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Locale config response is invalid['"]\s*\)\s*\]\s*\)/)
    expect(loadBootstrap).toMatch(/this\.locales\s*=\s*localesResult\.value\.map\s*\(\s*lc\s*=>\s*\(\s*\{\s*\.\.\.lc\s*,\s*isDownloading:\s*false\s*\}\s*\)\s*\)/)
    expect(loadBootstrap).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*localesResult\.reason\.message\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/)
    expect(loadBootstrap).toMatch(/this\.selectedLocale\s*=\s*configResult\.value\.locale[\s\S]*this\.autoUpdate\s*=\s*configResult\.value\.autoUpdate[\s\S]*this\.namespacing\s*=\s*configResult\.value\.namespacing[\s\S]*this\.namespaces\s*=\s*configResult\.value\.namespaces[\s\S]*this\.configLoaded\s*=\s*true/)
    expect(loadBootstrap).toMatch(/this\.configLoaded\s*=\s*false\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*configResult\.reason\.message\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/)
    expect(loadBootstrap).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-locale-refresh['"]\s*\)\s*\}/)
    expect(loadBootstrap).not.toMatch(directLoadBootstrapRootUiCommit)
  })

  test('save() routes locale config through REST without changing UI success, failure, or reload behavior', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/if\s*\(\s*!this\.configLoaded\s*\)\s*\{\s*return\s*\}/)
    expect(save).toMatch(/this\.loading\s*=\s*true[\s\S]*await\s+saveLocaleConfig\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*\{\s*locale:\s*this\.selectedLocale\s*,\s*autoUpdate:\s*this\.autoUpdate\s*,\s*namespacing:\s*this\.namespacing\s*,\s*namespaces:\s*this\.namespaces\s*\}\s*,\s*['"]Locale settings update failed['"]\s*\)/)
    expect(save).toMatch(/this\.\$i18n\.i18next\.changeLanguage\s*\(\s*this\.selectedLocale\s*\)/)
    expect(save).toMatch(/this\.\$moment\.locale\s*\(\s*this\.selectedLocale\s*\)/)
    expect(save).toMatch(/this\.\$vuetify\.rtl\s*=\s*curLocale\s*&&\s*curLocale\.isRTL/)
    expect(save).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Locale settings updated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/window\.location\.reload\s*\(\s*true\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*`Error:\s*\$\{err\.message\}`\s*,\s*style:\s*['"]error['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*\}/)
    expect(save).toContain('this.loading = false')
    expect(save).not.toMatch(/this\.\$apollo\.mutate|localesSaveMutation|locale-mutation-save\.gql/)
  })

  test('download(), created(), and template behavior remain otherwise unchanged', () => {
    expect(download).not.toBeNull()
    expect(download).toMatch(/this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*localesDownloadMutation/)
    expect(download).toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadBootstrap\s*\(\s*\)\s*\}/)
    expect(source).toMatch(/@click='save'/)
    expect(source).toMatch(/@click='download\(item\)'/)
  })
})
