import fs from 'node:fs'
import path from 'node:path'

const extractMethod = (script, name, indentation = 4) => {
  const prefix = ' '.repeat(indentation)
  const declaration = script.match(new RegExp(`^${prefix}(?:async\\s+)?${name}\\s*\\(`, 'm'))

  if (!declaration) {
    return null
  }

  const methodStart = declaration.index + prefix.length
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

const executeMethodBody = (method, context, dependencies = {}) => {
  const paramsStart = method.indexOf('(')
  let paramsDepth = 0
  let bodyStart = -1

  for (let idx = paramsStart; idx < method.length; idx++) {
    if (method[idx] === '(') {
      paramsDepth++
    } else if (method[idx] === ')') {
      paramsDepth--

      if (paramsDepth === 0) {
        bodyStart = method.indexOf('{', idx)
        break
      }
    }
  }

  const body = method.slice(bodyStart + 1, -1).replace(/\.reduce<unknown\[\]>/g, '.reduce')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

  return new AsyncFunction(...Object.keys(dependencies), body).call(context, ...Object.values(dependencies))
}

describe('admin-rendering root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-rendering.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const loadRenderers = script && extractMethod(script, 'loadRenderers')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const selectRenderer = script && extractMethod(script, 'selectRenderer')
  const beforeUnmount = script && extractMethod(script, 'beforeUnmount', 2)

  test('admin-rendering.vue uses typed helpers and exposes explicit loading and error states', () => {
    expect(script).not.toBeNull()
    expect(loadRenderers).not.toBeNull()
    expect(refresh).not.toBeNull()
    expect(save).not.toBeNull()
    expect(selectRenderer).not.toBeNull()
    expect(beforeUnmount).not.toBeNull()
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

  test('loadRenderers() rebuilds and directly selects the default renderer while balancing unmount-safe loading', () => {
    expect(loadRenderers).toMatch(/async\s+loadRenderers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)/)
    expect(loadRenderers).toMatch(
      /if\s*\(\s*this\.isDisposed\s*\)\s*return\s+false\s*this\.renderersLoading\s*=\s*true\s*this\.renderersLoadError\s*=\s*false\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-refresh['"]\s*\)/
    )
    expect(loadRenderers).toMatch(
      /const\s+flatRenderers\s*=\s*await\s+fetchRenderingRenderers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Rendering renderers response is invalid['"]\s*\)\s*if\s*\(\s*this\.isDisposed\s*\)\s*return\s+false/
    )
    expect(loadRenderers).toMatch(
      /this\.renderers\s*=\s*this\.buildRendererTree\s*\(\s*flatRenderers\s*\)\s*this\.selectedCore\s*=\s*_\.findIndex\s*\(\s*this\.renderers\s*,\s*\[\s*['"]key['"]\s*,\s*['"]markdownCore['"]\s*\]\s*\)\s*this\.currentRenderer\s*=\s*createEmptyRenderer\s*\(\s*\)\s*if\s*\(\s*this\.selectedCore\s*>=\s*0\s*\)\s*this\.selectRenderer\s*\(\s*['"]markdownCore['"]\s*\)\s*this\.renderersLoaded\s*=\s*true/
    )
    expect(loadRenderers).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*this\.isDisposed\s*\)\s*return\s+false\s*this\.renderers\s*=\s*\[\]\s*this\.selectedCore\s*=\s*-1\s*this\.currentRenderer\s*=\s*createEmptyRenderer\s*\(\s*\)\s*this\.renderersLoaded\s*=\s*false\s*this\.renderersLoadError\s*=\s*true/
    )
    expect(loadRenderers).toMatch(
      /if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*getErrorMessage\s*\(\s*err\s*\)\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err/
    )
    expect(loadRenderers).toMatch(
      /finally\s*\{\s*if\s*\(\s*!this\.isDisposed\s*\)\s*this\.renderersLoading\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-refresh['"]\s*\)\s*\}/
    )
    expect(loadRenderers).not.toMatch(/\$store\.commit/)
    expect(loadRenderers.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadRenderers.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadRenderers.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('a renderer load that settles after unmount cannot replace component state or notify', async () => {
    let resolveFetch
    const fetchRenderingRenderers = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve
        })
    )
    const loadingStart = jest.fn()
    const loadingStop = jest.fn()
    const showNotification = jest.fn()
    const existingRenderer = { key: 'existing' }
    const existingTree = [{ key: 'existingCore', children: [existingRenderer] }]
    const context = {
      renderers: existingTree,
      selectedCore: 0,
      currentRenderer: existingRenderer,
      renderersLoading: false,
      renderersLoadError: false,
      renderersLoaded: true,
      isDisposed: false,
      buildRendererTree: jest.fn(),
      selectRenderer: jest.fn()
    }
    const wikiStore = {}

    const pendingLoad = executeMethodBody(loadRenderers, context, {
      notifyError: true,
      loadingStart,
      wikiStore,
      fetchRenderingRenderers,
      window: { fetch: jest.fn() },
      _: {},
      createEmptyRenderer: jest.fn(),
      showNotification,
      getErrorMessage: err => err.message,
      loadingStop
    })

    expect(context.renderersLoading).toBe(true)
    await executeMethodBody(beforeUnmount, context)
    resolveFetch([{ key: 'staleCore', dependsOn: null }])

    await expect(pendingLoad).resolves.toBe(false)
    expect(context.renderers).toBe(existingTree)
    expect(context.currentRenderer).toBe(existingRenderer)
    expect(context.buildRendererTree).not.toHaveBeenCalled()
    expect(context.selectRenderer).not.toHaveBeenCalled()
    expect(showNotification).not.toHaveBeenCalled()
    expect(loadingStart).toHaveBeenCalledWith(wikiStore, 'admin-rendering-refresh')
    expect(loadingStop).toHaveBeenCalledWith(wikiStore, 'admin-rendering-refresh')
    expect(context.renderersLoading).toBe(true)
  })

  test('an active renderer load failure exposes error state, notifies once, and balances loading', async () => {
    const error = new Error('renderer fetch failed')
    const loadingStart = jest.fn()
    const loadingStop = jest.fn()
    const showNotification = jest.fn()
    const emptyRenderer = { key: '', isEnabled: false, config: [] }
    const context = {
      renderers: [{ key: 'stale' }],
      selectedCore: 2,
      currentRenderer: { key: 'stale' },
      renderersLoading: false,
      renderersLoadError: false,
      renderersLoaded: true,
      isDisposed: false,
      buildRendererTree: jest.fn(),
      selectRenderer: jest.fn()
    }
    const wikiStore = {}

    const failedLoad = executeMethodBody(loadRenderers, context, {
      notifyError: true,
      loadingStart,
      wikiStore,
      fetchRenderingRenderers: jest.fn().mockRejectedValue(error),
      window: { fetch: jest.fn() },
      _: {},
      createEmptyRenderer: () => emptyRenderer,
      showNotification,
      getErrorMessage: err => err.message,
      loadingStop
    })

    await expect(failedLoad).rejects.toBe(error)
    expect(context.renderers).toEqual([])
    expect(context.selectedCore).toBe(-1)
    expect(context.currentRenderer).toBe(emptyRenderer)
    expect(context.renderersLoaded).toBe(false)
    expect(context.renderersLoadError).toBe(true)
    expect(context.renderersLoading).toBe(false)
    expect(showNotification).toHaveBeenCalledWith(wikiStore, {
      message: 'renderer fetch failed',
      style: 'red',
      icon: 'alert'
    })
    expect(loadingStart).toHaveBeenCalledWith(wikiStore, 'admin-rendering-refresh')
    expect(loadingStop).toHaveBeenCalledWith(wikiStore, 'admin-rendering-refresh')
  })

  test('renderer selection stops after the first matching pipeline', async () => {
    const selected = { key: 'markdownCore' }
    const laterLookup = jest.fn(() => ({ key: 'markdownCore', title: 'duplicate' }))
    const context = {
      currentRenderer: { key: '' },
      renderers: [{ children: [selected] }, { children: { find: laterLookup } }]
    }

    await executeMethodBody(selectRenderer, context, { key: 'markdownCore' })
    expect(context.currentRenderer).toBe(selected)
    expect(laterLookup).not.toHaveBeenCalled()
  })

  test('refresh is mutually exclusive with loads and saves, and only notifies after a successful reload', () => {
    expect(refresh).toMatch(
      /if\s*\(\s*this\.renderersLoading\s*\|\|\s*this\.saving\s*\)\s*return\s*if\s*\(\s*!await\s+this\.loadRenderers\s*\(\s*\)\.catch\s*\(\s*\(\s*\)\s*=>\s*false\s*\)\s*\)\s*return/
    )
    expect(refresh).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*['"]Rendering active configuration has been reloaded\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/
    )
    expect(source).toContain(":disabled='renderersLoading || saving'")
    expect(refresh).not.toMatch(/\$store\.commit/)
    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save preserves the REST payload, silent reload, error reporting, and unmount-safe cleanup', () => {
    expect(save).toMatch(
      /if\s*\(\s*!this\.renderersLoaded\s*\|\|\s*this\.renderersLoading\s*\|\|\s*this\.saving\s*\)\s*return\s*this\.saving\s*=\s*true\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-saverenderers['"]\s*\)\s*try\s*\{\s*if\s*\(\s*this\.isDisposed\s*\)\s*return/
    )
    expect(save).toMatch(
      /await\s+saveRenderingRenderers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.renderers\.reduce<unknown\[\]>\s*\(\s*\(\s*result\s*,\s*core\s*\)\s*=>\s*\{\s*return\s+result\.concat\s*\(\s*core\.children\.map\s*\(\s*rd\s*=>\s*\(\s*\{/
    )
    expect(save).toMatch(
      /key:\s*rd\.key\s*,\s*isEnabled:\s*rd\.isEnabled\s*,\s*config:\s*rd\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*key:\s*cfg\.key\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(/\}\)\)\)\s*\}\s*,\s*\[\s*\]\s*\)\s*,\s*['"]Rendering renderers update failed['"]\s*\)/)
    expect(save).toMatch(
      /if\s*\(\s*!await\s+this\.loadRenderers\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*\)\s*return\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*['"]Rendering configuration saved successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*this\.isDisposed\s*\)\s*return\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}\s*finally\s*\{\s*if\s*\(\s*!this\.isDisposed\s*\)\s*this\.saving\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-rendering-saverenderers['"]\s*\)\s*\}/
    )
    expect(source).toContain(":disabled='!renderersLoaded || renderersLoading || saving'")
    expect(save).not.toMatch(/this\.\$apollo\.mutate|renderersSaveMutation|rendering-mutation-save-renderers\.gql|\$store\.commit/)
    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
  })

  test('a renderer save that settles after unmount balances global loading without stale UI effects', async () => {
    let resolveSave
    const saveRenderingRenderers = jest.fn(
      () =>
        new Promise(resolve => {
          resolveSave = resolve
        })
    )
    const loadingStart = jest.fn()
    const loadingStop = jest.fn()
    const showNotification = jest.fn()
    const pushGraphError = jest.fn()
    const context = {
      renderersLoaded: true,
      renderersLoading: false,
      saving: false,
      isDisposed: false,
      renderers: [
        {
          children: [
            {
              key: 'markdown',
              isEnabled: true,
              config: [{ key: 'lineBreaks', value: { value: false } }]
            }
          ]
        }
      ],
      loadRenderers: jest.fn(function () {
        return Promise.resolve(!this.isDisposed)
      })
    }
    const wikiStore = {}

    const pendingSave = executeMethodBody(save, context, {
      loadingStart,
      wikiStore,
      saveRenderingRenderers,
      window: { fetch: jest.fn() },
      showNotification,
      pushGraphError,
      loadingStop
    })

    expect(context.saving).toBe(true)
    expect(saveRenderingRenderers).toHaveBeenCalledTimes(1)
    expect(saveRenderingRenderers.mock.calls[0][1]).toEqual([
      {
        key: 'markdown',
        isEnabled: true,
        config: [{ key: 'lineBreaks', value: JSON.stringify({ v: false }) }]
      }
    ])
    expect(saveRenderingRenderers.mock.calls[0][2]).toBe('Rendering renderers update failed')

    await executeMethodBody(beforeUnmount, context)
    resolveSave()
    await expect(pendingSave).resolves.toBeUndefined()

    expect(context.loadRenderers).toHaveBeenCalledWith({ notifyError: false })
    expect(showNotification).not.toHaveBeenCalled()
    expect(pushGraphError).not.toHaveBeenCalled()
    expect(context.saving).toBe(true)
    expect(loadingStart).toHaveBeenCalledWith(wikiStore, 'admin-rendering-saverenderers')
    expect(loadingStop).toHaveBeenCalledWith(wikiStore, 'admin-rendering-saverenderers')
  })
})
