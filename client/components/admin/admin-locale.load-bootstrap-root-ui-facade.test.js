import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
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
  const directLoadBootstrapRootUiCommit =
    /\bthis\.\$store\.commit\s*\(\s*(?:['"]loadingStart['"]|['"]loadingStop['"]|['"]showNotification['"]|`loadingStart`|`loadingStop`|`showNotification`)\s*,/

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

  test('loadBootstrap() preserves independent partial-load state and balances abortable loading', () => {
    expect(loadBootstrap).not.toBeNull()

    expect(loadBootstrap).toMatch(
      /if\s*\(\s*this\.localesLoading\s*\)\s*return[\s\S]*const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*this\.loadController\s*=\s*controller[\s\S]*this\.localesLoading\s*=\s*true[\s\S]*this\.configError\s*=\s*['"][^'"]*['"][\s\S]*this\.localesError\s*=\s*['"][^'"]*['"][\s\S]*wikiStore\.startLoading\s*\(\s*['"]admin-locale-refresh['"]\s*\)/
    )
    expect(loadBootstrap).toMatch(
      /Promise\.allSettled\s*\(\s*\[\s*fetchLocales\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*['"]Locales response is invalid['"]\s*\)\s*,\s*fetchLocaleConfig\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*['"]Locale config response is invalid['"]\s*\)\s*\]\s*\)/
    )
    expect(loadBootstrap).toMatch(/if\s*\(\s*controller\.signal\.aborted\s*\)\s*return/)
    expect(loadBootstrap).toMatch(
      /this\.locales\s*=\s*localesResult\.value\.map\s*\(\s*lc\s*=>\s*\(\s*\{\s*\.\.\.lc\s*,\s*isDownloading:\s*false\s*\}\s*\)\s*\)[\s\S]*this\.localesLoaded\s*=\s*true/
    )
    expect(loadBootstrap).toMatch(
      /this\.localesLoaded\s*=\s*false[\s\S]*this\.localesError\s*=\s*getErrorMessage\s*\(\s*localesResult\.reason\s*\)[\s\S]*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*this\.localesError\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/
    )
    expect(loadBootstrap).toMatch(
      /this\.selectedLocale\s*=\s*configResult\.value\.locale[\s\S]*this\.autoUpdate\s*=\s*configResult\.value\.autoUpdate[\s\S]*this\.namespacing\s*=\s*configResult\.value\.namespacing[\s\S]*this\.namespaces\s*=\s*configResult\.value\.namespaces[\s\S]*this\.configLoaded\s*=\s*true/
    )
    expect(loadBootstrap).toMatch(
      /this\.configLoaded\s*=\s*false[\s\S]*this\.configError\s*=\s*getErrorMessage\s*\(\s*configResult\.reason\s*\)[\s\S]*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*this\.configError\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/
    )
    expect(loadBootstrap).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.loadController\s*===\s*controller\s*\)\s*\{\s*this\.loadController\s*=\s*null\s*if\s*\(\s*!this\.isUnmounted\s*\)\s*this\.localesLoading\s*=\s*false\s*\}\s*wikiStore\.stopLoading\s*\(\s*['"]admin-locale-refresh['"]\s*\)\s*\}/
    )
    expect(loadBootstrap.match(/\bwikiStore\.(?:start|stop)Loading\s*\(/g) || []).toHaveLength(2)
    expect(loadBootstrap).not.toMatch(directLoadBootstrapRootUiCommit)
  })

  test('save() requires a fully loaded locale and preserves payload, UI, reload, and cleanup behavior', () => {
    expect(save).not.toBeNull()

    expect(script).toMatch(
      /canSave\s*\(\s*\)\s*\{\s*return\s+!this\.loading\s*&&\s*this\.configLoaded\s*&&\s*this\.localesLoaded\s*&&\s*this\.installedLocales\.some\s*\(\s*locale\s*=>\s*locale\.code\s*===\s*this\.selectedLocale\s*\)\s*\}/
    )
    expect(save).toMatch(/if\s*\(\s*!this\.canSave\s*\|\|\s*this\.loading\s*\)\s*return/)
    expect(save).toMatch(/const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*this\.saveController\s*=\s*controller[\s\S]*this\.loading\s*=\s*true/)
    expect(save).toMatch(
      /await\s+saveLocaleConfig\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*\{\s*locale:\s*this\.selectedLocale,\s*autoUpdate:\s*this\.autoUpdate,\s*namespacing:\s*this\.namespacing,\s*namespaces:\s*this\.namespaces\s*\}\s*,\s*['"]Locale settings update failed['"]\s*\)/
    )
    expect(save).toMatch(/if\s*\(\s*controller\.signal\.aborted\s*\)\s*return/)
    expect(save).toMatch(/void\s+this\.\$i18n\.changeLanguage\s*\(\s*this\.selectedLocale\s*\)/)
    expect(save).toMatch(/this\.\$moment\.locale\s*\(\s*this\.selectedLocale\s*\)/)
    expect(save).toMatch(
      /const\s+curLocale\s*=\s*this\.locales\.find\s*\(\s*locale\s*=>\s*locale\.code\s*===\s*this\.selectedLocale\s*\)[\s\S]*this\.\$vuetify\.locale\.rtl\s*\[\s*this\.selectedLocale\s*\]\s*=\s*Boolean\s*\(\s*curLocale\?\.isRTL\s*\)/
    )
    expect(save).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Locale settings updated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /this\.reloadTimer\s*=\s*window\.setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{\s*this\.reloadTimer\s*=\s*null\s*window\.location\.reload\s*\(\s*\)\s*\},\s*1000\s*\)/
    )
    expect(save).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{[\s\S]*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*`Error:\s*\$\{getErrorMessage\s*\(\s*err\s*\)\}`,\s*style:\s*['"]error['"],\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*\}\s*\}/
    )
    expect(save).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.saveController\s*===\s*controller\s*\)\s*\{\s*this\.saveController\s*=\s*null\s*if\s*\(\s*!this\.isUnmounted\s*\)\s*this\.loading\s*=\s*false\s*\}\s*\}/
    )
    expect(save).not.toMatch(/this\.\$apollo\.mutate|localesSaveMutation|locale-mutation-save\.gql/)
  })

  test('download(), mount lifecycle, and responsive actions preserve abort and timer cleanup', () => {
    expect(download).not.toBeNull()
    expect(download).toMatch(/async\s+download\s*\(\s*lc\s*:\s*LocaleTableRow\s*\)/)
    expect(download).toMatch(/if\s*\(\s*lc\.isDownloading\s*\)\s*return/)
    expect(download).toMatch(
      /const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*this\.downloadControllers\.set\s*\(\s*lc\.code,\s*controller\s*\)[\s\S]*lc\.isDownloading\s*=\s*true/
    )
    expect(download).toMatch(
      /await\s+downloadLocale\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*lc\.code,\s*['"]Locale download failed['"]\s*\)[\s\S]*if\s*\(\s*controller\.signal\.aborted\s*\)\s*return/
    )
    expect(download).toMatch(/lc\.isInstalled\s*=\s*true[\s\S]*lc\.updatedAt\s*=\s*new Date\(\)\.toISOString\(\)[\s\S]*lc\.installDate\s*=\s*lc\.updatedAt/)
    expect(download).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{\s*message:\s*`Locale\s+\$\{lc\.name\}\s+has been installed successfully\.`\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]get_app['"]\s*\}\s*\)/
    )
    expect(download).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{[\s\S]*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*`Error:\s*\$\{getErrorMessage\s*\(\s*err\s*\)\}`,\s*style:\s*['"]error['"],\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*\}\s*\}/
    )
    expect(download).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.downloadControllers\.get\s*\(\s*lc\.code\s*\)\s*===\s*controller\s*\)\s*\{\s*this\.downloadControllers\.delete\s*\(\s*lc\.code\s*\)\s*if\s*\(\s*!this\.isUnmounted\s*\)\s*lc\.isDownloading\s*=\s*false\s*\}\s*\}/
    )
    expect(download).not.toMatch(/this\.\$apollo\.mutate|localesDownloadMutation|locale-mutation-download\.gql|this\.\$store\.commit/)
    expect(script).toMatch(/downloadControllers:\s*markRaw\s*\(\s*new Map<string,\s*AbortController>\s*\(\s*\)\s*\)/)
    expect(script).not.toMatch(/\b_\.(?:filter|find|some)\s*\(/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadBootstrap\s*\(\s*\)\s*\}/)
    expect(script).toMatch(
      /beforeUnmount\s*\(\s*\)\s*\{\s*this\.isUnmounted\s*=\s*true\s*this\.loadController\?\.abort\s*\(\s*\)\s*this\.saveController\?\.abort\s*\(\s*\)\s*this\.downloadControllers\.forEach\s*\(\s*controller\s*=>\s*controller\.abort\s*\(\s*\)\s*\)\s*this\.downloadControllers\.clear\s*\(\s*\)\s*if\s*\(\s*this\.reloadTimer\s*!==\s*null\s*\)\s*window\.clearTimeout\s*\(\s*this\.reloadTimer\s*\)\s*\}/
    )
    expect(source).toMatch(/@click='save'/)
    expect(source.match(/@click='download\(props\.item\)'/g)).toHaveLength(6)
    expect(source).toMatch(/:aria-label='`Download \$\{props\.item\.name\} locale`'/)
  })
})
