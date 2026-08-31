import { executeStorageAction, fetchStorageStatus, fetchStorageTargets, saveStorageTargets } from './storage-api.ts'

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: vi.fn().mockResolvedValue(payload)
  }
}

function storageTarget (overrides = {}) {
  return {
    actions: [{ handler: 'sync', hint: 'Synchronize now', label: 'Sync' }],
    config: [{ key: 'repoUrl', value: JSON.stringify({ type: 'String', value: 'https://example.com/wiki.git' }) }],
    description: 'Git storage',
    hasSchedule: true,
    isAvailable: true,
    isEnabled: true,
    key: 'git',
    logo: '/_assets/svg/mime-icon-32.svg',
    mode: 'sync',
    supportedModes: ['sync', 'push', 'pull'],
    syncInterval: 'PT5M',
    syncIntervalDefault: 'PT5M',
    title: 'Git',
    website: 'https://git-scm.com/',
    ...overrides
  }
}

function storageStatus (overrides = {}) {
  return {
    key: 'git',
    lastAttempt: '2026-08-21T00:00:00.000Z',
    lastOperation: null,
    message: 'Ready',
    status: 'operational',
    title: 'Git',
    ...overrides
  }
}

function storageActionSummary (overrides = {}) {
  return {
    targetKey: 'git',
    handler: 'sync',
    outcome: 'succeeded',
    total: 2,
    succeeded: 2,
    failed: 0,
    formats: {
      okf: 1,
      legacyV1: 0,
      legacyWiki: 1,
      plain: 0,
      invalid: 0
    },
    items: [{
      kind: 'page',
      path: 'guides/start.md',
      outcome: 'succeeded',
      format: 'legacyWiki',
      message: null,
      diagnostics: []
    }],
    startedAt: '2026-08-21T00:00:00.000Z',
    completedAt: '2026-08-21T00:00:01.000Z',
    message: 'Exported 2 pages.',
    ...overrides
  }
}

