import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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

  test('admin-locale.vue imports typed REST helpers and the wiki store facade', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchLocales\b)(?=[^}]*\bfetchLocaleConfig\b)(?=[^}]*\bsaveLocaleConfig\b)(?=[^}]*\bdownloadLocale\b)(?=[^}]*\bLocaleRow\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/locales-api['"]/
    )
    expect(script).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/locale-mutation-save\.gql|localesSaveMutation|locale-mutation-download\.gql|localesDownloadMutation/)
  })

  test('loadBootstrap() routes loading and fetch error notifications through the wiki store', () => {
    expect(loadBootstrap).not.toBeNull()

    expect(loadBootstrap).toMatch(/async\s+loadBootstrap\s*\(\s*\)\s*\{\s*wikiStore\.startLoading\s*\(\s*['"]admin-locale-refresh['"]\s*\)/)
    expect(loadBootstrap).toMatch(/Promise\.allSettled\s*\(\s*\[\s*fetchLocales\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Locales response is invalid['"]\s*\)\s*,\s*fetchLocaleConfig\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Locale config response is invalid['"]\s*\)\s*\]\s*\)/)
    expect(loadBootstrap).toMatch(/this\.locales\s*=\s*localesResult\.value\.map\s*\(\s*lc\s*=>\s*\(\s*\{\s*\.\.\.lc\s*,\s*isDownloading:\s*false\s*\}\s*\)\s*\)/)
    expect(loadBootstrap).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*getErrorMessage\s*\(\s*localesResult\.reason\s*\)\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/)
    expect(loadBootstrap).toMatch(/this\.selectedLocale\s*=\s*configResult\.value\.locale[\s\S]*this\.autoUpdate\s*=\s*configResult\.value\.autoUpdate[\s\S]*this\.namespacing\s*=\s*configResult\.value\.namespacing[\s\S]*this\.namespaces\s*=\s*configResult\.value\.namespaces[\s\S]*this\.configLoaded\s*=\s*true/)
    expect(loadBootstrap).toMatch(/this\.configLoaded\s*=\s*false\s*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*getErrorMessage\s*\(\s*configResult\.reason\s*\)\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/)
    expect(loadBootstrap).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-locale-refresh['"]\s*\)\s*\}/)
    expect(loadBootstrap).not.toMatch(directLoadBootstrapRootUiCommit)
  })

  test('save() routes locale config through REST without changing UI success, failure, or reload behavior', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/if\s*\(\s*!this\.configLoaded\s*\)\s*\{\s*return\s*\}/)
    expect(save).toMatch(/this\.loading\s*=\s*true[\s\S]*await\s+saveLocaleConfig\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*\{\s*locale:\s*this\.selectedLocale\s*,\s*autoUpdate:\s*this\.autoUpdate\s*,\s*namespacing:\s*this\.namespacing\s*,\s*namespaces:\s*this\.namespaces\s*\}\s*,\s*['"]Locale settings update failed['"]\s*\)/)
    expect(save).toMatch(/void\s+this\.\$i18n\.changeLanguage\s*\(\s*this\.selectedLocale\s*\)/)
    expect(save).toMatch(/this\.\$moment\.locale\s*\(\s*this\.selectedLocale\s*\)/)
    expect(save).toMatch(/this\.\$vuetify\.locale\.rtl\s*\[\s*this\.selectedLocale\s*\]\s*=\s*Boolean\s*\(\s*curLocale\s*&&\s*curLocale\.isRTL\s*\)/)
    expect(save).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Locale settings updated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/window\.location\.reload\s*\(\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*`Error:\s*\$\{getErrorMessage\s*\(\s*err\s*\)\}`\s*,\s*style:\s*['"]error['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*\}/)
    expect(save).toContain('this.loading = false')
    expect(save).not.toMatch(/this\.\$apollo\.mutate|localesSaveMutation|locale-mutation-save\.gql/)
  })

  test('download(), created(), and template behavior route through REST and facades', () => {
    expect(download).not.toBeNull()
    expect(download).toMatch(/async\s+download\s*\(\s*lc\s*:\s*LocaleTableRow\s*\)/)
    expect(download).toMatch(/lc\.isDownloading\s*=\s*true[\s\S]*await\s+downloadLocale\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*lc\.code\s*,\s*['"]Locale download failed['"]\s*\)/)
    expect(download).toMatch(/lc\.isInstalled\s*=\s*true[\s\S]*lc\.updatedAt\s*=\s*new Date\(\)\.toISOString\(\)[\s\S]*lc\.installDate\s*=\s*lc\.updatedAt/)
    expect(download).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*`Locale\s+\$\{lc\.name\}\s+has been installed successfully\.`\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]get_app['"]\s*\}\s*\)/)
    expect(download).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*`Error:\s*\$\{getErrorMessage\s*\(\s*err\s*\)\}`\s*,\s*style:\s*['"]error['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*\}/)
    expect(download).toContain('lc.isDownloading = false')
    expect(download).not.toMatch(/this\.\$apollo\.mutate|localesDownloadMutation|locale-mutation-download\.gql|this\.\$store\.commit/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadBootstrap\s*\(\s*\)\s*\}/)
    expect(source).toMatch(/@click='save'/)
    expect(source).toMatch(/@click='download\(item\)'/)
  })
})
