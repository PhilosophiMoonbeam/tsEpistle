import { fetchNavigation, saveNavigation } from './navigation-api.ts'

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
  test('fetches and validates navigation config and tree', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      config: { mode: 'MIXED', expandParent: false, extra: 'ignored' },
      tree: [
        {
          locale: 'en',
          items: [
            { id: 'home', kind: 'link', label: 'Home', icon: 'mdi-home', targetType: 'home', target: '/', visibilityMode: 'all', visibilityGroups: [1], ignored: true }
          ]
        }
      ]
    }))

    await expect(fetchNavigation(fetchImpl)).resolves.toEqual({
      config: { mode: 'MIXED', expandParent: false },
      tree: [
        {
          locale: 'en',
          items: [
            { id: 'home', kind: 'link', label: 'Home', icon: 'mdi-home', targetType: 'home', target: '/', visibilityMode: 'all', visibilityGroups: [1] }
          ]
        }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/navigation', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('defaults legacy navigation payloads to opening the current parent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      config: { mode: 'TREE' },
      tree: []
    }))

    await expect(fetchNavigation(fetchImpl)).resolves.toEqual({
      config: { mode: 'TREE', expandParent: true },
      tree: []
    })
  })

  test('rejects malformed parent expansion settings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      config: { mode: 'TREE', expandParent: 'yes' },
      tree: []
    }))

    await expect(fetchNavigation(fetchImpl, 'Bad expansion setting')).rejects.toThrow('Bad expansion setting')
  })

  test('rejects malformed navigation fetch payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ config: { mode: 'invalid' }, tree: [] }))

    await expect(fetchNavigation(fetchImpl, 'Bad navigation payload')).rejects.toThrow('Bad navigation payload')
  })

  test('surfaces REST JSON error fields for failed navigation fetches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'navigation denied' }, false))

    await expect(fetchNavigation(fetchImpl, 'Bad navigation fetch')).rejects.toThrow('navigation denied')
  })

  test('rejects non-JSON successful navigation fetch responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchNavigation(fetchImpl, 'Bad navigation content type')).rejects.toThrow('Bad navigation content type')
  })

  test('saves navigation with same-origin JSON PUT options', async () => {
    const tree = [{ locale: 'en', items: [{ id: 'home', kind: 'link' }] }]
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Navigation saved successfully.' }))

    await expect(saveNavigation(fetchImpl, tree, 'MIXED', true)).resolves.toEqual({ message: 'Navigation saved successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/navigation', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tree, mode: 'MIXED', expandParent: true })
    })
  })

  test('rejects malformed navigation save success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(saveNavigation(fetchImpl, [], 'TREE', true, 'Bad navigation save')).rejects.toThrow('Bad navigation save')
  })

  test('surfaces REST JSON error fields for failed navigation saves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'navigation denied' }, false))

    await expect(saveNavigation(fetchImpl, [], 'TREE', true, 'Bad navigation save')).rejects.toThrow('navigation denied')
  })

  test('surfaces REST JSON message fields for failed navigation saves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'navigation mode invalid' }, false))

    await expect(saveNavigation(fetchImpl, [], 'TREE', true, 'Bad navigation save')).rejects.toThrow('navigation mode invalid')
  })

  test('rejects non-JSON successful navigation save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(saveNavigation(fetchImpl, [], 'TREE', true, 'Bad navigation save content type')).rejects.toThrow('Bad navigation save content type')
  })
})
