const { executeStorageAction, fetchStorageStatus, fetchStorageTargets, saveStorageTargets } = require('./storage-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: jest.fn().mockResolvedValue(payload)
  }
}

describe('storage api helper', () => {
  it('fetches storage targets with same-origin JSON headers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([{ key: 'git' }]))

    const result = await fetchStorageTargets(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/storage/targets', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
    expect(result).toEqual([{ key: 'git' }])
  })

  it('rejects malformed successful targets responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ targets: [] }))

    await expect(fetchStorageTargets(fetchImpl, 'Unexpected targets response')).rejects.toThrow('Unexpected targets response')
  })

  it('surfaces JSON REST target fetch errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'targets failed' }, false))

    await expect(fetchStorageTargets(fetchImpl)).rejects.toThrow('targets failed')
  })

  it('fetches storage status with same-origin JSON headers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([{ key: 'git', status: 'operational' }]))

    const result = await fetchStorageStatus(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/storage/status', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
    expect(result).toEqual([{ key: 'git', status: 'operational' }])
  })

  it('rejects malformed successful status responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ status: [] }))

    await expect(fetchStorageStatus(fetchImpl, 'Unexpected status response')).rejects.toThrow('Unexpected status response')
  })

  it('surfaces JSON REST status errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'status failed' }, false))

    await expect(fetchStorageStatus(fetchImpl)).rejects.toThrow('status failed')
  })

  it('saves storage targets with same-origin JSON PUT', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Storage targets updated successfully', reload: true }))
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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({}))

    await expect(saveStorageTargets(fetchImpl, [], 'Unexpected save response')).rejects.toThrow('Unexpected save response')
  })

  it('surfaces JSON REST target save errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'save failed' }, false))

    await expect(saveStorageTargets(fetchImpl, [])).rejects.toThrow('save failed')
  })

  it('uses truthy non-string JSON error values to preserve legacy error precedence', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 403 }, false))

    await expect(saveStorageTargets(fetchImpl, [])).rejects.toThrow('403')
  })

  it('executes a storage action with same-origin JSON POST', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Action completed.', job: 'sync' }))

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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(executeStorageAction(fetchImpl, 'git', 'sync')).resolves.toEqual({ message: '' })
  })

  it('rejects malformed successful action responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({}))

    await expect(executeStorageAction(fetchImpl, 'git', 'sync', 'Unexpected action response')).rejects.toThrow('Unexpected action response')
  })

  it('surfaces JSON REST action errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid Handler for Storage Target' }, false))

    await expect(executeStorageAction(fetchImpl, 'git', 'missing')).rejects.toThrow('Invalid Handler for Storage Target')
  })

  it('uses fallback message for non-JSON action failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: { get: () => 'text/plain' }
    })

    await expect(executeStorageAction(fetchImpl, 'git', 'sync', 'Action fallback')).rejects.toThrow('Action fallback')
  })
})
