const { saveNavigation } = require('./navigation-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('navigation api helper', () => {
  test('saves navigation with same-origin JSON PUT options', async () => {
    const tree = [{ locale: 'en', items: [{ id: 'home', kind: 'link' }] }]
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Navigation saved successfully.' }))

    await expect(saveNavigation(fetchImpl, tree, 'MIXED')).resolves.toEqual({ message: 'Navigation saved successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/navigation', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tree, mode: 'MIXED' })
    })
  })

  test('rejects malformed navigation save success payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(saveNavigation(fetchImpl, [], 'TREE', 'Bad navigation save')).rejects.toThrow('Bad navigation save')
  })

  test('surfaces REST JSON error fields for failed navigation saves', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'navigation denied' }, false))

    await expect(saveNavigation(fetchImpl, [], 'TREE', 'Bad navigation save')).rejects.toThrow('navigation denied')
  })

  test('surfaces REST JSON message fields for failed navigation saves', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'navigation mode invalid' }, false))

    await expect(saveNavigation(fetchImpl, [], 'TREE', 'Bad navigation save')).rejects.toThrow('navigation mode invalid')
  })

  test('rejects non-JSON successful navigation save responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(saveNavigation(fetchImpl, [], 'TREE', 'Bad navigation save content type')).rejects.toThrow('Bad navigation save content type')
  })
})
