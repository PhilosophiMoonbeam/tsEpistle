import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${name}\\s*\\(`))
  if (methodStart === -1) return null

  const openBrace = script.indexOf('{', methodStart)
  if (openBrace === -1) return null

  let depth = 0
  for (let idx = openBrace; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--
      if (depth === 0) return script.slice(methodStart, idx + 1)
    }
  }
  return null
}

const compileMethod = (method, parameters, dependencies, transform = value => value) => {
  const body = transform(method.slice(method.indexOf('{')))
  const asyncKeyword = /^\s*async\b/.test(method) ? 'async ' : ''
  return new Function(...Object.keys(dependencies), `return (${asyncKeyword}function (${parameters.join(', ')}) ${body})`)(...Object.values(dependencies))
}

const createTarget = () => ({
  key: 'archive',
  title: 'Archive',
  isEnabled: true,
  mode: 'push',
  syncInterval: 'PT15M',
  config: [
    {
      key: 'without-order',
      value: JSON.stringify({ type: 'string', value: 'last' })
    },
    {
      key: 'first',
      value: JSON.stringify({ type: 'string', value: 'first', order: 1 })
    }
  ]
})

describe('admin-storage REST loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-storage.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const normalizeTargetsSource = script && extractMethod(script, 'normalizeTargets')
  const storageTargetsPayloadSource = script && extractMethod(script, 'storageTargetsPayload')
  const loadTargetsSource = script && extractMethod(script, 'loadTargets')
  const saveSource = script && extractMethod(script, 'save')
  const windowStub = { fetch: () => {} }

  test('uses native cloning, sorting, and lookup while rendering every mutable row with a stable domain key', () => {
    expect(script).not.toBeNull()
    expect(normalizeTargetsSource).not.toBeNull()
    expect(storageTargetsPayloadSource).not.toBeNull()
    expect(loadTargetsSource).not.toBeNull()
    expect(saveSource).not.toBeNull()

    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+\{[^}]*\bsetLoading\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchStorageTargets\b)(?=[^}]*\bsaveStorageTargets\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/storage-api['"]/
    )
    expect(script).not.toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(normalizeTargetsSource).toContain('targets.map(target =>')
    expect(normalizeTargetsSource).toContain('.sort((left, right) =>')
    expect(script).toContain('this.targets.find(target => target.key === newValue)')

    expect(source).toContain("template(v-for='(tgt, idx) in targets', :key='tgt.key')")
    expect(source).toContain("template(v-for='(tgt, n) in status', :key='tgt.key')")
    expect(source).toContain("template(v-for='cfg in target.config', :key='cfg.key')")
    expect(source).toContain("v-col(cols='12', lg='6', xl='4', v-for='act of target.actions', :key='act.handler')")
    expect(source).not.toMatch(/(?:targets|status|target\.config|target\.actions)[^\n]*:key=['"](?:idx|n|index)['"]/)
  })

  test('normalizes editable target state without mutating or reusing the REST payload records', () => {
    const normalizeTargets = compileMethod(normalizeTargetsSource, ['targets'], {}, value => value.replace(/ as StorageConfigValue/g, ''))
    const sourceTarget = createTarget()
    const sourceTargets = [sourceTarget]
    const normalized = normalizeTargets(sourceTargets)

    expect(normalized).not.toBe(sourceTargets)
    expect(normalized[0]).not.toBe(sourceTarget)
    expect(normalized[0].config).not.toBe(sourceTarget.config)
    expect(normalized[0].config.map(config => config.key)).toEqual(['first', 'without-order'])
    expect(normalized[0].config[0]).not.toBe(sourceTarget.config[1])
    expect(normalized[0].config[0].value).toEqual({ type: 'string', value: 'first', order: 1 })
    expect(sourceTarget.config[0].value).toBe(JSON.stringify({ type: 'string', value: 'last' }))
    expect(sourceTarget.config[1].value).toBe(JSON.stringify({ type: 'string', value: 'first', order: 1 }))
  })

  test('builds a detached save payload without replacing or serializing the editable state in place', () => {
    const storageTargetsPayload = compileMethod(storageTargetsPayloadSource, [], {}, value =>
      value.replace(/\(config\):\s*StorageConfigEntry\s*=>/g, 'config =>')
    )
    const target = createTarget()
    target.config = target.config.map(config => ({ ...config, value: JSON.parse(config.value) }))
    const viewModel = { targets: [target] }
    const originalConfig = target.config[0]
    const originalValue = originalConfig.value

    const payload = storageTargetsPayload.call(viewModel)
    const secondPayload = storageTargetsPayload.call(viewModel)

    expect(payload).not.toBe(viewModel.targets)
    expect(payload[0]).not.toBe(target)
    expect(payload[0].config).not.toBe(target.config)
    expect(payload[0].config[0]).not.toBe(originalConfig)
    expect(payload[0].config[0].value).toBe(JSON.stringify({ v: 'last' }))
    expect(target.config[0]).toBe(originalConfig)
    expect(target.config[0].value).toBe(originalValue)
    expect(secondPayload).not.toBe(payload)
    expect(secondPayload[0]).not.toBe(payload[0])
    expect(secondPayload).toEqual(payload)
  })

  test('balances target refresh loading and preserves normalized response identity on success', async () => {
    const loadingEvents = []
    const errors = []
    const sourceTargets = [createTarget()]
    const normalizeTargets = compileMethod(normalizeTargetsSource, ['targets'], {}, value => value.replace(/ as StorageConfigValue/g, ''))
    const loadTargets = compileMethod(loadTargetsSource, [], {
      fetchStorageTargets: async () => sourceTargets,
      pushGraphError: (_store, error) => errors.push(error),
      setLoading: (_store, id, value) => loadingEvents.push([id, value]),
      wikiStore: {},
      window: windowStub
    })
    const viewModel = {
      normalizeTargets,
      targets: [],
      targetsLoading: false
    }

    expect(await loadTargets.call(viewModel)).toBe(true)
    expect(viewModel.targets).not.toBe(sourceTargets)
    expect(viewModel.targets[0]).not.toBe(sourceTargets[0])
    expect(viewModel.targets[0].key).toBe(sourceTargets[0].key)
    expect(viewModel.targetsLoading).toBe(false)
    expect(errors).toEqual([])
    expect(loadingEvents).toEqual([
      ['admin-storage-targets-refresh', true],
      ['admin-storage-targets-refresh', false]
    ])
  })

  test('releases target refresh and save loading after REST failures without publishing success', async () => {
    const failure = new Error('storage unavailable')
    const loadingEvents = []
    const errors = []
    const notifications = []
    const rootUiDependencies = {
      loadingStart: (_store, id) => loadingEvents.push(['start', id]),
      loadingStop: (_store, id) => loadingEvents.push(['stop', id]),
      pushGraphError: (_store, error) => errors.push(error),
      setLoading: (_store, id, value) => loadingEvents.push([value ? 'start' : 'stop', id]),
      showNotification: (_store, notification) => notifications.push(notification),
      wikiStore: {},
      window: windowStub
    }
    const loadTargets = compileMethod(loadTargetsSource, [], {
      ...rootUiDependencies,
      fetchStorageTargets: async () => {
        throw failure
      }
    })
    const save = compileMethod(saveSource, [], {
      ...rootUiDependencies,
      saveStorageTargets: async () => {
        throw failure
      }
    })
    const refreshViewModel = {
      normalizeTargets: value => value,
      targets: [],
      targetsLoading: false
    }
    const saveViewModel = {
      runningAction: false,
      saving: false,
      storageTargetsPayload: () => [{ key: 'archive' }],
      targetsLoading: false
    }

    expect(await loadTargets.call(refreshViewModel)).toBe(false)
    await save.call(saveViewModel)

    expect(refreshViewModel.targets).toEqual([])
    expect(refreshViewModel.targetsLoading).toBe(false)
    expect(saveViewModel.saving).toBe(false)
    expect(errors).toEqual([failure, failure])
    expect(notifications).toEqual([])
    expect(loadingEvents).toEqual([
      ['start', 'admin-storage-targets-refresh'],
      ['stop', 'admin-storage-targets-refresh'],
      ['start', 'admin-storage-savetargets'],
      ['stop', 'admin-storage-savetargets']
    ])
  })

  test('keeps Apollo and direct root-store loading paths removed', () => {
    expect(script).not.toContain('apollo:')
    expect(script).not.toContain('targetsQuery')
    expect(script).not.toContain('statusQuery')
    expect(script).not.toMatch(/\$store\.commit\(\s*`loading\$\{isLoading\s*\?\s*['"]Start['"]\s*:\s*['"]Stop['"]\}`\s*,/)
    expect(script).not.toMatch(/\$store\.commit\(\s*['"]loading(?:Start|Stop)['"]\s*,/)
  })
})
