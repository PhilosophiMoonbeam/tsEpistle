const { executeStorageAction } = require('./storage-api')

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
  it('executes a storage action with same-origin JSON POST', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Action completed.' }))

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
    expect(result).toEqual({ message: 'Action completed.' })
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
