import fs from 'node:fs'
import path from 'node:path'

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

describe('admin-rendering root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-rendering.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const loadRenderers = script && extractMethod(script, 'loadRenderers')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')

  test('admin-rendering.vue uses typed helpers and exposes explicit loading and error states', () => {
    expect(script).not.toBeNull()
    expect(loadRenderers).not.toBeNull()
    expect(refresh).not.toBeNull()
    expect(save).not.toBeNull()
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchRenderingRenderers\b)(?=[^}]*\bsaveRenderingRenderers\b)(?=[^}]*\btype\s+Renderer\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/rendering-api['"]/
    )
    expect(source).toMatch(
      /v-list\(v-if='renderersLoading', aria-live='polite'\)[\s\S]*?v-alert\(v-else-if='renderersLoadError', variant='outlined', color='error', aria-live='polite'\)[\s\S]*?@click='retryLoad'[\s\S]*?v-alert\(v-else-if='renderersLoaded && renderers\.length < 1', variant='outlined', color='info'\) No rendering modules are installed\./
    )
    expect(source).toMatch(
      /v-alert\(v-if='renderersLoading', variant='outlined', color='info', aria-live='polite'\)[\s\S]*?v-alert\(v-else-if='renderersLoadError', variant='outlined', color='error', aria-live='polite'\)[\s\S]*?@click='retryLoad'[\s\S]*?v-alert\(v-else-if='renderersLoaded && !currentRenderer\.key', variant='outlined', color='info'\) Select a rendering module to configure it\./
    )
  })

  test('loadRenderers() rebuilds and directly selects the default renderer while balancing loading', () => {
    expect(loadRenderers).toMatch(/async\s+loadRenderers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)/)
    expect(loadRenderers).toMatch(
      /this\.renderersLoading\s*=\s*true\s*this\.renderersLoadError\s*=\s*false\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-refresh['"]\s*\)/
    )
    expect(loadRenderers).toMatch(
      /const\s+flatRenderers\s*=\s*await\s+fetchRenderingRenderers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Rendering renderers response is invalid['"]\s*\)/
    )
    expect(loadRenderers).toMatch(
      /this\.renderers\s*=\s*this\.buildRendererTree\s*\(\s*flatRenderers\s*\)\s*this\.selectedCore\s*=\s*_\.findIndex\s*\(\s*this\.renderers\s*,\s*\[\s*['"]key['"]\s*,\s*['"]markdownCore['"]\s*\]\s*\)\s*this\.currentRenderer\s*=\s*createEmptyRenderer\s*\(\s*\)\s*if\s*\(\s*this\.selectedCore\s*>=\s*0\s*\)\s*this\.selectRenderer\s*\(\s*['"]markdownCore['"]\s*\)\s*this\.renderersLoaded\s*=\s*true/
    )
    expect(loadRenderers).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*this\.renderers\s*=\s*\[\]\s*this\.selectedCore\s*=\s*-1\s*this\.currentRenderer\s*=\s*createEmptyRenderer\s*\(\s*\)\s*this\.renderersLoaded\s*=\s*false\s*this\.renderersLoadError\s*=\s*true/
    )
    expect(loadRenderers).toMatch(
      /if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*getErrorMessage\s*\(\s*err\s*\)\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err/
    )
    expect(loadRenderers).toMatch(
      /finally\s*\{\s*this\.renderersLoading\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-refresh['"]\s*\)\s*\}/
    )
    expect(loadRenderers).not.toMatch(/\$store\.commit/)
    expect(loadRenderers.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadRenderers.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadRenderers.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh is mutually exclusive with loads and saves, and only notifies after a successful reload', () => {
    expect(refresh).toMatch(
      /if\s*\(\s*this\.renderersLoading\s*\|\|\s*this\.saving\s*\)\s*return\s*try\s*\{\s*await\s+this\.loadRenderers\s*\(\s*\)\s*\}\s*catch\s*\{\s*return\s*\}/
    )
    expect(refresh).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*['"]Rendering active configuration has been reloaded\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/
    )
    expect(source).toContain(":disabled='renderersLoading || saving'")
    expect(refresh).not.toMatch(/\$store\.commit/)
    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save preserves the REST payload, silent reload, error reporting, and balanced cleanup', () => {
    expect(save).toMatch(
      /if\s*\(\s*!this\.renderersLoaded\s*\|\|\s*this\.renderersLoading\s*\|\|\s*this\.saving\s*\)\s*return\s*this\.saving\s*=\s*true\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-saverenderers['"]\s*\)/
    )
    expect(save).toMatch(
      /await\s+saveRenderingRenderers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.renderers\.reduce<unknown\[\]>\s*\(\s*\(\s*result\s*,\s*core\s*\)\s*=>\s*\{\s*return\s+result\.concat\s*\(\s*core\.children\.map\s*\(\s*rd\s*=>\s*\(\s*\{/
    )
    expect(save).toMatch(
      /key:\s*rd\.key\s*,\s*isEnabled:\s*rd\.isEnabled\s*,\s*config:\s*rd\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*key:\s*cfg\.key\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(/\}\)\)\)\s*\}\s*,\s*\[\s*\]\s*\)\s*,\s*['"]Rendering renderers update failed['"]\s*\)/)
    expect(save).toMatch(
      /await\s+this\.loadRenderers\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*['"]Rendering configuration saved successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}\s*finally\s*\{\s*this\.saving\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-saverenderers['"]\s*\)\s*\}/
    )
    expect(source).toContain(":disabled='!renderersLoaded || renderersLoading || saving'")
    expect(save).not.toMatch(/this\.\$apollo\.mutate|renderersSaveMutation|rendering-mutation-save-renderers\.gql|\$store\.commit/)
    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
  })
})
