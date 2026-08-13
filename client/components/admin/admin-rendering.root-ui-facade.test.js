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

  test('admin-rendering.vue uses typed store facades without changing renderer fetch flow', () => {
    expect(script).not.toBeNull()
    expect(loadRenderers).not.toBeNull()
    expect(refresh).not.toBeNull()
    expect(save).not.toBeNull()

    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchRenderingRenderers\b)(?=[^}]*\bsaveRenderingRenderers\b)(?=[^}]*\btype\s+Renderer\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/rendering-api['"]/)

    expect(loadRenderers).toMatch(/async\s+loadRenderers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)/)
    expect(loadRenderers).toMatch(/loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-refresh['"]\s*\)/)
    expect(loadRenderers).toMatch(/const\s+flatRenderers\s*=\s*await\s+fetchRenderingRenderers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Rendering renderers response is invalid['"]\s*\)/)
    expect(loadRenderers).toMatch(/this\.renderers\s*=\s*this\.buildRendererTree\s*\(\s*flatRenderers\s*\)/)
    expect(loadRenderers).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*getErrorMessage\s*\(\s*err\s*\)\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}/)
    expect(loadRenderers).toMatch(/finally\s*\{\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-refresh['"]\s*\)\s*\}/)
    expect(loadRenderers).not.toMatch(/\$store\.commit/)

    const loadingStartCalls = loadRenderers.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const showNotificationCalls = loadRenderers.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const loadingStopCalls = loadRenderers.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)
  })

  test('refresh waits for renderer reload before showing the success notification', () => {
    expect(refresh).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*await\s+this\.loadRenderers\s*\(\s*\)\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*['"]Rendering active configuration has been reloaded\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}/)
    expect(refresh).not.toMatch(/\$store\.commit/)

    const showNotificationCalls = refresh.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)
  })

  test('save preserves typed REST payload reduction, silent reload, notification, and cleanup', () => {
    expect(save).toMatch(/async\s+save\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-saverenderers['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?await\s+saveRenderingRenderers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,[\s\S]*?await\s+this\.loadRenderers\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*['"]Rendering configuration saved successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)[\s\S]*?\}\s*finally\s*\{\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-saverenderers['"]\s*\)\s*\}/)
    expect(save).not.toMatch(/this\.\$apollo\.mutate|renderersSaveMutation|rendering-mutation-save-renderers\.gql/)
    expect(save).toMatch(/this\.renderers\.reduce<unknown\[\]>\s*\(\s*\(\s*result\s*,\s*core\s*\)\s*=>\s*\{/)
    expect(save).toMatch(/return\s+result\.concat\s*\(\s*core\.children\.map\s*\(\s*rd\s*=>\s*\(\s*\{/)
    expect(save).toMatch(/key:\s*rd\.key\s*,\s*isEnabled:\s*rd\.isEnabled\s*,\s*config:\s*rd\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*key:\s*cfg\.key\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)/)
    expect(save).toMatch(/\}\)\)\)\s*\}\s*,\s*\[\s*\]\s*\)\s*,\s*['"]Rendering renderers update failed['"]\s*\)/)

    expect(save).not.toMatch(/\$store\.commit/)

    const loadingStartCalls = save.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const loadingStopCalls = save.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)

    const showNotificationCalls = save.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)
  })
})
