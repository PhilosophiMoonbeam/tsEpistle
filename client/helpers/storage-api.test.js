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
    message: 'Ready',
    status: 'operational',
    title: 'Git',
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

  it('executes a storage action with same-origin JSON POST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Action completed.', job: 'sync' }))

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
    expect(result).toEqual({ message: 'Action completed.', job: 'sync' })
  })

  it('accepts empty string action messages to preserve legacy message validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    expect(await executeStorageAction(fetchImpl, 'git', 'sync')).toEqual({ message: '' })
  })

  it('rejects malformed successful action responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({}))

    await expect(Promise.resolve(executeStorageAction(fetchImpl, 'git', 'sync', 'Unexpected action response'))).rejects.toThrow('Unexpected action response')
  })

  it('surfaces JSON REST action errors', async () => {
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