describe('storage api helper', () => {
  it('fetches storage targets with same-origin JSON headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([storageTarget()]))

    const result = await fetchStorageTargets(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/storage/targets', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
    expect(result).toEqual([storageTarget()])
  })

  it('normalizes omitted legacy capability fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      storageTarget({ supportedModes: undefined, syncIntervalDefault: undefined })
    ]))

    expect(await fetchStorageTargets(fetchImpl)).toEqual([
      storageTarget({ supportedModes: [], syncIntervalDefault: null })
    ])
  })

  it('rejects malformed successful targets responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ targets: [] }))

    await expect(Promise.resolve(fetchStorageTargets(fetchImpl, 'Unexpected targets response'))).rejects.toThrow('Unexpected targets response')
  })

  it('rejects malformed entries in successful targets responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([storageTarget({ supportedModes: 'sync' })]))

    await expect(Promise.resolve(fetchStorageTargets(fetchImpl, 'Unexpected targets response'))).rejects.toThrow('Unexpected targets response')
  })

  it('surfaces JSON REST target fetch errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'targets failed' }, false))

    await expect(Promise.resolve(fetchStorageTargets(fetchImpl))).rejects.toThrow('targets failed')
  })

  it('fetches storage status with same-origin JSON headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([storageStatus()]))

    const result = await fetchStorageStatus(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/storage/status', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
    expect(result).toEqual([storageStatus()])
  })

  it('exposes the last structured operation from status polling', async () => {
    const lastOperation = storageActionSummary()
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      storageStatus({ lastOperation })
    ]))

    expect(await fetchStorageStatus(fetchImpl)).toEqual([
      storageStatus({ lastOperation })
    ])
  })

  it('rejects malformed successful status responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ status: [] }))

    await expect(Promise.resolve(fetchStorageStatus(fetchImpl, 'Unexpected status response'))).rejects.toThrow('Unexpected status response')
  })

  it('rejects malformed entries in successful status responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([storageStatus({ lastAttempt: 123 })]))

    await expect(Promise.resolve(fetchStorageStatus(fetchImpl, 'Unexpected status response'))).rejects.toThrow('Unexpected status response')
  })

  it('surfaces JSON REST status errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'status failed' }, false))

    await expect(Promise.resolve(fetchStorageStatus(fetchImpl))).rejects.toThrow('status failed')
  })

  it('saves storage targets with same-origin JSON PUT', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Storage targets updated successfully', reload: true }))
    const targets = [{ key: 'git' }]

    const result = await saveStorageTargets(fetchImpl, targets)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/storage/targets', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ targets })
    })
    expect(result).toEqual({ message: 'Storage targets updated successfully', reload: true })
  })

  it('rejects malformed successful target save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({}))

    await expect(Promise.resolve(saveStorageTargets(fetchImpl, [], 'Unexpected save response'))).rejects.toThrow('Unexpected save response')
  })

  it('surfaces JSON REST target save errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'save failed' }, false))

    await expect(Promise.resolve(saveStorageTargets(fetchImpl, []))).rejects.toThrow('save failed')
  })

  it('uses truthy non-string JSON error values to preserve legacy error precedence', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 403 }, false))

    await expect(Promise.resolve(saveStorageTargets(fetchImpl, []))).rejects.toThrow('403')
  })

  it('executes a storage action and strictly normalizes its structured summary', async () => {
    const payload = storageActionSummary({
      startedAt: '2026-08-21T02:00:00.000+02:00',
      completedAt: '2026-08-21T02:00:01.000+02:00',
      ignored: 'server-only'
    })
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    const result = await executeStorageAction(fetchImpl, 'git', 'sync')

    expect(fetchImpl).toHaveBeenCalledWith('/_api/storage/actions/execute', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ targetKey: 'git', handler: 'sync' })
    })
    expect(result).toEqual(storageActionSummary())
    expect(result).not.toHaveProperty('ignored')
  })

  it('preserves partial outcomes and separate legacy format counts', async () => {
    const summary = storageActionSummary({
      outcome: 'partial',
      succeeded: 1,
      failed: 1,
      formats: {
        okf: 0,
        legacyV1: 1,
        legacyWiki: 0,
        plain: 0,
        invalid: 1
      },
      items: [{
        kind: 'page',
        path: 'broken.md',
        outcome: 'failed',
        format: 'invalid',
        message: 'Metadata could not be verified.',
        diagnostics: ['authority.signature is invalid']
      }],
      message: 'Imported 1 page; 1 page failed.'
    })
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(summary))

    expect(await executeStorageAction(fetchImpl, 'disk', 'importAll')).toEqual(summary)
  })

  it.each([
    ['missing summary fields', {}],
    ['unknown outcome', storageActionSummary({ outcome: 'complete' })],
    ['inconsistent totals', storageActionSummary({ total: 3 })],
    ['partial without both result classes', storageActionSummary({ outcome: 'partial' })],
    ['invalid format count', storageActionSummary({ formats: { okf: 2, legacyV1: 0, legacyWiki: 0, plain: 0, invalid: -1 } })],
    ['invalid timestamp', storageActionSummary({ completedAt: 'not-a-date' })],
    ['completion before start', storageActionSummary({ completedAt: '2026-08-20T23:59:59.000Z' })],
    ['unbounded items', storageActionSummary({ items: Array.from({ length: 51 }, (_, index) => ({
      kind: 'page',
      path: `page-${index}.md`,
      outcome: 'failed',
      format: 'invalid',
      message: 'Invalid',
      diagnostics: []
    })) })]
  ])('rejects malformed successful action responses: %s', async (_name, payload) => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(Promise.resolve(executeStorageAction(fetchImpl, 'git', 'sync', 'Unexpected action response'))).rejects.toThrow('Unexpected action response')
  })

  it('surfaces JSON REST action errors instead of treating them as summaries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid Handler for Storage Target' }, false))

    await expect(Promise.resolve(executeStorageAction(fetchImpl, 'git', 'missing'))).rejects.toThrow('Invalid Handler for Storage Target')
  })

  it('uses fallback message for non-JSON action failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: { get: () => 'text/plain' }
    })

    await expect(Promise.resolve(executeStorageAction(fetchImpl, 'git', 'sync', 'Action fallback'))).rejects.toThrow('Action fallback')
  })
})
