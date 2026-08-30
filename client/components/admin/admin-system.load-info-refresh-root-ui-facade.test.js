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

describe('admin-system loadInfo/refresh root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-system.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadInfo = script && extractMethod(script, 'loadInfo')
  const refresh = script && extractMethod(script, 'refresh')
  const directRootUiCommit =
    /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-system.vue imports typed wiki store and the facades required by loadInfo() and refresh()', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(/import\s+\{\s*fetchSystemInfo\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/)
    expect(script).not.toMatch(/performSystemUpgrade/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
  })

  test('loadInfo() uses loading and error facades while preserving fetch assignment, boolean return, and cleanup behavior', () => {
    expect(loadInfo).not.toBeNull()

    expect(loadInfo).toMatch(
      /this\.loading\s*=\s*true\s*this\.errorMessage\s*=\s*['"]{2}\s*this\.infoLoaded\s*=\s*false\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-system-refresh['"]\s*\)\s*try\s*\{/
    )
    expect(loadInfo).toMatch(
      /this\.info\s*=\s*await\s+fetchSystemInfo\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]System info response is invalid['"]\s*\)\s*this\.infoLoaded\s*=\s*true\s*return\s+true/
    )
    expect(loadInfo).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*return\s+false\s*\}/
    )
    expect(loadInfo).toMatch(/finally\s*\{\s*this\.loading\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-system-refresh['"]\s*\)\s*\}/)
    expect(loadInfo).not.toMatch(directRootUiCommit)

    expect(loadInfo.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh() only shows the success notification through the facade after a successful loadInfo()', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(
      /async\s+refresh\s*\(\s*\)\s*\{\s*const\s+loaded\s*=\s*await\s+this\.loadInfo\s*\(\s*\)\s*if\s*\(\s*!loaded\s*\)\s*\{\s*return\s+false\s*\}\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:system\.refreshSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*return\s+true\s*\}/
    )
    expect(refresh).not.toMatch(directRootUiCommit)

    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('renders exact build identity and an honest unavailable update state', () => {
    expect(source).toContain("import AsyncState from '@/components/common/async-state.vue'")
    expect(source).toMatch(
      /async-state\(\s*v-if='loading'\s*state='loading'[\s\S]*?\)\s*async-state\(\s*v-else-if='errorMessage'\s*state='error'[\s\S]*?:message='errorMessage'[\s\S]*?@retry='loadInfo'\s*\)\s*v-row\.mt-3\(v-else-if='infoLoaded'\)/
    )
    expect(source).toContain('v-card-title.text-title-medium {{ info.product.name }}')
    expect(source).toMatch(/v-list-item-title Product Version\s*v-list-item-subtitle\.system-value \{\{ info\.product\.version \}\}/)
    expect(source).toMatch(
      /v-list-item-title Build Revision\s*v-list-item-subtitle\.system-value\.system-mono\s*a\(:href='info\.product\.sourceUrl', target='_blank', rel='noopener noreferrer'\) \{\{ info\.product\.revision \}\}/
    )
    expect(source).toMatch(/v-list-item-title Upstream Base\s*v-list-item-subtitle\.system-value\.system-mono \{\{ info\.product\.upstreamBase \}\}/)
    expect(source).toMatch(
      /v-chip\(size='small', variant='tonal', color='info'\) Unavailable\s*\.text-body-small\.text-medium-emphasis\.mt-1 No fork-owned update provider is configured/
    )
    expect(source).toMatch(
      /v-list-item-title Source Code\s*v-list-item-subtitle\.system-value\s*a\(:href='info\.product\.sourceUrl', target='_blank', rel='noopener noreferrer'\) Exact deployed revision/
    )
    expect(source).not.toMatch(/Perform Upgrade|container is being upgraded/)
  })
})
